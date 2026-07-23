# -*- coding: utf-8 -*-
"""
Слой логики: расчёт договорной неустойки.

Оборачивает ядро расчёта (legal_tools.core.penalty) в функции с понятными
именами и простыми входными/выходными данными для передачи фронтенду.
"""
from __future__ import annotations

from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import List, Optional, Tuple

from legal_tools.core.penalty import calc_group, fifo_allocate
from legal_tools.core.penalty_395 import calc_395
from legal_tools.core.formatting import fmt, next_day
from logic.key_rate_service import ensure_fresh_history


def parse_iso_date(iso_date_string: str) -> date:
    """
    Преобразует строку даты формата ГГГГ-ММ-ДД в объект date.

    Фронтенд передаёт даты в ISO-формате (из <input type="date">),
    эта функция превращает их в питоновский date для расчётов.
    """
    year, month, day = (int(part) for part in iso_date_string.split("-"))
    return date(year, month, day)


def build_debt_records_from_input(
    debts_input: List[dict],
) -> List[dict]:
    """
    Строит список записей о задолженностях из данных формы.

    Каждый входной элемент содержит amount (сумма) и start_date (дата начала
    просрочки в ISO-формате). Возвращает список словарей с полями amount,
    start и пустым payments — в формате, который принимает ядро расчёта.
    """
    debt_records: List[dict] = []
    for debt_item in debts_input:
        debt_records.append({
            "amount": Decimal(str(debt_item["amount"])),
            "start": parse_iso_date(debt_item["start_date"]),
            "payments": [],
        })
    return debt_records


def build_payment_pairs_from_input(
    payments_input: List[dict],
) -> List[Tuple[date, Decimal]]:
    """
    Строит список платежей (дата, сумма) из данных формы.

    Каждый входной элемент содержит amount и date в ISO-формате.
    Возвращает список кортежей, пригодный для FIFO-распределения.
    """
    payment_pairs: List[Tuple[date, Decimal]] = []
    for payment_item in payments_input:
        payment_pairs.append((
            parse_iso_date(payment_item["date"]),
            Decimal(str(payment_item["amount"])),
        ))
    return payment_pairs


def calculate_penalty_for_debts(
    debts_input: List[dict],
    payments_input: List[dict],
    period_end_date: str,
    daily_rate_percent: str,
    rate_type: str = "day",
    cap_percent: Optional[str] = None,
    penalty_type: str = "contractual",
    check_rate_online: bool = True,
) -> dict:
    """
    Рассчитывает неустойку по списку задолженностей с учётом оплат.

    Принимает задолженности, платежи, дату окончания периода, ставку в
    процентах, тип ставки ("day" — дневная, "year" — годовая, делится на 365)
    и необязательное ограничение неустойки в процентах от суммы долга.
    penalty_type задаёт способ расчёта: "contractual" — договорная неустойка
    (текущая логика), "statutory_395" — проценты по ст. 395 ГК РФ по ключевой
    ставке ЦБ (ставка/тип/ограничение при этом игнорируются). Возвращает
    словарь с итоговым долгом, итоговой неустойкой и детальными строками.
    """
    if penalty_type == "statutory_395":
        return _calculate_statutory_395(
            debts_input, payments_input, period_end_date, check_rate_online,
        )

    debt_records = build_debt_records_from_input(debts_input)
    payment_pairs = build_payment_pairs_from_input(payments_input)

    allocation_warnings = fifo_allocate(debt_records, payment_pairs)

    end_date = parse_iso_date(period_end_date)
    rate = Decimal(str(daily_rate_percent))
    per_year = rate_type == "year"

    total_debt = Decimal("0")
    total_penalty_raw = Decimal("0")
    calculation_blocks: List[dict] = []

    for debt_record in debt_records:
        rows, penalty_total, remaining_balance = calc_group(
            debt_record["amount"],
            debt_record["start"],
            end_date,
            debt_record["payments"],
            rate,
            str(daily_rate_percent),
            per_year=per_year,
            working=False,
        )
        total_debt += remaining_balance
        total_penalty_raw += penalty_total
        calculation_blocks.append({
            "start_date": debt_record["start"].strftime("%d.%m.%Y"),
            "initial_amount": fmt(debt_record["amount"]),
            "penalty_total": fmt(penalty_total),
            "rows": rows,
        })

    total_penalty, cap_info = apply_penalty_cap(total_debt, total_penalty_raw, cap_percent)

    return {
        "mode": "contractual",
        "total_debt": fmt(total_debt),
        "total_penalty": fmt(total_penalty),
        "blocks": calculation_blocks,
        "warnings": allocation_warnings,
        "cap_info": cap_info,
    }


