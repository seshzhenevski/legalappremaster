# -*- coding: utf-8 -*-
"""
Слой логики: генерация досудебной претензии.

Собирает контекст письма из реквизитов должника, договора и суммы долга,
формирует три файла (претензия DOCX, претензия PDF с факсимиле, опись DOCX)
во временную папку и дописывает строку в реестр «ОТПРАВКИ ПРЕТЕНЗИЙ.xlsx».
Скачивание готовых файлов (копирование в выбранное пользователем место)
вынесено в export_claim_document, потому что sidecar живёт один запрос —
пути к временным файлам возвращаются интерфейсу и приходят обратно на шаге
скачивания.

Реестр лежит в общей сетевой папке, поэтому запись в него защищена от
одновременной работы нескольких пользователей: см. registry_lock (файловый
замок рядом с реестром) и _save_workbook_atomically (сохранение через
временный файл с атомарной заменой).

Ничего не знает об интерфейсе, кроме функции report_progress (как и
lawsuit_generator / document_sorter_service).
"""
from __future__ import annotations

import os
import re
import shutil
import tempfile
import time
from contextlib import contextmanager
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import List, Optional

from legal_tools.config import CLAIM_REGISTRY_FILENAME, CLAIM_REGISTRY_DEFAULT_FOLDER
from legal_tools.core.formatting import (
    parse_amount_cell, parse_contract_ref, parse_date_cell, sanitize_filename, fmt,
)
from legal_tools.generators.claim_text import format_claim_number
from legal_tools.generators.claim_docx import generate_claim_docx
from legal_tools.generators.claim_pdf import generate_claim_pdf
from legal_tools.generators.lawsuit_docx import generate_opis_docx

try:
    import openpyxl
    _XL = True
except Exception:
    _XL = False

BANNER = "=" * 50
_TEMP_SUBDIR = "trivio_claim"

# Файловый замок рядом с реестром: реестр лежит в общей сетевой папке, и без
# замка двое пользователей, нажавших «Сгенерировать» одновременно, получили бы
# один и тот же номер претензии и затёрли строку друг друга (openpyxl
# перезаписывает файл целиком).
_LOCK_SUFFIX = ".lock"
_LOCK_WAIT_SECONDS = 60.0     # сколько ждём, пока коллега допишет свою строку
_LOCK_STALE_SECONDS = 300.0   # после этого замок считаем брошенным (программа упала)
_LOCK_POLL_SECONDS = 0.3

# Повторы атомарной замены файла: закрывают миллисекундные пересечения с теми,
# кто в этот момент читает реестр (см. _save_workbook_atomically).
_REPLACE_ATTEMPTS = 5
_REPLACE_RETRY_SECONDS = 0.2


def _lock_stamp() -> str:
    """Строка-визитка, которая пишется внутрь замка (кто и когда его взял)."""
    user = os.environ.get("USERNAME") or "неизвестный пользователь"
    host = os.environ.get("COMPUTERNAME") or "неизвестный компьютер"
    return f"{user}@{host} pid={os.getpid()} {datetime.now():%d.%m.%Y %H:%M:%S}"


def _lock_owner(lock_path: Path) -> str:
    """Читает визитку из замка — чтобы показать, кто держит реестр."""
    try:
        owner = lock_path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""
    return owner


def _lock_is_stale(lock_path: Path) -> bool:
    """
    Проверяет, не брошен ли замок.

    Если программа упала или потеряла сеть, файл замка останется навсегда и
    заблокирует всех. Поэтому замок старше _LOCK_STALE_SECONDS считается
    брошенным и снимается: наш критический участок занимает считаные секунды,
    так что живой замок такого возраста быть не может.
    """
    try:
        age = time.time() - lock_path.stat().st_mtime
    except OSError:
        return False
    return age > _LOCK_STALE_SECONDS


def _release_lock(lock_path: Path) -> None:
    """Снимает замок, молча переживая его отсутствие."""
    try:
        lock_path.unlink()
    except OSError:
        pass


