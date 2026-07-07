# -*- coding: utf-8 -*-
"""
Слой логики: импорт задолженностей и платежей из Excel для вкладки
«Калькулятор неустойки».

Переиспользует тот же Excel-реестр, что и генератор иска (см.
legal_tools.importers.excel.read_excel): колонка 4 — сумма (со знаком;
положительная — задолженность, отрицательная — платёж/возврат), колонка
5 — срок оплаты. Дата начала просрочки — срок оплаты + 1 календарный день
(тот же принцип, что уже применяется в group_invoices для генератора иска).
"""
from __future__ import annotations

from typing import List

from legal_tools.core.formatting import next_day
from legal_tools.importers.excel import read_excel, LawsuitInputError


class PenaltyExcelImportError(Exception):
    """Ошибка входных данных — показывается пользователю без traceback."""


def import_debts_and_payments_from_excel(path: str) -> dict:
    """
    Читает Excel-реестр и превращает его строки в задолженности и платежи.

    Принимает путь к файлу. Возвращает словарь со списками debts (amount,
    start_date) и payments (amount, date) в ISO-формате дат, пригодный для
    прямой передачи в расчёт неустойки. Сумма берётся из колонки 4, дата
    начала просрочки — срок оплаты (колонка 5) плюс 1 календарный день.
    """
    try:
        rows = read_excel(path)
    except LawsuitInputError as error:
        raise PenaltyExcelImportError(str(error))

    debts: List[dict] = []
    payments: List[dict] = []

    for row in rows:
        amount = row["amount"]
        due_date = row["due_date"]

        if amount > 0:
            start_date = next_day(due_date, working=False)
            debts.append({"amount": str(amount), "start_date": start_date.isoformat()})
        elif amount < 0:
            payments.append({"amount": str(abs(amount)), "date": due_date.isoformat()})

    if not debts and not payments:
        raise PenaltyExcelImportError(
            "В Excel-файле не найдено ни одной строки с данными."
        )

    return {"debts": debts, "payments": payments}
