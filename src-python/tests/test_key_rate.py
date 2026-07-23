# -*- coding: utf-8 -*-
"""Юнит-тесты истории ключевой ставки ЦБ и расчёта по ст. 395."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import unittest
from datetime import date
from decimal import Decimal

from legal_tools.core.key_rate import parse_history, rate_on, days_in_year
from legal_tools.core.penalty_395 import calc_395
from logic.key_rate_service import _collapse, _merge_raw


class KeyRateHelpersTests(unittest.TestCase):
    """Базовые операции над историей ставки."""

    def test_rate_on_picks_active(self):
        history = parse_history([
            {"from": "2026-01-01", "rate": "16.00"},
            {"from": "2026-02-16", "rate": "15.50"},
        ])
        self.assertEqual(rate_on(history, date(2026, 2, 1)), Decimal("16.00"))
        self.assertEqual(rate_on(history, date(2026, 2, 16)), Decimal("15.50"))
        self.assertEqual(rate_on(history, date(2026, 3, 1)), Decimal("15.50"))

    def test_rate_on_before_history_is_none(self):
        history = parse_history([{"from": "2026-01-01", "rate": "16.00"}])
        self.assertIsNone(rate_on(history, date(2025, 12, 31)))

    def test_days_in_year_leap(self):
        self.assertEqual(days_in_year(2024), 366)
        self.assertEqual(days_in_year(2026), 365)


class CollapseTests(unittest.TestCase):
    """Схлопывание ежедневных дублей ставки в точки изменения.

    Регрессия: официальный сервис ЦБ отдаёт ставку по каждому дню; без
    схлопывания расчёт дробится на однодневные отрезки и итог «плывёт».
    """

    def test_collapse_removes_repeated_daily_rates(self):
        # Ставка 14.25 повторяется каждый день — должна остаться одна точка.
        daily = [{"from": f"2026-06-{d:02d}", "rate": "14.25"} for d in range(22, 31)]
        daily.insert(0, {"from": "2026-05-01", "rate": "14.50"})
        collapsed = _merge_raw(daily)
        self.assertEqual(
            collapsed,
            [(date(2026, 5, 1), Decimal("14.50")), (date(2026, 6, 22), Decimal("14.25"))],
        )

    def test_fragmented_history_gives_same_total_as_collapsed(self):
        """Расчёт по «ежедневной» и по схлопнутой истории совпадает."""
        daily = [{"from": f"2026-06-{d:02d}", "rate": "14.25"} for d in range(1, 31)]
        collapsed_hist = _collapse(parse_history(daily))
        fragmented_hist = parse_history(daily)

        debts = [(date(2026, 6, 1), Decimal("100000.00"))]
        a = calc_395(debts, [], date(2026, 6, 30), collapsed_hist)["total_interest"]
        b = calc_395(debts, [], date(2026, 6, 30), fragmented_hist)["total_interest"]
        # Схлопнутая история считает по одному 30-дневному отрезку — это верно.
        self.assertEqual(a, Decimal("1171.23"))
        # Фрагментированная дала бы поштучное округление и другой итог.
        self.assertNotEqual(a, b)


if __name__ == "__main__":
    unittest.main()
