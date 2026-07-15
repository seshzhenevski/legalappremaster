# -*- coding: utf-8 -*-
"""
court_cases_dashboard.py
────────────────────────
Аналитика по реестру судебных дел из Google-таблицы.

Модуль читает таблицу (только на чтение), разбирает строки и считает все
показатели дашборда: воронку по стадиям, суммы требований и взысканий,
динамику по годам, топ должников, распределение по судам. Интерфейс он не
знает — возвращает простые dict/list, готовые к отправке в JSON.

Главный принцип разбора: пустая ячейка — нормальная рабочая ситуация, а не
ошибка. Дело учитывается по тем данным, что есть; всё, что не удалось
разобрать, попадает в блок предупреждений, но никогда не роняет расчёт и не
обнуляется молча.
"""
from __future__ import annotations

import re
from decimal import Decimal

from legal_tools.core.formatting import parse_amount_cell, parse_any_date, parse_date_cell
from legal_tools.importers.google_sheets import read_sheets_values

CASES_SHEET_TITLE = "СУДЫ"
BANKRUPTCY_SHEET_TITLE = "БАНКРОТСТВО"

# Строка-разделитель года: в первой колонке листа («Истец») стоит «2026 год».
YEAR_SEPARATOR_PATTERN = re.compile(r"^\s*(\d{4})\s*год\s*$", re.IGNORECASE)

# Дела, оказавшиеся выше первой строки-разделителя: год у них неизвестен, но из
# статистики они не выпадают.
UNKNOWN_YEAR_LABEL = "Без года"

# Порядок стадий процесса — он же порядок столбцов воронки. Список взят из
# реального реестра, а не выдуман: других статусов юристы не ставят.
STAGE_CLAIM_PREPARATION = "подготовка иска"
STAGE_LITIGATION = "процесс"
STAGE_ENFORCEMENT = "исполнительное пр-во"
STAGE_BANKRUPTCY = "банкротство"
STAGE_REPAID = "долг погашен"
STAGE_UNCOLLECTIBLE = "невозвратная задолженность"

# Две последние стадии — исходы, а не этапы: долг вернули или списали. Поэтому
# они замыкают воронку.
STAGE_ORDER = [
    STAGE_CLAIM_PREPARATION,
    STAGE_LITIGATION,
    STAGE_ENFORCEMENT,
    STAGE_BANKRUPTCY,
    STAGE_REPAID,
    STAGE_UNCOLLECTIBLE,
]

# Погашенный долг в реестре помечают двумя способами: вернули до суда или
# взыскали по исполнительному листу. В воронке это одна стадия (дело закрыто),
# но разбивка сохраняется — она видна в подсказке к столбцу.
REPAID_PRE_TRIAL = "досудебно"
REPAID_BY_WRIT = "по ИЛ"
REPAID_UNSPECIFIED = "способ не указан"

# Статусы, выведенные из данных, и мусорные значения показываются отдельными
# категориями — чтобы не искажать воронку и чтобы юрист видел пробелы в реестре.
STATUS_NOT_SET = "Статус не указан"
STATUS_UNRECOGNIZED = "Статус не распознан"

NOT_SPECIFIED = "Не указан"

TOP_DEBTORS_LIMIT = 10

# Сколько строк с битыми данными показывать в блоке предупреждений. Список —
# подсказка «куда идти чинить», а не полный отчёт: сотня строк в интерфейсе
# бесполезна.
WARNING_SAMPLES_LIMIT = 20

# Колонки листа «СУДЫ»: внутреннее имя → как колонка названа в таблице.
# Сопоставление идёт по тексту заголовка, а не по номеру колонки, поэтому
# перестановка колонок в таблице дашборд не ломает. Синонимов по нескольку:
# заголовки правят руками («ПДЗ» когда-то было «ОСВ», «Взыскание» — это номер
# исполнительного производства, а вовсе не сумма).
CASE_COLUMN_ALIASES = {
    "section": ["истец", "оффер"],
    "debtor": ["должник"],
    "inn": ["инн"],
    "in_work_date": ["в работе"],
    "court_date": ["передано в суд"],
    "case_number": ["номер дела"],
    "court": ["суд"],
    "principal": ["пдз", "осв", "основной долг"],
    "penalty": ["неустойка"],
    "court_costs": ["суд расходы", "судебные расходы"],
    "decision": ["решение"],
    "total": ["сумма"],
    "enforcement": ["взыскание", "исполнительное производство"],
    "recovered": ["долг погашен"],
    "comments": ["комментарии"],
    "status": ["статус"],
}

