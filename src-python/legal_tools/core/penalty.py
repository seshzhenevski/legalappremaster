# -*- coding: utf-8 -*-
"""
core/penalty.py
───────────────
Ядро расчёта договорной неустойки. Чистая логика без UI/IO.

  calc_group()          — расчёт по одному долгу с частичными оплатами
  fifo_allocate()       — FIFO-распределение платежей между долгами

Долги представлены обычными dict (ключи: amount, start, payments) —
формат, совместимый с importers.excel и калькулятором неустойки.
Всё в Decimal — никаких float в денежных операциях.
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import List, Tuple

from .formatting import fmt, count_days, penalty, formula_text


def calc_group(
    amount: Decimal,
    start: date,
    end: date,
    payments: List[Tuple[date, Decimal]],
    rate: Decimal,
    rate_text: str,
    per_year: bool,
    working: bool,
) -> Tuple[List[tuple], Decimal, Decimal]:
    """
    Возвращает (rows, итого_неустойка, остаток_долга) для одной задолженности.
    rows — список:
        ("debt", Долг, С, По, Дней, Формула, Пени)
        ("payment", "-сумма", Дата)
    Частичные оплаты уменьшают баланс СО СЛЕДУЮЩЕГО дня после оплаты.
    """
    rows: List[tuple] = []
    balance = amount
    cur = start
    total = Decimal("0")

    pays = sorted(
        ((p_date, p_amt) for p_date, p_amt in payments if start <= p_date <= end),
        key=lambda x: x[0],
    )

    sentinel = end + timedelta(days=1)
    bounds = [(p_date + timedelta(days=1), p_date, p_amt) for p_date, p_amt in pays]
    bounds.sort(key=lambda x: x[0])
    bounds.append((sentinel, None, None))

    for eff, p_date, p_amt in bounds:
        if balance > 0 and cur < eff:
            days = count_days(cur, eff, working)
            if days > 0:
                p = penalty(balance, rate, days, per_year)
                total += p
                d_to = eff - timedelta(days=1)
                formula = formula_text(balance, days, rate_text, per_year)
                rows.append((
                    "debt",
                    fmt(balance),
                    cur.strftime("%d.%m.%Y"),
                    d_to.strftime("%d.%m.%Y"),
                    str(days),
                    formula,
                    fmt(p),
                ))
        if p_amt is None:
            break
        balance = max(Decimal("0"), balance - p_amt)
        rows.append(("payment", "-" + fmt(p_amt), p_date.strftime("%d.%m.%Y")))
        cur = eff

    return rows, total, balance


def fifo_allocate(
    debts: List[dict], payments: List[Tuple[date, Decimal]],
) -> List[str]:
    """
    Распределяет платежи/возвраты по долгам по принципу FIFO: каждый платёж
    гасит самую старую (по полю "start") непогашенную задолженность первой.
    Мутирует поле "payments" каждого dict-долга.
    Возвращает список предупреждений (если платежи превышают сумму долгов).
    """
    warnings: List[str] = []
    ordered = sorted(debts, key=lambda d: d["start"])
    for d in ordered:
        d.setdefault("payments", [])
    remaining = {id(d): d["amount"] for d in ordered}

    for pay_date, pay_amount in sorted(payments, key=lambda p: p[0]):
        left = pay_amount
        for d in ordered:
            if left <= 0:
                break
            cap = remaining[id(d)]
            if cap <= 0:
                continue
            chunk = min(cap, left)
            d["payments"].append((pay_date, chunk))
            remaining[id(d)] -= chunk
            left -= chunk
        if left > 0:
            warnings.append(
                f"Платёж/возврат на сумму {fmt(left)} руб. от "
                f"{pay_date.strftime('%d.%m.%Y')} превышает остаток задолженности "
                f"по всем счетам — излишек не учтён."
            )
    return warnings
