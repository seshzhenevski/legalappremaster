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
from legal_tools.core.formatting import fmt, next_day


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
) -> dict:
    """
    Рассчитывает неустойку по списку задолженностей с учётом оплат.

    Принимает задолженности, платежи, дату окончания периода, ставку в
    процентах, тип ставки ("day" — дневная, "year" — годовая, делится на 365)
    и необязательное ограничение неустойки в процентах от суммы долга.
    Распределяет платежи по FIFO и возвращает словарь с итоговым долгом,
    итоговой (уже ограниченной, если капинг сработал) неустойкой и
    детальными строками расчёта по каждой задолженности.
    """
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
        "total_debt": fmt(total_debt),
        "total_penalty": fmt(total_penalty),
        "blocks": calculation_blocks,
        "warnings": allocation_warnings,
        "cap_info": cap_info,
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
