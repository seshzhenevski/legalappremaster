# -*- coding: utf-8 -*-
"""
core/penalty_395.py
───────────────────
Ядро расчёта процентов по ст. 395 ГК РФ. Чистая логика без UI/сети.

В отличие от договорной неустойки (по-долговой FIFO в core.penalty), проценты
по ст. 395 считаются по ЕДИНОМУ хронологическому реестру: есть общий остаток
задолженности, который растёт при появлении новой задолженности и уменьшается
при погашении, а проценты начисляются по действующей на каждый день ключевой
ставке ЦБ. Период разбивается на отрезки по границам:
  • смены ключевой ставки ЦБ;
  • появления новой задолженности (действует с этого дня);
  • погашения (уменьшает остаток со следующего дня — как в core.penalty);
  • границы календарного года (меняется делитель 365/366).

Формула на отрезке: остаток × ставка% / 100 / дней_в_году × дней.
Каждый отрезок округляется до копеек, затем суммируется.
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
from typing import List, Tuple

from .key_rate import RateHistory, rate_on, days_in_year, rate_change_dates
from .formatting import fmt


def _rate_formula_text(rate: Decimal) -> str:
    """Ставка для строки-формулы без хвостовых нулей: 16.00→«16», 15.50→«15.5»."""
    text = f"{rate:.2f}".rstrip("0").rstrip(".")
    return text or "0"


def calc_395(
    debts: List[Tuple[date, Decimal]],
    payments: List[Tuple[date, Decimal]],
    end: date,
    history: RateHistory,
) -> dict:
    """
    Считает проценты по ст. 395 ГК РФ по единому реестру.

    debts    — список (дата начала просрочки, сумма) появлений задолженности;
    payments — список (дата, сумма) погашений (уменьшают остаток со следующего дня);
    end      — последний день периода (включительно);
    history  — история ключевой ставки ЦБ (см. core.key_rate).

    Возвращает словарь:
      rows           — упорядоченные строки таблицы (типы: "interest", "debt",
                       "payment"); формат совместим с фронтендом и docx;
      total_principal — итоговый остаток основного долга (Decimal);
      total_interest  — сумма процентов (Decimal);
      period_start    — первый день начисления (Decimal-независимо, date);
      warnings        — список предупреждений (напр. недостаёт ставки на дату).
    """
    warnings: List[str] = []
    rows: List[dict] = []

    debts = [(d, Decimal(a)) for d, a in debts if d <= end]
    if not debts:
        return {
            "rows": [], "total_principal": Decimal("0"),
            "total_interest": Decimal("0"), "period_start": None,
            "warnings": ["Нет ни одной задолженности с датой начала в пределах периода."],
        }

    timeline_start = min(d for d, _ in debts)

    # События изменения остатка: (эффективная_дата, тип, сумма, дата_показа)
    # долг действует с даты начала; погашение — со следующего дня.
    events: List[Tuple[date, str, Decimal, date]] = []
    for start, amount in debts:
        events.append((start, "debt", amount, start))
    for pay_date, amount in payments:
        eff = pay_date + timedelta(days=1)
        if pay_date <= end:
            events.append((eff, "payment", amount, pay_date))
    events.sort(key=lambda e: (e[0], 0 if e[1] == "debt" else 1))

    events_by_date: dict = {}
    for eff, kind, amount, shown in events:
        events_by_date.setdefault(eff, []).append((kind, amount, shown))

    # Границы отрезков: старт, эффективные даты событий, смены ставки, 1 января,
    # плюс замыкающая (end + 1 день).
    bounds = {timeline_start, end + timedelta(days=1)}
    for eff in events_by_date:
        if timeline_start <= eff <= end:
            bounds.add(eff)
    for change_date in rate_change_dates(history):
        if timeline_start < change_date <= end:
            bounds.add(change_date)
    for year in range(timeline_start.year + 1, end.year + 1):
        jan1 = date(year, 1, 1)
        if timeline_start < jan1 <= end:
            bounds.add(jan1)
    ordered = sorted(bounds)

    balance = Decimal("0")
    total_interest = Decimal("0")
    missing_rate_years: set = set()

    for index in range(len(ordered) - 1):
        seg_start = ordered[index]
        seg_end = ordered[index + 1]

        # Применяем изменения остатка, действующие с начала отрезка.
        for kind, amount, shown in events_by_date.get(seg_start, []):
            if kind == "debt":
                balance += amount
                # Первичная задолженность (на старте таймлайна) отдельной
                # строкой-событием не выделяется — она и есть начало таблицы.
                if seg_start != timeline_start:
                    rows.append({
                        "type": "debt", "date": shown, "amount": amount,
                        "amount_fmt": "+" + fmt(amount),
                        "date_fmt": shown.strftime("%d.%m.%Y"),
                    })
            else:  # payment
                balance = max(Decimal("0"), balance - amount)
                rows.append({
                    "type": "payment", "date": shown, "amount": amount,
                    "amount_fmt": "-" + fmt(amount),
                    "date_fmt": shown.strftime("%d.%m.%Y"),
                })

        days = (seg_end - seg_start).days
        if days <= 0 or balance <= 0:
            continue

        rate = rate_on(history, seg_start)
        if rate is None:
            missing_rate_years.add(seg_start.year)
            continue

        diy = days_in_year(seg_start.year)
        interest = (balance * rate * Decimal(days) /
                    (Decimal(100) * Decimal(diy))).quantize(
                        Decimal("0.01"), ROUND_HALF_UP)
        total_interest += interest
        to_inclusive = seg_end - timedelta(days=1)
        rate_txt = _rate_formula_text(rate)
        rows.append({
            "type": "interest",
            "balance": balance,
            "balance_fmt": fmt(balance),
            "from": seg_start,
            "to": to_inclusive,
            "from_fmt": seg_start.strftime("%d.%m.%Y"),
            "to_fmt": to_inclusive.strftime("%d.%m.%Y"),
            "days": days,
            "rate": rate,
            "rate_fmt": fmt(rate),
            "formula": f"{fmt(balance)} × {days} × {rate_txt}% / {diy}",
            "interest": interest,
            "interest_fmt": fmt(interest),
        })

    if missing_rate_years:
        years = ", ".join(str(y) for y in sorted(missing_rate_years))
        warnings.append(
            "В истории ключевой ставки нет данных на часть периода "
            f"(годы: {years}) — эти дни в расчёт не вошли."
        )

    return {
        "rows": rows,
        "total_principal": balance,
        "total_interest": total_interest,
        "period_start": timeline_start,
        "warnings": warnings,
    }