BANKRUPTCY_COLUMN_ALIASES = {
    "creditor": ["кредитор"],
    "debtor": ["должник"],
    "case_number": ["номер дела"],
    "court": ["суд"],
    "stage": ["стадия"],
    "total": ["сумма"],
    "comments": ["комментарии"],
}

# Человекочитаемые названия колонок для текста предупреждений.
COLUMN_TITLES = {
    "principal": "ПДЗ",
    "penalty": "Неустойка",
    "court_costs": "Суд расходы",
    "total": "Сумма",
    "recovered": "Долг погашен",
}

# Стадии банкротства пишут свободным текстом вместе с датами и пометками
# («Конкурсное производство до 25.05.2026», «СЗ 03.09.2026 / Без движения…»).
# Для графика они сводятся к ключевому слову; полный текст остаётся в таблице.
BANKRUPTCY_STAGE_KEYWORDS = [
    ("наблюдени", "Наблюдение"),
    ("конкурсн", "Конкурсное производство"),
    ("реализаци", "Реализация имущества"),
    ("финансов", "Финансовое оздоровление"),
    ("внешнее управлени", "Внешнее управление"),
    ("прекращ", "Прекращено"),
]
BANKRUPTCY_STAGE_OTHER = "Иное"


def load_dashboard_data(params: dict) -> dict:
    """
    Читает таблицу и возвращает готовые данные дашборда.

    Принимает путь к JSON-ключу сервисного аккаунта и идентификатор таблицы.
    Возвращает показатели сразу по всем годам и по каждому году отдельно —
    интерфейс переключает годы без повторного обращения к Google.
    """
    sheets = read_sheets_values(
        credentials_path=params["credentials_path"],
        spreadsheet_id=params["spreadsheet_id"],
        sheet_titles=[CASES_SHEET_TITLE, BANKRUPTCY_SHEET_TITLE],
    )
    return build_dashboard_data(
        case_rows=sheets.get(CASES_SHEET_TITLE, []),
        bankruptcy_rows=sheets.get(BANKRUPTCY_SHEET_TITLE, []),
    )


def build_dashboard_data(case_rows: list, bankruptcy_rows: list) -> dict:
    """
    Считает все показатели дашборда по сырым строкам двух листов.

    Принимает значения листов как их отдаёт Sheets API (первая строка —
    заголовки). Чистая функция без обращений к сети — на ней держатся тесты.
    """
    warnings = _new_warnings()

    cases = _parse_case_rows(case_rows, warnings)
    bankruptcies = _parse_bankruptcy_rows(bankruptcy_rows, warnings)

    years = _sorted_years(cases)

    return {
        "cases": {
            "years": years,
            "overall": _cases_section(cases),
            "by_year": {year: _cases_section(_filter_by_year(cases, year)) for year in years},
            "dynamics": [_year_dynamics(year, _filter_by_year(cases, year)) for year in years],
        },
        "bankruptcy": _bankruptcy_section(bankruptcies),
        "warnings": _finalize_warnings(warnings),
    }


# ── Разбор листа «Судебные дела» ─────────────────────────────────────────────

def _parse_case_rows(rows: list, warnings: dict) -> list[dict]:
    """
    Превращает строки листа «СУДЫ» в список дел.

    По ходу разбора отслеживает строки-разделители («2026 год») и приписывает
    каждому делу год той секции, под которой оно стоит. Сами разделители в
    статистику не попадают. Пустые строки пропускаются.
    """
    if not rows:
        return []

    columns = _map_columns(rows[0], CASE_COLUMN_ALIASES)
    cases = []
    current_year = None

    for offset, row in enumerate(rows[1:]):
        row_number = offset + 2  # +1 за заголовок, +1 за нумерацию строк с единицы
        if _is_blank_row(row):
            continue

        separator_year = _year_from_separator(_cell(row, columns, "section"))
        if separator_year:
            current_year = separator_year
            continue

        cases.append(_build_case(row, row_number, columns, current_year, warnings))

    return cases