@contextmanager
def registry_lock(registry_path: Path, wait_seconds: float = _LOCK_WAIT_SECONDS):
    """
    Захватывает файловый замок рядом с реестром на время его чтения и записи.

    Замок — это файл «<реестр>.lock», создаваемый атомарно (O_CREAT|O_EXCL):
    на сетевой папке SMB такое создание атомарно, поэтому его выигрывает ровно
    один пользователь. Остальные ждут освобождения до wait_seconds, после чего
    получают понятную ошибку с именем того, кто держит реестр. Брошенный замок
    (см. _lock_is_stale) снимается автоматически.

    Замком накрывается весь участок «узнать номер → сформировать документы →
    дописать строку», иначе двое могли бы получить один номер.
    """
    lock_path = registry_path.with_name(registry_path.name + _LOCK_SUFFIX)
    deadline = time.monotonic() + wait_seconds

    while True:
        try:
            handle = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            if _lock_is_stale(lock_path):
                _release_lock(lock_path)
                continue
            if time.monotonic() >= deadline:
                owner = _lock_owner(lock_path)
                raise TimeoutError(
                    "Реестр претензий сейчас занят другим пользователем — "
                    "он формирует свою претензию.\n"
                    + (f"Занял: {owner}\n\n" if owner else "\n")
                    + "Подождите несколько секунд и повторите."
                )
            time.sleep(_LOCK_POLL_SECONDS)
        except OSError as error:
            raise OSError(
                "Не удалось обратиться к папке с реестром претензий:\n"
                f"{registry_path.parent}\n\n"
                "Проверьте доступ к сетевой папке.\n"
                f"({error})"
            )

    try:
        os.write(handle, _lock_stamp().encode("utf-8"))
    finally:
        os.close(handle)

    try:
        yield
    finally:
        _release_lock(lock_path)


def _save_workbook_atomically(workbook, registry_path: Path) -> None:
    """
    Сохраняет книгу через временный файл с атомарной заменой.

    openpyxl перезаписывает файл целиком, поэтому обрыв сети посреди сохранения
    мог бы оставить реестр обрезанным или битым. Пишем во временный файл в той
    же папке (та же файловая система) и подменяем им оригинал одной операцией
    os.replace: читатели увидят либо старый файл, либо новый, но никогда —
    наполовину записанный.

    Замену повторяем несколько раз: на Windows она падает, если файл в этот
    момент открыт кем-то ещё, а реестр постоянно читают (вкладка иска ищет по
    ИНН при каждом вводе). Такие пересечения длятся миллисекунды, поэтому пара
    повторов их полностью закрывает; если файл держат по-настоящему (открыт в
    Excel), сообщаем об этом понятным текстом.
    """
    temp_path = registry_path.with_name(f"~{registry_path.stem}.tmp{registry_path.suffix}")
    try:
        workbook.save(temp_path)
        for attempt in range(_REPLACE_ATTEMPTS):
            try:
                os.replace(temp_path, registry_path)
                return
            except PermissionError:
                if attempt == _REPLACE_ATTEMPTS - 1:
                    raise PermissionError(_locked_message(registry_path.name))
                time.sleep(_REPLACE_RETRY_SECONDS)
    finally:
        # После успешной замены временного файла уже нет; после ошибки — убираем.
        try:
            temp_path.unlink()
        except OSError:
            pass


def parse_iso_date(iso_date_string: Optional[str]) -> Optional[date]:
    """
    Преобразует строку ISO (ГГГГ-ММ-ДД) в date. Пустое значение → None.

    Фронтенд передаёт даты полей в ISO-формате (скрытый инпут календаря);
    пустая строка означает «дата не задана».
    """
    text = (iso_date_string or "").strip()
    if not text:
        return None
    year, month, day = (int(part) for part in text.split("-"))
    return date(year, month, day)


