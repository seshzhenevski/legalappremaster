# -*- coding: utf-8 -*-
"""
Слой логики: генерация пакета документов по иску.

Оркеструет чтение Excel-реестра, расчёт сумм и генерацию трёх файлов
(исковое заявление, опись, платёжное поручение). Возвращает список путей
к созданным файлам. Ничего не знает об интерфейсе, кроме функции
report_progress, через которую транслирует пошаговый ход работы (тот же
принцип, что и в document_sorter_service, — вызывающая сторона решает,
что делать с текстом прогресса).
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import List, Optional

from legal_tools.importers.excel import read_excel, group_invoices, compute_lawsuit
from legal_tools.importers.document_sorter import DocumentSorter
from legal_tools.generators.lawsuit_docx import generate_lawsuit_docx, generate_opis_docx
from legal_tools.generators.payment_pdf import generate_payment_order
from legal_tools.core.formatting import sanitize_filename, fmt

BANNER = "=" * 50


def parse_iso_date(iso_date_string: str) -> date:
    """
    Преобразует строку даты формата ГГГГ-ММ-ДД в объект date.

    Фронтенд передаёт даты в ISO-формате, эта функция превращает их
    в питоновский date для расчётов и генерации документов.
    """
    year, month, day = (int(part) for part in iso_date_string.split("-"))
    return date(year, month, day)


def parse_optional_decimal(value: Optional[str]) -> Optional[Decimal]:
    """
    Преобразует необязательную строку в Decimal.

    Возвращает None, если значение пустое или не задано. Используется
    для необязательного поля «ограничение неустойки в процентах».
    """
    if value is None or str(value).strip() == "":
        return None
    return Decimal(str(value))


def build_lawsuit_context(
    request: dict,
    excel_rows: list,
) -> dict:
    """
    Строит контекст расчёта иска из данных запроса и строк Excel.

    Группирует счета с FIFO-распределением возвратов и вызывает расчёт.
    Возвращает контекст с суммами и данными для генерации документов.
    """
    claim_date = parse_iso_date(request["claim_date"])
    invoices, contract_ref, warnings = group_invoices(excel_rows, claim_date)

    context = compute_lawsuit(
        defendant=request["defendant"],
        invoices=invoices,
        contract_ref=contract_ref,
        rate=Decimal(str(request["daily_rate_percent"])),
        rate_text=str(request["daily_rate_percent"]),
        cap_pct=parse_optional_decimal(request.get("cap_percent")),
        claim_date=claim_date,
        pretenzia_number=request["pretenzia_number"],
        pretenzia_date=parse_iso_date(request["pretenzia_date"]),
        postal_costs=Decimal(str(request.get("postal_costs", "0"))),
        docs_signed=request.get("docs_signed", True),
    )
    context["_warnings"] = warnings
    return context


def generate_lawsuit_package(request: dict, report_progress=None) -> dict:
    """
    Генерирует полный пакет документов по иску.

    Принимает запрос с реквизитами ответчика, путём к Excel-реестру,
    параметрами расчёта и папкой вывода, а также необязательную функцию
    report_progress для трансляции хода работы в реальном времени (по
    умолчанию — заглушка; используется в тестах, вызывающих функцию
    напрямую). Создаёт исковое заявление, опись, платёжное поручение и
    (если указаны папка с закрывающими документами и текст описания
    счетов) подтверждающие PDF-приложения. Возвращает список путей к
    созданным файлам и итоговые суммы.
    """
    if report_progress is None:
        report_progress = lambda message, percent=None: None

    report_progress(BANNER)
    report_progress("▶ ФОРМИРОВАНИЕ ПАКЕТА ДОКУМЕНТОВ ПО ИСКУ")
    report_progress(BANNER)
    report_progress("")

    report_progress("📊 Чтение Excel-реестра счетов...", percent=5)
    excel_rows = read_excel(request["excel_path"])
    report_progress(f"Найдено строк: {len(excel_rows)}")
    report_progress("")

    daily_rate_percent = request["daily_rate_percent"]
    claim_date = parse_iso_date(request["claim_date"])
    report_progress(
        f"🧮 Расчёт неустойки по {len(excel_rows)} счетам "
        f"(ставка {daily_rate_percent}% в день, на {claim_date:%d.%m.%Y})...",
        percent=20,
    )
    context = build_lawsuit_context(request, excel_rows)
    report_progress(f"Учтено счетов: {len(context['blocks'])}")
    report_progress(f"Сумма долга: {fmt(context['total_debt'])} руб.")
    report_progress(f"Неустойка: {fmt(context['total_penalty'])} руб.")
    report_progress(f"Цена иска: {fmt(context['claim_amount'])} руб.")
    report_progress(f"Госпошлина: {fmt(context['duty_amount'])} руб.")
    for warning in context.get("_warnings", []):
        report_progress(f"⚠ {warning}")
    report_progress("")

    output_directory = Path(request["output_dir"])
    defendant_name = request["defendant"]["name"]
    safe_name = sanitize_filename(defendant_name, "Ответчик")
    created_files: List[str] = []

    invoice_description_text = request.get("invoice_description_text")
    closing_documents_folder = request.get("closing_documents_folder")
    if invoice_description_text and closing_documents_folder:
        report_progress(
            "📂 Поиск и сборка подтверждающих документов (приложения к иску)...",
            percent=30,
        )
        supporting_files = find_and_attach_supporting_documents(
            closing_documents_folder, output_directory, invoice_description_text,
            report_progress,
        )
        created_files.extend(supporting_files)
        report_progress(f"Создано пакетов приложений: {len(supporting_files)}")
        report_progress("")

    report_progress("💳 Формирование платёжного поручения на госпошлину...", percent=80)
    duty_path = output_directory / f"Госпошлина ({safe_name}) от {claim_date:%d.%m.%Y}.pdf"
    write_single_document(
        lambda: generate_payment_order(
            path=str(duty_path),
            duty_amount=float(context["duty_amount"]),
            defendant_name=defendant_name,
            claim_amount=float(context["claim_amount"]),
            payment_date=claim_date,
        ),
        duty_path,
    )
    created_files.append(str(duty_path))
    report_progress(f"✓ {duty_path.name}")
    report_progress("")

    report_progress("📄 Формирование искового заявления...", percent=90)
    lawsuit_path = output_directory / f"Исковое заявление ({safe_name}).docx"
    write_single_document(
        lambda: generate_lawsuit_docx(str(lawsuit_path), context),
        lawsuit_path,
    )
    created_files.append(str(lawsuit_path))
    report_progress(f"✓ {lawsuit_path.name}")
    report_progress("")

    report_progress("📋 Формирование описи почтового вложения...", percent=95)
    opis_path = output_directory / f"Опись ({safe_name}).docx"
    write_single_document(
        lambda: generate_opis_docx(str(opis_path), defendant_name),
        opis_path,
    )
    created_files.append(str(opis_path))
    report_progress(f"✓ {opis_path.name}")
    report_progress("")

    report_progress(BANNER, percent=100)
    report_progress("✅ ГОТОВО")
    report_progress(BANNER)
    report_progress("")
    report_progress(
        "💡 Рекомендация: перед подачей иска сверьте номера пунктов договора, "
        "упоминаемые в исковом заявлении, с фактическими пунктами вашего "
        "экземпляра договора — нумерация может отличаться в зависимости от "
        "редакции."
    )

    return {
        "created_files": created_files,
        "total_debt": fmt(context["total_debt"]),
        "total_penalty": fmt(context["total_penalty"]),
    }


def find_and_attach_supporting_documents(
    closing_documents_folder: str,
    output_directory: Path,
    invoice_description_text: str,
    report_progress,
) -> List[str]:
    """
    Находит и собирает подтверждающие PDF-документы (Счёт + Акт + УПД).

    Принимает папку с закрывающими документами, папку вывода, текст с
    описанием счетов из 1С и функцию report_progress. Использует тот же
    класс DocumentSorter, что и вкладка «Сортировщик документов», — его
    собственный лог транслируется через report_progress построчно, в
    реальном времени. Возвращает пути к созданным пакетам.
    """
    sorter = DocumentSorter(
        source_folder=closing_documents_folder,
        output_folder=str(output_directory),
        log_callback=lambda text, tag=None: report_progress(text),
    )
    invoices = sorter.parse_invoice_info(invoice_description_text)
    report_progress(f"Найдено счетов в тексте: {len(invoices)}")

    created_files: List[str] = []
    total = len(invoices)
    for index, invoice in enumerate(invoices, start=1):
        result = sorter.create_invoice_package(invoice, idx=index, total=total)
        if result:
            created_files.append(result["output_file"])
        if total:
            report_progress("", percent=30 + int(40 * index / total))

    return created_files


def write_single_document(generate_function, file_path: Path) -> None:
    """
    Выполняет генерацию одного документа с понятной обработкой ошибок.

    Вызывает переданную функцию генерации. Если файл занят другой
    программой, превращает системную ошибку в понятное сообщение.
    """
    try:
        generate_function()
    except PermissionError:
        raise PermissionError(
            f"Не удалось сохранить файл:\n{file_path.name}\n\n"
            "Скорее всего, файл открыт в другой программе. "
            "Закройте его и повторите попытку."
        )
