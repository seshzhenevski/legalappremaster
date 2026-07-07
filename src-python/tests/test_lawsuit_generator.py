# -*- coding: utf-8 -*-
"""Юнит-тесты слоя логики: генерация пакета документов по иску."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import os
import tempfile
import unittest
from datetime import date
from decimal import Decimal

import openpyxl

from logic.lawsuit_generator import (
    parse_iso_date,
    parse_optional_decimal,
    generate_lawsuit_package,
)


class DateAndDecimalParsingTests(unittest.TestCase):
    """Проверки вспомогательных преобразований генератора иска."""

    def test_parse_iso_date(self):
        """Строка ГГГГ-ММ-ДД становится объектом date."""
        self.assertEqual(parse_iso_date("2026-06-01"), date(2026, 6, 1))

    def test_parse_optional_decimal_with_value(self):
        """Непустая строка превращается в Decimal."""
        self.assertEqual(parse_optional_decimal("15"), Decimal("15"))

    def test_parse_optional_decimal_empty_returns_none(self):
        """Пустая строка даёт None (ограничение неустойки не задано)."""
        self.assertIsNone(parse_optional_decimal(""))

    def test_parse_optional_decimal_none_returns_none(self):
        """Отсутствующее значение даёт None."""
        self.assertIsNone(parse_optional_decimal(None))


class LawsuitPackageGenerationTests(unittest.TestCase):
    """Проверки полной генерации пакета документов по иску."""

    def setUp(self):
        """Создаёт временный Excel-реестр и папку вывода для теста."""
        self.temp_dir = tempfile.mkdtemp()
        self.output_dir = os.path.join(self.temp_dir, "out")
        os.makedirs(self.output_dir, exist_ok=True)

        self.excel_path = os.path.join(self.temp_dir, "registry.xlsx")
        workbook = openpyxl.Workbook()
        sheet = workbook.active
        sheet.append(["Дата", "Номер", "Договор", "Сумма", "Срок оплаты"])
        sheet.append(
            ["20.03.2026", "034509", "1002/25 от 10.02.2025", 51638.00, "03.04.2026"]
        )
        workbook.save(self.excel_path)

    def build_valid_request(self) -> dict:
        """Возвращает корректный запрос на генерацию иска для тестов."""
        return {
            "defendant": {
                "name": "ООО «Тест»",
                "inn": "7710929008",
                "ogrn": "1127747255349",
                "address": "г. Москва",
            },
            "excel_path": self.excel_path,
            "output_dir": self.output_dir,
            "claim_date": "2026-06-01",
            "daily_rate_percent": "0.2",
            "cap_percent": "",
            "pretenzia_number": "1",
            "pretenzia_date": "2026-04-08",
            "postal_costs": "500",
            "docs_signed": True,
        }

    def test_generates_three_files(self):
        """Генерация создаёт три файла: пошлину, иск и опись."""
        result = generate_lawsuit_package(self.build_valid_request())
        self.assertEqual(len(result["created_files"]), 3)
        for file_path in result["created_files"]:
            self.assertTrue(os.path.exists(file_path))

    def test_returns_total_debt(self):
        """Результат содержит отформатированную сумму долга."""
        result = generate_lawsuit_package(self.build_valid_request())
        self.assertEqual(result["total_debt"], "51 638,00")


if __name__ == "__main__":
    unittest.main()