def resolve_registry_path(registry_folder: Optional[str] = None) -> Path:
    """
    Находит файл реестра «ОТПРАВКИ ПРЕТЕНЗИЙ.xlsx» по указанному пути.

    Принимает путь к папке (обычный случай) либо прямой путь к самому
    xlsx-файлу. Если путь не задан — берёт папку по умолчанию из конфига
    (общая сетевая папка юридического департамента). Возвращает путь к
    существующему файлу или бросает понятную ошибку, если файл не найден
    (в том числе когда сетевая папка недоступна).
    """
    raw = (registry_folder or "").strip() or CLAIM_REGISTRY_DEFAULT_FOLDER
    candidate = Path(raw)
    if candidate.is_file():
        return candidate
    registry_path = candidate / CLAIM_REGISTRY_FILENAME
    if not registry_path.exists():
        raise FileNotFoundError(
            f"В папке не найден файл «{CLAIM_REGISTRY_FILENAME}»:\n{raw}"
        )
    return registry_path


def _require_openpyxl() -> None:
    if not _XL:
        raise RuntimeError(
            "Библиотека openpyxl не установлена.\n\nВыполните: pip install openpyxl"
        )


def summarize_invoices_excel(excel_path: str) -> dict:
    """
    Считает итоги из загруженного Excel со списком счетов.

    Формат совпадает с реестром для иска: столбец 3 — договор «номер от дата»,
    столбец 4 — сумма. Суммирует все распознанные суммы столбца 4 и берёт
    реквизиты договора из первой непустой ячейки столбца 3. Возвращает словарь
    с общей суммой (строкой), номером договора и датой договора в ISO — готово
    для подстановки в поля формы.
    """
    _require_openpyxl()
    workbook = openpyxl.load_workbook(excel_path, data_only=True)
    worksheet = workbook.active

    total = Decimal("0")
    counted = 0
    contract_number = ""
    contract_date_iso = ""
    for row in worksheet.iter_rows(min_row=2, values_only=True):
        cells = (list(row) + [None] * 4)[:4]
        contract_cell, amount_cell = cells[2], cells[3]
        amount = parse_amount_cell(amount_cell)
        if amount is not None:
            total += amount
            counted += 1
        if not contract_number and contract_cell not in (None, ""):
            _full, number, date_text = parse_contract_ref(str(contract_cell))
            contract_number = number
            contract_date_iso = _contract_date_to_iso(date_text)

    if counted == 0:
        raise ValueError(
            "В выбранном файле не найдено ни одной суммы в столбце 4."
        )

    return {
        "total": fmt(total),
        "total_raw": str(total),
        "counted": counted,
        "contract_number": contract_number,
        "contract_date": contract_date_iso,
    }


def _contract_date_to_iso(date_text: str) -> str:
    """«27.06.2023» → «2023-06-27». Пустая/нераспознанная строка → «»."""
    text = (date_text or "").strip()
    match = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$", text)
    if not match:
        return ""
    day, month, year = (int(part) for part in match.groups())
    if year < 100:
        year += 2000
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return ""


def _iter_data_rows(worksheet):
    """Отдаёт (индекс_строки, значения) по строкам данных (со 2-й)."""
    for index, row in enumerate(worksheet.iter_rows(min_row=2, values_only=True), start=2):
        yield index, row


def peek_next_claim_number(registry_path: Path) -> int:
    """
    Определяет следующий порядковый номер претензии по реестру.

    Берёт число из ПОСЛЕДНЕЙ заполненной строки столбца 3 и прибавляет 1
    (нумерация в файле периодически сбрасывается, поэтому именно последняя
    строка, а не глобальный максимум). Если подходящих строк нет — 1.
    """
    _require_openpyxl()
    workbook = openpyxl.load_workbook(registry_path, data_only=True)
    worksheet = workbook.active
    last_number = 0
    for _index, row in _iter_data_rows(worksheet):
        cell = row[2] if len(row) > 2 else None
        if cell in (None, ""):
            continue
        match = re.search(r"\d+", str(cell))
        if match:
            last_number = int(match.group())
    return last_number + 1