def _build_case(row: list, row_number: int, columns: dict, year: str | None, warnings: dict) -> dict:
    """
    Собирает одно дело из строки таблицы.

    Каждое поле разбирается терпимо: пустая ячейка не выбрасывает строку из
    статистики, а нераспознанное значение считается нулём и попадает в
    предупреждения.
    """
    principal = _amount(row, columns, "principal", row_number, warnings)
    penalty = _amount(row, columns, "penalty", row_number, warnings)
    court_costs = _amount(row, columns, "court_costs", row_number, warnings)
    total = _amount(row, columns, "total", row_number, warnings)
    recovered = _amount(row, columns, "recovered", row_number, warnings)

    # Итоговая «Сумма» может быть не заполнена, хотя слагаемые есть, — тогда
    # считаем её сами, иначе дело потеряло бы вес в суммах и в топе должников.
    claimed = total if total > 0 else principal + penalty + court_costs

    debtor = _text(row, columns, "debtor")
    inn = _text(row, columns, "inn")
    if not debtor or not inn:
        warnings["cases_without_debtor"] += 1

    court_date = parse_date_cell(_cell(row, columns, "court_date"))
    # «Взыскание» — это номер исполнительного производства (текст), а не сумма.
    # По его наличию видно, что дело дошло до приставов.
    enforcement = _text(row, columns, "enforcement")

    in_work_date = parse_date_cell(_cell(row, columns, "in_work_date"))
    decision_date = _decision_date(_cell(row, columns, "decision"))

    status, repaid_via = _resolve_status(
        raw_status=_text(row, columns, "status"),
        court_date=court_date,
        recovered=recovered,
        enforcement=enforcement,
        row_number=row_number,
        warnings=warnings,
    )

    return {
        "row_number": row_number,
        "year": year or UNKNOWN_YEAR_LABEL,
        "debtor": debtor,
        "inn": inn,
        "court": _text(row, columns, "court"),
        "case_number": _text(row, columns, "case_number"),
        "in_work_date": in_work_date,
        "court_date": court_date,
        "review_days": _review_days(in_work_date, decision_date),
        "principal": principal,
        "penalty": penalty,
        "court_costs": court_costs,
        "claimed": claimed,
        "recovered": recovered,
        "status": status,
        "repaid_via": repaid_via,
    }


def _resolve_status(raw_status: str, court_date, recovered: Decimal, enforcement: str,
                    row_number: int, warnings: dict) -> tuple[str, str | None]:
    """
    Определяет стадию дела и, для погашенных, способ возврата долга.

    Основной источник — колонка «Статус». Пишут её свободно («Долг погашен /
    Досудебное урег-е», «Исполнительное пр-во»), поэтому стадия распознаётся по
    ключевому слову, а не точным совпадением.

    Если статус пуст, стадия выводится из данных: есть погашение — долг
    погашен; заведено исполнительное производство — приставы; нет даты передачи
    в суд — дело ещё на подготовке иска. Если вывести нельзя, дело идёт в
    отдельную категорию «Статус не указан»: она видна в воронке и в
    предупреждениях, но не искажает остальные стадии.
    """
    if not raw_status:
        warnings["cases_without_status"] += 1
        if recovered > 0:
            return STAGE_REPAID, REPAID_UNSPECIFIED
        if enforcement:
            return STAGE_ENFORCEMENT, None
        if court_date is None:
            return STAGE_CLAIM_PREPARATION, None
        return STATUS_NOT_SET, None

    normalized = _normalize_text(raw_status)

    if "долг погашен" in normalized:
        return STAGE_REPAID, _repayment_kind(normalized)
    if "невозвратн" in normalized:
        return STAGE_UNCOLLECTIBLE, None
    if "исполнительн" in normalized:
        return STAGE_ENFORCEMENT, None
    if "банкротств" in normalized:
        return STAGE_BANKRUPTCY, None
    if "процесс" in normalized:
        return STAGE_LITIGATION, None
    if "подготовка" in normalized:
        return STAGE_CLAIM_PREPARATION, None

    warnings["unknown_statuses"].append({"row": row_number, "value": raw_status})
    return STATUS_UNRECOGNIZED, None