def serialize_395_rows(rows: List[dict]) -> List[dict]:
    """
    Приводит строки расчёта по ст. 395 (из core.penalty_395) к JSON-виду.

    Оставляет только строковые/числовые поля, пригодные для передачи
    фронтенду и генерации документов: строки начисления процентов и
    строки-события (новая задолженность / погашение).
    """
    serialized: List[dict] = []
    for row in rows:
        if row["type"] == "interest":
            serialized.append({
                "type": "interest",
                "debt": row["balance_fmt"],
                "from": row["from_fmt"],
                "to": row["to_fmt"],
                "days": row["days"],
                "rate": row["rate_fmt"],
                "formula": row["formula"],
                "interest": row["interest_fmt"],
            })
        else:  # debt | payment
            serialized.append({
                "type": row["type"],
                "amount": row["amount_fmt"],
                "date": row["date_fmt"],
            })
    return serialized


def _calculate_statutory_395(
    debts_input: List[dict],
    payments_input: List[dict],
    period_end_date: str,
    check_rate_online: bool,
) -> dict:
    """
    Рассчитывает проценты по ст. 395 ГК РФ по ключевой ставке ЦБ.

    Строит единый хронологический реестр (core.penalty_395.calc_395),
    подтягивая при необходимости актуальную ставку из API ЦБ. Возвращает
    словарь того же «внешнего» формата, что и договорный расчёт, но с
    признаком mode="statutory_395" и строками rows_395 для единой таблицы.
    """
    end_date = parse_iso_date(period_end_date)
    debts = [
        (parse_iso_date(item["start_date"]), Decimal(str(item["amount"])))
        for item in debts_input
    ]
    payments = [
        (parse_iso_date(item["date"]), Decimal(str(item["amount"])))
        for item in payments_input
    ]

    history, rate_warnings = ensure_fresh_history(end_date, allow_network=check_rate_online)
    result = calc_395(debts, payments, end_date, history)

    return {
        "mode": "statutory_395",
        "total_debt": fmt(result["total_principal"]),
        "total_penalty": fmt(result["total_interest"]),
        "blocks": [],
        "rows_395": serialize_395_rows(result["rows"]),
        "warnings": rate_warnings + result["warnings"],
        "cap_info": None,
    }


def apply_penalty_cap(
    total_debt: Decimal,
    total_penalty_raw: Decimal,
    cap_percent: Optional[str],
) -> Tuple[Decimal, Optional[dict]]:
    """
    Ограничивает неустойку заданным процентом от суммы долга, если указан.

    Принимает сумму долга, нерасчёту неустойку и необязательный процент
    ограничения. Возвращает (итоговая_неустойка, инфо_об_ограничении) —
    инфо равно None, если ограничение не задано или не сработало.
    Формула — та же, что уже применяется в генераторе иска (compute_lawsuit).
    """
    if cap_percent is None or str(cap_percent).strip() == "":
        return total_penalty_raw, None

    cap_pct = Decimal(str(cap_percent))
    if cap_pct <= 0:
        return total_penalty_raw, None

    cap_value = (total_debt * cap_pct / Decimal(100)).quantize(
        Decimal("0.01"), ROUND_HALF_UP
    )
    if total_penalty_raw <= cap_value:
        return total_penalty_raw, None

    return cap_value, {
        "cap_percent": fmt(cap_pct),
        "cap_value": fmt(cap_value),
        "uncapped_total": fmt(total_penalty_raw),
    }
