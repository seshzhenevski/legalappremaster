# -*- coding: utf-8 -*-
"""Юнит-тесты слоя логики: расчёт государственной пошлины."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import unittest

from logic.state_duty_calculator import calculate_duty_for_claim_amount


class StateDutyCalculatorTests(unittest.TestCase):
    """Проверки расчёта госпошлины по ст. 333.21 НК РФ."""

    def test_duty_for_amount_up_to_100k_is_fixed(self):
        """Для суммы до 100 000 руб. пошлина фиксированная — 10 000 руб."""
        result = calculate_duty_for_claim_amount(50_000)
        self.assertEqual(result["duty_amount"], 10_000.0)

    def test_duty_at_five_million(self):
        """Для 5 000 000 руб. пошлина составляет 175 000 руб."""
        result = calculate_duty_for_claim_amount(5_000_000)
        self.assertEqual(result["duty_amount"], 175_000.0)

    def test_duty_rounds_kopecks_below_fifty_down(self):
        """Копейки меньше 50 отбрасываются при округлении до рубля."""
        result = calculate_duty_for_claim_amount(100_009)
        self.assertEqual(result["duty_amount"], 10_000.0)

    def test_duty_rounds_kopecks_from_fifty_up(self):
        """Копейки 50 и больше округляются вверх до целого рубля."""
        result = calculate_duty_for_claim_amount(100_010)
        self.assertEqual(result["duty_amount"], 10_001.0)

    def test_result_contains_amount_in_words(self):
        """Результат содержит сумму пошлины прописью."""
        result = calculate_duty_for_claim_amount(50_000)
        self.assertIn("рублей", result["duty_amount_in_words"])

    def test_zero_amount_raises_error(self):
        """Нулевая цена иска приводит к ошибке."""
        with self.assertRaises(ValueError):
            calculate_duty_for_claim_amount(0)


if __name__ == "__main__":
    unittest.main()