def _decision_date(raw_decision):
    """
    Достаёт дату решения из колонки «Решение».

    Там не дата, а фраза: «06.02.2026 - удовлетворен», иногда «удовлетворен
    частично». Берётся первая дата в тексте; если её нет (или колонка пуста) —
    None, и такое дело просто не участвует в расчёте срока.
    """
    if raw_decision is None or str(raw_decision).strip() == "":
        return None

    direct = parse_date_cell(raw_decision)
    if direct is not None:
        return direct

    match = re.search(r"\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}", str(raw_decision))
    return parse_any_date(match.group(0)) if match else None


def _review_days(in_work_date, decision_date) -> int | None:
    """
    Считает срок рассмотрения дела: от «В работе» до даты решения.

    Возвращает None, если хотя бы одной даты нет или они стоят в обратном
    порядке (опечатка в реестре). Такое дело не искажает среднее — оно просто
    не учитывается, как и просили: считаем только по тем данным, что есть.
    """
    if in_work_date is None or decision_date is None:
        return None
    days = (decision_date - in_work_date).days
    return days if days >= 0 else None


def _repayment_kind(normalized_status: str) -> str:
    """
    Различает, как вернули долг: до суда или по исполнительному листу.

    В воронке обе пометки — одна стадия «долг погашен» (дело закрыто), но
    разбивка сохраняется: вернуть деньги перепиской и вытрясти их через
    приставов — разного качества результат.
    """
    if "досуд" in normalized_status:
        return REPAID_PRE_TRIAL
    if "по ил" in normalized_status or "исполнительн" in normalized_status:
        return REPAID_BY_WRIT
    return REPAID_UNSPECIFIED


# ── Разбор листа «Банкротство» ───────────────────────────────────────────────

def _parse_bankruptcy_rows(rows: list, warnings: dict) -> list[dict]:
    """
    Превращает строки листа «БАНКРОТСТВО» в список дел.

    Разделителей по годам на этом листе нет. Стадия хранится дважды: как её
    написали в реестре (полный текст с датами — он идёт в таблицу) и сведённой
    к процедуре банкротства (для графика).
    """
    if not rows:
        return []

    columns = _map_columns(rows[0], BANKRUPTCY_COLUMN_ALIASES)
    cases = []

    for offset, row in enumerate(rows[1:]):
        row_number = offset + 2
        if _is_blank_row(row):
            continue

        raw_stage = _text(row, columns, "stage")
        cases.append({
            "row_number": row_number,
            "debtor": _text(row, columns, "debtor"),
            "creditor": _text(row, columns, "creditor"),
            "case_number": _text(row, columns, "case_number"),
            "court": _text(row, columns, "court"),
            "stage_text": raw_stage or NOT_SPECIFIED,
            "stage": _bankruptcy_stage(raw_stage),
            "claimed": _amount(row, columns, "total", row_number, warnings, sheet="БАНКРОТСТВО"),
        })

    return cases


def _bankruptcy_stage(raw_stage: str) -> str:
    """
    Сводит свободный текст стадии к процедуре банкротства.

    В реестре пишут «Конкурсное производство до 25.05.2026», «СЗ 23.07.2026»,
    иногда в несколько строк. Для графика важна процедура, а не дата заседания:
    без этой свёртки у 31 дела получилось бы 30 категорий и график ни о чём.
    Всё, что не опознано (например, только дата судебного заседания), попадает
    в «Иное»; полный текст остаётся видимым в таблице должников.
    """
    if not raw_stage:
        return NOT_SPECIFIED

    normalized = _normalize_text(raw_stage)
    for keyword, stage_name in BANKRUPTCY_STAGE_KEYWORDS:
        if keyword in normalized:
            return stage_name
    return BANKRUPTCY_STAGE_OTHER


# ── Показатели ───────────────────────────────────────────────────────────────