# Дата внутри «старого» формата столбца 3: «№55 от 15.04.2026».
_DATE_IN_NUMBER_RE = re.compile(r"от\s+(\d{1,2}\.\d{1,2}\.\d{2,4})", re.IGNORECASE)


def _cell_digits(cell) -> str:
    """Оставляет от значения ячейки только цифры (ИНН может лежать и числом)."""
    if cell is None:
        return ""
    if isinstance(cell, float) and cell.is_integer():
        cell = int(cell)
    return re.sub(r"\D", "", str(cell))


def _registry_number(number_cell) -> str:
    """
    Достаёт номер претензии из столбца 3 в любом из встречающихся форматов.

    В файле исторически лежат разные варианты: число (60), «№55 от 15.04.2026»
    и новый «№57». Во всех случаях возвращает голый номер («60», «55», «57»).
    """
    if number_cell in (None, ""):
        return ""
    match = re.search(r"\d+", str(number_cell))
    return match.group() if match else ""


def _registry_date_iso(date_cell, number_cell) -> str:
    """
    Достаёт дату претензии в ISO из столбца 4, а если он пуст — из столбца 3.

    В новых строках дата лежит в столбце 4, в старых — зашита в текст номера
    («№55 от 15.04.2026»). Возвращает «» , если дату распознать не удалось.
    """
    parsed = parse_date_cell(date_cell)
    if parsed is not None:
        return parsed.isoformat()
    if number_cell not in (None, ""):
        match = _DATE_IN_NUMBER_RE.search(str(number_cell))
        if match:
            parsed = parse_date_cell(match.group(1))
            if parsed is not None:
                return parsed.isoformat()
    return ""


def find_claim_by_inn(inn: str, registry_folder: Optional[str] = None) -> Optional[dict]:
    """
    Ищет в реестре последнюю претензию должника по ИНН.

    Сравнивает ИНН со столбцом 2 реестра (по цифрам, чтобы не зависеть от того,
    записан он текстом или числом) и возвращает номер и дату (ISO) ПОСЛЕДНЕЙ
    подходящей строки — именно эта претензия предшествует иску. Возвращает None,
    если строк с таким ИНН нет.

    Внимание: в исторических строках столбец ИНН не заполнялся, поэтому находятся
    только те претензии, у которых ИНН проставлен (сформированные программой либо
    заполненные вручную).
    """
    digits = _cell_digits(inn)
    if not digits:
        return None

    _require_openpyxl()
    registry_path = resolve_registry_path(registry_folder)
    workbook = openpyxl.load_workbook(registry_path, data_only=True)
    worksheet = workbook.active

    found: Optional[dict] = None
    for _index, row in _iter_data_rows(worksheet):
        inn_cell = row[1] if len(row) > 1 else None
        if _cell_digits(inn_cell) != digits:
            continue
        number_cell = row[2] if len(row) > 2 else None
        date_cell = row[3] if len(row) > 3 else None
        found = {
            "number": _registry_number(number_cell),
            "date": _registry_date_iso(date_cell, number_cell),
        }
    return found


def append_registry_row(
    registry_path: Path, *, name: str, inn: str, number_cell: str,
    claim_date: date, amount: Decimal,
) -> int:
    """
    Дописывает строку по претензии в первую пустую строку реестра.

    Столбцы: 1 — наименование должника, 2 — ИНН, 3 — номер претензии,
    4 — дата претензии (ДД.ММ.ГГГГ), 5 — сумма долга (число). Столбец 6
    (идентификатор отправления) не трогается. Возвращает индекс строки.
    Бросает понятную ошибку, если файл открыт в Excel.

    Вызывается под registry_lock (см. generate_claim_package) и сохраняет файл
    атомарно — поэтому строки пользователей не затирают друг друга.
    """
    _require_openpyxl()
    try:
        workbook = openpyxl.load_workbook(registry_path)
    except PermissionError:
        raise PermissionError(_locked_message(registry_path.name))
    worksheet = workbook.active

    last_data_row = 1
    for index, row in _iter_data_rows(worksheet):
        if any(value not in (None, "") for value in row[:5]):
            last_data_row = index
    target_row = last_data_row + 1

    worksheet.cell(row=target_row, column=1, value=name)
    worksheet.cell(row=target_row, column=2, value=inn or None)
    worksheet.cell(row=target_row, column=3, value=number_cell)
    worksheet.cell(row=target_row, column=4, value=claim_date.strftime("%d.%m.%Y"))
    worksheet.cell(row=target_row, column=5, value=float(amount))

    _save_workbook_atomically(workbook, registry_path)
    return target_row


