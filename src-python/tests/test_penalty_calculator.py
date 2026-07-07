# -*- coding: utf-8 -*-
"""Юнит-тесты слоя логики: расчёт неустойки."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import unittest
from datetime import date
from decimal import Decimal

from logic.penalty_calculator import (
    parse_iso_date,
    build_debt_records_from_input,
    build_payment_pairs_from_input,
    calculate_penalty_for_debts,
)


class DateParsingTests(unittest.TestCase):
    """Проверки преобразования ISO-дат из формы."""

    def test_parse_iso_date_returns_correct_date(self):
        """Строка ГГГГ-ММ-ДД преобразуется в правильный объект date."""
        self.assertEqual(parse_iso_date("2026-04-04"), date(2026, 4, 4))


class DebtRecordBuilderTests(unittest.TestCase):
    """Проверки построения записей о задолженностях из формы."""

    def test_builds_decimal_amount_and_date(self):
        """Сумма становится Decimal, дата — объектом date, платежи пусты."""
        records = build_debt_records_from_input(
            [{"amount": "51638.00", "start_date": "2026-04-04"}]
        )
        self.assertEqual(records[0]["amount"], Decimal("51638.00"))
        self.assertEqual(records[0]["start"], date(2026, 4, 4))
        self.assertEqual(records[0]["payments"], [])


class PaymentPairBuilderTests(unittest.TestCase):
    """Проверки построения списка платежей из формы."""

    def test_builds_date_and_decimal_tuple(self):
        """Каждый платёж превращается в кортеж (date, Decimal)."""
        pairs = build_payment_pairs_from_input(
            [{"amount": "46638.00", "date": "2026-04-07"}]
        )
        self.assertEqual(pairs[0], (date(2026, 4, 7), Decimal("46638.00")))


class PenaltyCalculationTests(unittest.TestCase):
    """Проверки итогового расчёта неустойки с FIFO-распределением."""

    def test_single_debt_without_payments(self):
        """Одна задолженность без оплат: долг остаётся полным."""
        result = calculate_penalty_for_debts(
            debts_input=[{"amount": "100000", "start_date": "2026-01-01"}],
            payments_input=[],
            period_end_date="2026-01-11",
            daily_rate_percent="0.1",
        )
        self.assertEqual(result["total_debt"], "100 000,00")
        # Период 01.01–11.01 включительно = 11 дней.
        # 100000 * 0.1% * 11 = 1100
        self.assertEqual(result["total_penalty"], "1 100,00")

    def test_payment_reduces_debt_via_fifo(self):
        """Оплата гасит самую старую задолженность (FIFO)."""
        result = calculate_penalty_for_debts(
            debts_input=[
                {"amount": "50000", "start_date": "2026-01-01"},
                {"amount": "30000", "start_date": "2026-02-01"},
            ],
            payments_input=[{"amount": "50000", "date": "2026-03-01"}],
            period_end_date="2026-03-01",
            daily_rate_percent="0.1",
        )
        # Первый долг (50000) полностью погашен, остаётся только второй (30000)
        self.assertEqual(result["total_debt"], "30 000,00")

    def test_result_contains_calculation_blocks(self):
        """Результат содержит детальные блоки расчёта по задолженностям."""
        result = calculate_penalty_for_debts(
            debts_input=[{"amount": "100000", "start_date": "2026-01-01"}],
            payments_input=[],
            period_end_date="2026-01-11",
            daily_rate_percent="0.1",
        )
        self.assertEqual(len(result["blocks"]), 1)
        self.assertEqual(result["blocks"][0]["initial_amount"], "100 000,00")


if __name__ == "__main__":
    unittest.main()