def _cases_section(cases: list[dict]) -> dict:
    """
    Считает все блоки секции «Судебные дела» по переданному набору дел.

    Одна и та же функция обслуживает общий обзор и экран конкретного года —
    отличается только переданный набор. Поэтому сводные показатели по всем
    годам по определению равны сумме показателей по годам.
    """
    claimed_total = sum((case["claimed"] for case in cases), Decimal(0))
    recovered_total = sum((case["recovered"] for case in cases), Decimal(0))

    # Срок рассмотрения считается только по делам, где есть обе даты: начало
    # работы и решение. Дела без них не занижают и не завышают среднее — они в
    # расчёт не входят, поэтому рядом со средним отдаётся и размер выборки.
    review_terms = [case["review_days"] for case in cases if case["review_days"] is not None]

    return {
        "kpi": {
            "cases_count": len(cases),
            "claimed_total": _money(claimed_total),
            "recovered_total": _money(recovered_total),
            # Знаменатель может быть нулём (требований нет) — процент тогда не
            # существует, и интерфейс покажет прочерк вместо деления на ноль.
            "recovery_percent": (
                _money(recovered_total / claimed_total * 100) if claimed_total > 0 else None
            ),
            "average_review_days": (
                round(sum(review_terms) / len(review_terms)) if review_terms else None
            ),
            "review_cases_count": len(review_terms),
        },
        "funnel": _funnel(cases),
        "claim_structure": {
            "principal": _money(sum((case["principal"] for case in cases), Decimal(0))),
            "penalty": _money(sum((case["penalty"] for case in cases), Decimal(0))),
            "court_costs": _money(sum((case["court_costs"] for case in cases), Decimal(0))),
        },
        "top_debtors": [
            {
                "debtor": case["debtor"] or NOT_SPECIFIED,
                "inn": case["inn"],
                "case_number": case["case_number"],
                "claimed": _money(case["claimed"]),
                "status": case["status"],
            }
            for case in sorted(cases, key=lambda case: case["claimed"], reverse=True)[:TOP_DEBTORS_LIMIT]
        ],
        # Пустой суд означает, что дело в суд не передавалось, — это не пробел в
        # данных, и отдельной категории «Не указан» в распределении по судам
        # быть не должно: она бы соперничала по величине с настоящими судами.
        "courts": _grouped_counts(case["court"] for case in cases if case["court"]),
    }


def _funnel(cases: list[dict]) -> list[dict]:
    """
    Строит воронку: количество дел и сумма требований на каждой стадии.

    Стадии идут в порядке процесса, чтобы был виден «затор». Категории
    «Статус не указан» и «Статус не распознан» добавляются в конец и только
    если такие дела есть. У стадии «долг погашен» дополнительно возвращается
    разбивка по способу возврата — интерфейс показывает её в подсказке.
    """
    stages = list(STAGE_ORDER)
    for extra in (STATUS_NOT_SET, STATUS_UNRECOGNIZED):
        if any(case["status"] == extra for case in cases):
            stages.append(extra)

    funnel = []
    for stage in stages:
        on_stage = [case for case in cases if case["status"] == stage]
        entry = {
            "stage": stage,
            "count": len(on_stage),
            "claimed": _money(sum((case["claimed"] for case in on_stage), Decimal(0))),
        }
        if stage == STAGE_REPAID:
            entry["breakdown"] = _grouped_counts(
                case["repaid_via"] or REPAID_UNSPECIFIED for case in on_stage
            )
        funnel.append(entry)

    return funnel


def _bankruptcy_section(cases: list[dict]) -> dict:
    """
    Считает блоки секции «Банкротство»: показатели, воронку и топ должников.

    Стадии не упорядочены по процессу (закрытого списка нет) — они идут по
    убыванию количества дел.
    """
    return {
        "kpi": {
            "cases_count": len(cases),
            "claimed_total": _money(sum((case["claimed"] for case in cases), Decimal(0))),
        },
        "stages": _grouped_counts(case["stage"] for case in cases),
        "dynamics": _bankruptcy_dynamics(cases),
        "top_debtors": [
            {
                "debtor": case["debtor"] or NOT_SPECIFIED,
                "case_number": case["case_number"],
                "court": case["court"],
                # В таблице показывается стадия как её записали, вместе с датами:
                # юристу нужен именно этот текст, а не свёрнутая категория.
                "stage": case["stage_text"],
                "claimed": _money(case["claimed"]),
            }
            for case in sorted(cases, key=lambda case: case["claimed"], reverse=True)[:TOP_DEBTORS_LIMIT]
        ],
    }


