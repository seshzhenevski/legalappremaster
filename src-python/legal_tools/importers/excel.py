# -*- coding: utf-8 -*-
"""
importers/excel.py
──────────────────
Чтение Excel-реестра счетов для искового заявления, группировка по
номеру счёта с FIFO-распределением возвратов, и итоговый расчёт (compute_lawsuit).
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
from typing import Dict, List, Optional, Tuple

from ..core.formatting import (
    fmt, parse_date_cell, parse_amount_cell, next_day,
    strip_number_prefix, parse_contract_ref,
)
from ..core.penalty import calc_group, fifo_allocate
from ..core.penalty_395 import calc_395
from ..core.duty import calculate_state_duty

try:
    import openpyxl
    _XL = True
except Exception:
    _XL = False


class LawsuitInputError(Exception):
    """Ошибка входных данных — показывается пользователю без traceback."""


# parse_contract_ref возвращает (full, number, date) — обёртка под старый вызов
def _parse_contract_ref_local(raw):
    return parse_contract_ref(raw)


def read_excel(path: str) -> List[dict]:
    """
    Читает Excel-реестр счетов. Колонки: 1-дата счёта, 2-номер счёта,
    3-договор ('номер от дата'), 4-сумма (со знаком; '-' = возврат/оплата,
    уменьшает долг по счёту с этим номером — логика частичной оплаты из
    «Калькулятора неустойки»), 5-срок оплаты.
    """
    if not _XL:
        raise LawsuitInputError(
            "Библиотека openpyxl не установлена.\n\nВыполните в терминале:\n"
            "    pip install openpyxl"
        )
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    rows: List[dict] = []
    for i, xrow in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        if not xrow or all(v is None for v in xrow[:5]):
            continue
        vals = (list(xrow) + [None] * 5)[:5]
        date_v, number_v, contract_v, amount_v, due_v = vals
        if date_v is None and number_v is None and amount_v is None:
            continue
        invoice_date = parse_date_cell(date_v)
        due_date = parse_date_cell(due_v)
        amount = parse_amount_cell(amount_v)
        number = strip_number_prefix(str(number_v).strip()) if number_v is not None else ""
        contract = str(contract_v).strip() if contract_v is not None else ""
        if amount is None or not number:
            raise LawsuitInputError(
                f"Строка {i} Excel-файла: не удалось распознать номер счёта "
                f"и/или сумму (номер={number_v!r}, сумма={amount_v!r})."
            )
        if invoice_date is None:
            raise LawsuitInputError(f"Строка {i} Excel-файла: не распознана дата счёта ({date_v!r}).")
        if due_date is None:
            raise LawsuitInputError(f"Строка {i} Excel-файла: не распознан срок оплаты ({due_v!r}).")
        rows.append({
            "row": i, "date": invoice_date, "number": number,
            "contract": contract, "amount": amount, "due_date": due_date,
        })
    if not rows:
        raise LawsuitInputError("В Excel-файле не найдено ни одной строки с данными.")
    return rows


def group_invoices(rows: List[dict], period_end: date) -> Tuple[List[dict], str, List[str]]:
    """
    Группирует положительные строки реестра по номеру счёта (это и есть
    счета, формирующие задолженность). Отрицательные строки (возвраты/
    частичные оплаты) собираются в общий пул и распределяются по принципу
    FIFO между ВСЕМИ счетами, отсортированными по дате начала просрочки —
    сначала гасится самый старый счёт, затем следующий и так далее
    (независимо от того, совпадает ли номер возврата с номером счёта).
    Датой платежа считается «срок оплаты» строки-возврата. Сами строки-
    возвраты при этом тоже попадают в общий список как отдельные позиции
    (display_only=True) — чтобы остаться видимыми в таблице со списком
    счетов в иске, хотя в детальном расчёте неустойки участвуют не сами,
    а через уменьшение остатка погашаемых ими счетов.
    """
    warnings: List[str] = []

    contracts = {r["contract"] for r in rows if r["contract"]}
    if len(contracts) > 1:
        raise LawsuitInputError(
            "В Excel-файле указаны разные договоры (" + ", ".join(sorted(contracts)) +
            "). Один запуск генератора рассчитан на одного ответчика по ОДНОМУ "
            "договору — проверьте данные."
        )
    contract_ref = next(iter(contracts), "")

    positive_rows = [r for r in rows if r["amount"] > 0]
    negative_rows = [r for r in rows if r["amount"] < 0]

    groups: Dict[str, List[dict]] = {}
    for r in positive_rows:
        groups.setdefault(r["number"], []).append(r)

    invoices: List[dict] = []
    for number, group_rows in groups.items():
        if len(group_rows) > 1:
            warnings.append(
                f"Счёт № {number} встречается в реестре {len(group_rows)} раз(а) — "
                f"суммы объединены в один счёт."
            )
        amount = sum((r["amount"] for r in group_rows), Decimal("0"))
        invoice_date = min(r["date"] for r in group_rows)
        due_date = min(r["due_date"] for r in group_rows)
        start = next_day(due_date, working=False)
        included = start <= period_end
        if not included:
            warnings.append(
                f"Счёт № {number} от {invoice_date.strftime('%d.%m.%Y')}: срок оплаты "
                f"{due_date.strftime('%d.%m.%Y')} ещё не наступил — не включён в иск."
            )

        invoices.append({
            "number": number, "invoice_date": invoice_date, "due_date": due_date,
            "amount": amount, "payments": [], "start": start, "included": included,
            "display_only": False,
        })

    included_invoices = [inv for inv in invoices if inv["included"]]
    payments = [(r["due_date"], abs(r["amount"])) for r in negative_rows]
    if payments and not included_invoices:
        total_return = sum((a for _d, a in payments), Decimal("0"))
        warnings.append(
            f"В реестре есть возврат(ы) на сумму {fmt(total_return)} руб., но нет "
            f"ни одного счёта с наступившим сроком оплаты — возврат не учтён."
        )
    else:
        warnings.extend(fifo_allocate(included_invoices, payments))

    # Сами строки-возвраты — отдельными позициями только для отображения
    # в таблице со списком счетов (в детальном расчёте неустойки участвуют
    # уже как уменьшение остатка погашаемых ими счетов, см. выше).
    neg_groups: Dict[str, List[dict]] = {}
    for r in negative_rows:
        neg_groups.setdefault(r["number"], []).append(r)
    for number, group_rows in neg_groups.items():
        amount = sum((r["amount"] for r in group_rows), Decimal("0"))
        invoice_date = min(r["date"] for r in group_rows)
        due_date = min(r["due_date"] for r in group_rows)
        invoices.append({
            "number": number, "invoice_date": invoice_date, "due_date": due_date,
            "amount": amount, "payments": [], "start": due_date, "included": True,
            "display_only": True,
        })

    invoices.sort(key=lambda x: (x["due_date"], x["number"]))
    return invoices, contract_ref, warnings


def compute_lawsuit(
    defendant: dict, invoices: List[dict], contract_ref: str,
    rate: Decimal, rate_text: str, cap_pct: Optional[Decimal], claim_date: date,
    pretenzia_number: str, pretenzia_date: date, postal_costs: Decimal,
    docs_signed: bool = True,
) -> dict:
    """Считает неустойку по каждому счёту через calc_group (логика «Калькулятора
    неустойки») — возвраты уже распределены по счетам по FIFO в group_invoices.
    Формирует итоговые суммы, применяет ограничение неустойки (если указано) и
    считает сумму госпошлины."""
    blocks = []
    total_debt = Decimal("0")
    total_penalty_raw = Decimal("0")
    period_starts = []
    table_rows = []

    for inv in invoices:
        if not inv["included"]:
            continue
        if inv.get("display_only"):
            # «Минусовой» возврат — показываем в таблице счетов, но отдельного
            # расчёта неустойки по нему не строим (он уже учтён через FIFO).
            table_rows.append({
                "invoice_date": inv["invoice_date"], "number": inv["number"],
                "amount": inv["amount"], "due_date": inv["due_date"],
            })
            continue

        rows, itogo, balance = calc_group(
            inv["amount"], inv["start"], claim_date, inv["payments"],
            rate, rate_text, False, False,
        )
        total_debt += balance
        total_penalty_raw += itogo
        period_starts.append(inv["start"])
        table_rows.append({
            "invoice_date": inv["invoice_date"], "number": inv["number"],
            "amount": inv["amount"], "due_date": inv["due_date"],
        })
        blocks.append({
            "month": inv["start"].strftime("%d.%m.%Y"),
            "nach": fmt(inv["amount"]),
            "rows": rows,
            "itogo": fmt(itogo),
        })

    if not blocks:
        raise LawsuitInputError(
            "Нет ни одного счёта с наступившим сроком оплаты — иск не может быть сформирован."
        )

    total_penalty = total_penalty_raw
    cap_info: Optional[Tuple[Decimal, Decimal, Decimal]] = None
    if cap_pct and cap_pct > 0:
        cap_value = (total_debt * cap_pct / Decimal(100)).quantize(Decimal("0.01"), ROUND_HALF_UP)
        if total_penalty_raw > cap_value:
            cap_info = (cap_pct, cap_value, total_penalty_raw)
            total_penalty = cap_value

    claim_amount = (total_debt + total_penalty).quantize(Decimal("0.01"), ROUND_HALF_UP)
    duty_amount = Decimal(str(calculate_state_duty(float(claim_amount))))
    period_start = min(period_starts)

    contract_full, _contract_number, contract_date = _parse_contract_ref_local(contract_ref)

    return {
        "blocks": blocks, "table_rows": table_rows,
        "total_debt": total_debt, "total_penalty": total_penalty,
        "cap_info": cap_info,
        "claim_amount": claim_amount, "duty_amount": duty_amount,
        "period_start": period_start, "claim_date": claim_date,
        "contract_ref": contract_full, "contract_date": contract_date,
        "rate": rate, "rate_text": rate_text,
        "defendant": defendant,
        "pretenzia_number": pretenzia_number, "pretenzia_date": pretenzia_date,
        "postal_costs": postal_costs,
        "docs_signed": docs_signed,
    }


def compute_lawsuit_395(
    defendant: dict, invoices: List[dict], contract_ref: str, claim_date: date,
    pretenzia_number: str, pretenzia_date: date, postal_costs: Decimal,
    history, docs_signed: bool = True,
) -> dict:
    """Считает проценты по ст. 395 ГК РФ для искового заявления.

    В отличие от договорной неустойки (compute_lawsuit) считает по единому
    хронологическому реестру ключевой ставки ЦБ (core.penalty_395.calc_395):
    положительные счета — это появления задолженности, отрицательные строки —
    погашения. history — история ключевой ставки (передаёт слой logic, чтобы
    importers не зависел от сети). Формирует контекст для генерации docx с
    признаком penalty_type="statutory_395" и строками таблицы rows_395."""
    debts = [
        (inv["start"], inv["amount"])
        for inv in invoices
        if inv["included"] and not inv.get("display_only")
    ]
    payments = [
        (inv["due_date"], -inv["amount"])
        for inv in invoices
        if inv.get("display_only")
    ]
    if not debts:
        raise LawsuitInputError(
            "Нет ни одного счёта с наступившим сроком оплаты — иск не может быть сформирован."
        )

    result = calc_395(debts, payments, claim_date, history)
    total_debt = result["total_principal"]
    total_penalty = result["total_interest"]
    claim_amount = (total_debt + total_penalty).quantize(Decimal("0.01"), ROUND_HALF_UP)
    duty_amount = Decimal(str(calculate_state_duty(float(claim_amount))))
    period_start = result["period_start"] or claim_date

    table_rows = [
        {
            "invoice_date": inv["invoice_date"], "number": inv["number"],
            "amount": inv["amount"], "due_date": inv["due_date"],
        }
        for inv in invoices if inv["included"]
    ]

    contract_full, _contract_number, contract_date = _parse_contract_ref_local(contract_ref)

    return {
        "penalty_type": "statutory_395",
        "rows_395": result["rows"],
        "table_rows": table_rows,
        "total_debt": total_debt, "total_penalty": total_penalty,
        "cap_info": None,
        "claim_amount": claim_amount, "duty_amount": duty_amount,
        "period_start": period_start, "claim_date": claim_date,
        "contract_ref": contract_full, "contract_date": contract_date,
        "defendant": defendant,
        "pretenzia_number": pretenzia_number, "pretenzia_date": pretenzia_date,
        "postal_costs": postal_costs,
        "docs_signed": docs_signed,
        "_warnings_calc": result["warnings"],
    }


# ── Генерация docx — Исковое заявление (с нуля, по образцу) ────────────