def _locked_message(filename: str) -> str:
    return (
        f"Не удалось записать в файл:\n{filename}\n\n"
        "Скорее всего, он открыт в Excel. Закройте файл и повторите."
    )


def _prepare_temp_dir() -> Path:
    """Создаёт (пересоздаёт) временную папку для файлов текущей претензии."""
    temp_dir = Path(tempfile.gettempdir()) / _TEMP_SUBDIR
    if temp_dir.exists():
        shutil.rmtree(temp_dir, ignore_errors=True)
    temp_dir.mkdir(parents=True, exist_ok=True)
    return temp_dir


def generate_claim_package(request: dict, report_progress=None) -> dict:
    """
    Генерирует комплект по досудебной претензии и дописывает реестр.

    Принимает запрос (реквизиты должника, номер/дата претензии, номер/дата
    договора, сумма долга, папка с реестром) и необязательную функцию
    report_progress. Создаёт претензию DOCX и PDF (с факсимиле) и опись во
    временной папке, затем дописывает строку в «ОТПРАВКИ ПРЕТЕНЗИЙ.xlsx».
    Возвращает пути к временным файлам и сводку для интерфейса; сами файлы
    пользователь скачивает через export_claim_document.
    """
    if report_progress is None:
        report_progress = lambda message, percent=None: None

    defendant = request.get("defendant", {})
    name = (defendant.get("name") or "").strip()
    if not name:
        raise ValueError("Укажите наименование должника.")

    claim_date = parse_iso_date(request.get("claim_date")) or date.today()
    debt_amount = parse_amount_cell(request.get("debt_amount"))
    if debt_amount is None or debt_amount <= 0:
        raise ValueError("Укажите сумму долга больше нуля (или загрузите Excel со счетами).")

    contract_number = (request.get("contract_number") or "").strip()
    contract_date = parse_iso_date(request.get("contract_date"))
    registry_path = resolve_registry_path(request.get("registry_folder"))

    report_progress(BANNER)
    report_progress("▶ ФОРМИРОВАНИЕ ДОСУДЕБНОЙ ПРЕТЕНЗИИ")
    report_progress(BANNER)
    report_progress("")

    report_progress(f"Должник: {name}")
    report_progress(f"Сумма долга: {fmt(debt_amount)} руб.")
    if contract_number:
        report_progress(f"Договор: № {contract_number}"
                        + (f" от {contract_date:%d.%m.%Y}" if contract_date else ""))
    report_progress("")

    # Весь участок «узнать номер → сформировать документы → дописать строку»
    # идёт под одним замком. Если разжать замок между получением номера и
    # записью, двое пользователей успеют взять один и тот же номер и затрут
    # строки друг друга: реестр лежит в общей сетевой папке. Документы делаются
    # внутри замка (это пара секунд), зато номер в письме гарантированно тот же,
    # что уехал в реестр, а при сбое генерации в реестре не остаётся пустышки.
    report_progress("🔒 Ожидание доступа к реестру...", percent=5)
    with registry_lock(registry_path):
        claim_number = _resolve_claim_number(request, registry_path, report_progress)

        context = {
            "defendant_name": name,
            "defendant_address": (defendant.get("address") or "").strip(),
            "claim_number": claim_number,
            "claim_date": claim_date,
            "contract_number": contract_number,
            "contract_date": contract_date,
            "debt_amount": debt_amount,
        }
        files = _generate_documents(context, name, report_progress)

        report_progress("🧾 Запись в реестр «ОТПРАВКИ ПРЕТЕНЗИЙ.xlsx»...", percent=92)
        row_index = append_registry_row(
            registry_path, name=name, inn=(defendant.get("inn") or "").strip(),
            number_cell=f"№{claim_number}", claim_date=claim_date, amount=debt_amount,
        )
        report_progress(f"✓ Строка {row_index}: № {claim_number}, {claim_date:%d.%m.%Y}, "
                        f"{fmt(debt_amount)} руб.")
        report_progress("")

    report_progress(BANNER, percent=100)
    report_progress("✅ ГОТОВО — можно скачивать DOCX или PDF")
    report_progress(BANNER)

    return {
        **files,
        "claim_number": claim_number,
        "claim_date": claim_date.strftime("%d.%m.%Y"),
        "total_debt": fmt(debt_amount),
        "registry_row": row_index,
    }