def _bankruptcy_dynamics(cases: list[dict]) -> list[dict]:
    """
    Строит динамику банкротных дел по годам.

    Год берётся не из отдельной колонки (её нет), а из номера дела: в
    «А60-67691/2024» год — 2024. Если в ячейке несколько номеров с разными
    годами, дело учитывается в каждом из этих годов целиком (и по количеству, и
    по сумме) — так и просили: одно банкротство может тянуться делами разных
    лет. Дела, где год из номера не вычитать, собираются под «Без года».
    """
    by_year: dict[str, dict] = {}
    for case in cases:
        years = _years_from_case_number(case["case_number"]) or {UNKNOWN_YEAR_LABEL}
        for year in years:
            bucket = by_year.setdefault(year, {"count": 0, "claimed": Decimal(0)})
            bucket["count"] += 1
            bucket["claimed"] += case["claimed"]

    numeric_years = sorted((y for y in by_year if y != UNKNOWN_YEAR_LABEL), reverse=True)
    if UNKNOWN_YEAR_LABEL in by_year:
        numeric_years.append(UNKNOWN_YEAR_LABEL)

    return [
        {
            "year": year,
            "cases_count": by_year[year]["count"],
            "claimed": _money(by_year[year]["claimed"]),
        }
        for year in numeric_years
    ]


def _years_from_case_number(case_number: str) -> set[str]:
    """
    Извлекает годы из номера (или номеров) арбитражного дела.

    Номер заканчивается годом после косой черты: «А40-9014/2022» → 2022. В
    ячейке может стоять несколько номеров (перенос строки или пробел) — тогда
    возвращаются все встреченные годы. Берутся только правдоподобные годы
    (20xx), чтобы не спутать год с частью номера дела.
    """
    if not case_number:
        return set()
    return set(re.findall(r"/\s*(20\d{2})", case_number))


def _year_dynamics(year: str, cases: list[dict]) -> dict:
    """Сводка по одному году для графика динамики и для карточки года."""
    return {
        "year": year,
        "cases_count": len(cases),
        "claimed": _money(sum((case["claimed"] for case in cases), Decimal(0))),
        "recovered": _money(sum((case["recovered"] for case in cases), Decimal(0))),
    }


def _grouped_counts(values) -> list[dict]:
    """Группирует значения и возвращает их по убыванию количества."""
    counts: dict[str, int] = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    return [
        {"name": name, "count": count}
        for name, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]


def _sorted_years(cases: list[dict]) -> list[str]:
    """
    Возвращает годы, встреченные в реестре, от свежего к старому.

    «Без года» (дела выше первого разделителя) всегда идёт последним — это
    служебная категория, а не год.
    """
    years = {case["year"] for case in cases}
    numeric = sorted((year for year in years if year != UNKNOWN_YEAR_LABEL), reverse=True)
    if UNKNOWN_YEAR_LABEL in years:
        numeric.append(UNKNOWN_YEAR_LABEL)
    return numeric


def _filter_by_year(cases: list[dict], year: str) -> list[dict]:
    """Отбирает дела одного года."""
    return [case for case in cases if case["year"] == year]


# ── Разбор ячеек ─────────────────────────────────────────────────────────────

def _map_columns(header_row: list, aliases: dict) -> dict:
    """
    Сопоставляет колонки таблицы с внутренними именами полей.

    Ищет по тексту заголовка: сначала точное совпадение, потом совпадение по
    началу («Суд. расходы» → court_costs, «Сумма (ОСВ+Неустойка+Суд.расходы)» →
    total). Точное совпадение проверяется раньше префиксного, иначе «Суд»
    перехватил бы «Суд. расходы».
    """
    normalized_header = [_normalize_text(cell) for cell in header_row]
    columns: dict[str, int] = {}

    for field, field_aliases in aliases.items():
        for index, title in enumerate(normalized_header):
            if title and any(title == alias for alias in field_aliases):
                columns[field] = index
                break

    for field, field_aliases in aliases.items():
        if field in columns:
            continue
        for index, title in enumerate(normalized_header):
            if index in columns.values():
                continue
            if title and any(title.startswith(alias) for alias in field_aliases):
                columns[field] = index
                break

    return columns