def _resolve_claim_number(request: dict, registry_path: Path, report_progress) -> str:
    """
    Определяет номер претензии: введённый вручную либо следующий по реестру.

    Вызывается под registry_lock, поэтому автоматический номер не может
    достаться одновременно двум пользователям.
    """
    manual_number = format_claim_number(request.get("claim_number", ""))
    if manual_number:
        report_progress(f"📌 Номер претензии (введён вручную): № {manual_number}", percent=10)
        return manual_number

    next_number = str(peek_next_claim_number(registry_path))
    report_progress(
        f"📌 Номер претензии сформирован автоматически: № {next_number}", percent=10,
    )
    return next_number


def _generate_documents(context: dict, name: str, report_progress) -> dict:
    """
    Формирует три файла претензии во временной папке.

    Возвращает пути к претензии (DOCX и PDF с факсимиле) и описи, а также
    безопасное имя должника — оно нужно для имён файлов при скачивании.
    """
    temp_dir = _prepare_temp_dir()
    safe_name = sanitize_filename(name, "Должник")
    docx_path = temp_dir / f"Досудебная претензия ({safe_name}).docx"
    pdf_path = temp_dir / f"Досудебная претензия ({safe_name}).pdf"
    opis_path = temp_dir / f"Опись ({safe_name}).docx"

    report_progress("📄 Формирование претензии (DOCX)...", percent=35)
    generate_claim_docx(str(docx_path), context)
    report_progress(f"✓ {docx_path.name}")

    report_progress("🖊 Формирование претензии (PDF с факсимиле)...", percent=60)
    generate_claim_pdf(str(pdf_path), context, with_facsimile=True)
    report_progress(f"✓ {pdf_path.name}")

    report_progress("📋 Формирование описи почтового вложения...", percent=80)
    generate_opis_docx(str(opis_path), name, document_title="Досудебная претензия")
    report_progress(f"✓ {opis_path.name}")
    report_progress("")

    return {
        "docx_path": str(docx_path),
        "pdf_path": str(pdf_path),
        "opis_path": str(opis_path),
        "safe_name": safe_name,
    }


def export_claim_document(params: dict) -> dict:
    """
    Копирует готовый документ претензии в выбранное пользователем место.

    Принимает путь к временному файлу претензии (source_path), путь
    сохранения (target_path), путь к временной описи (opis_path) и
    безопасное имя должника (safe_name). Кладёт претензию по target_path, а
    опись — рядом (в ту же папку, всегда в .docx). Возвращает список
    сохранённых файлов. Понятно сообщает, если файл занят.
    """
    source_path = Path(params["source_path"])
    target_path = Path(params["target_path"])
    safe_name = params.get("safe_name") or "Должник"

    saved: List[str] = []
    try:
        shutil.copyfile(source_path, target_path)
        saved.append(str(target_path))
        opis_source = params.get("opis_path")
        if opis_source and Path(opis_source).exists():
            opis_target = target_path.parent / f"Опись ({safe_name}).docx"
            shutil.copyfile(opis_source, opis_target)
            saved.append(str(opis_target))
    except PermissionError:
        raise PermissionError(_locked_message(target_path.name))
    return {"saved": saved}