def _cell(row: list, columns: dict, field: str):
    """Возвращает сырое значение ячейки или None, если колонки/значения нет."""
    index = columns.get(field)
    if index is None or index >= len(row):
        return None
    return row[index]


def _text(row: list, columns: dict, field: str) -> str:
    """Возвращает текст ячейки без лишних пробелов; пустая ячейка — пустая строка."""
    value = _cell(row, columns, field)
    if value is None:
        return ""
    return str(value).strip()


def _amount(row: list, columns: dict, field: str, row_number: int, warnings: dict, sheet: str = "Судебные дела") -> Decimal:
    """
    Разбирает денежную ячейку.

    Пустая ячейка — это ноль и никакого предупреждения: юрист просто ещё не
    внёс сумму. А вот текст вместо числа («н/д», «—») — это ноль плюс запись в
    предупреждения: молча обнулять данные нельзя, пользователь должен видеть,
    что реестр в этом месте битый.
    """
    raw = _cell(row, columns, field)
    if raw is None or str(raw).strip() == "":
        return Decimal(0)

    parsed = parse_amount_cell(raw)
    if parsed is None:
        warnings["unparsed_amounts"].append({
            "sheet": sheet,
            "row": row_number,
            "column": COLUMN_TITLES.get(field, field),
            "value": str(raw).strip(),
        })
        return Decimal(0)
    return parsed


def _is_blank_row(row: list) -> bool:
    """Пустая строка таблицы — пропускается, а не считается делом без данных."""
    return all(cell is None or str(cell).strip() == "" for cell in row)


def _year_from_separator(offer_value) -> str | None:
    """
    Распознаёт строку-разделитель года.

    Разделитель — это текст вида «2026 год» в колонке «Оффер». Цвет заливки не
    читается: распознавание только по тексту (надёжнее и проще через API).
    """
    if offer_value is None:
        return None
    match = YEAR_SEPARATOR_PATTERN.match(str(offer_value).strip())
    return match.group(1) if match else None


def _normalize_text(value) -> str:
    """
    Приводит текст к виду, по которому сравниваются заголовки и статусы.

    Регистр, «ё», точки и лишние пробелы в реестре пишут как придётся, поэтому
    сравнение идёт по нормализованной форме: «Суд. расходы» и «суд расходы» —
    одно и то же.
    """
    text = str(value or "").lower().replace("ё", "е")
    text = re.sub(r"[^\w/]+", " ", text, flags=re.UNICODE)
    return " ".join(text.split())


def _money(value: Decimal) -> float:
    """Переводит сумму в число для JSON, округляя до копеек."""
    return round(float(value), 2)


# ── Предупреждения о качестве данных ─────────────────────────────────────────

def _new_warnings() -> dict:
    """Заводит счётчики качества данных для одного разбора таблицы."""
    return {
        "cases_without_status": 0,
        "cases_without_debtor": 0,
        "unparsed_amounts": [],
        "unknown_statuses": [],
    }


def _finalize_warnings(warnings: dict) -> dict:
    """
    Готовит блок предупреждений к отправке в интерфейс.

    Длинные списки обрезаются до нескольких примеров: блок должен подсказывать,
    куда идти чинить реестр, а не превращаться в простыню на пол-экрана.
    """
    return {
        "cases_without_status": warnings["cases_without_status"],
        "cases_without_debtor": warnings["cases_without_debtor"],
        "unparsed_amounts_count": len(warnings["unparsed_amounts"]),
        "unparsed_amounts": warnings["unparsed_amounts"][:WARNING_SAMPLES_LIMIT],
        "unknown_statuses_count": len(warnings["unknown_statuses"]),
        "unknown_statuses": warnings["unknown_statuses"][:WARNING_SAMPLES_LIMIT],
    }
