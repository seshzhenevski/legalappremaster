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
    parse_required_decimal,
    generate_lawsuit_package,
)
from legal_tools.importers.excel import LawsuitInputError


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

    def test_parse_optional_decimal_accepts_comma(self):
        """Запятая как десятичный разделитель (RU-локаль) распознаётся."""
        self.assertEqual(parse_optional_decimal("0,5"), Decimal("0.5"))

    def test_parse_optional_decimal_invalid_raises(self):
        """Нечисловое значение даёт понятную ошибку, а не сырой ConversionSyntax."""
        with self.assertRaises(LawsuitInputError):
            parse_optional_decimal("abc")

    def test_parse_required_decimal_accepts_comma_and_spaces(self):
        """Сумма с запятой и пробелом-разрядом распознаётся."""
        self.assertEqual(parse_required_decimal("1 500,50", "0"), Decimal("1500.50"))

    def test_parse_required_decimal_empty_uses_default(self):
        """Пустое значение подставляет значение по умолчанию."""
        self.assertEqual(parse_required_decimal("", "0"), Decimal("0"))
        self.assertEqual(parse_required_decimal(None, "0.1"), Decimal("0.1"))


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

    def test_statutory_395_generates_files(self):
        """Режим ст. 395 ГК РФ генерирует пакет и считает по ключевой ставке ЦБ.

        check_rate_online=False — без обращения к сети (по сохранённой истории).
        """
        request = self.build_valid_request()
        request["penalty_type"] = "statutory_395"
        request["check_rate_online"] = False
        result = generate_lawsuit_package(request)
        self.assertEqual(len(result["created_files"]), 3)
        for file_path in result["created_files"]:
            self.assertTrue(os.path.exists(file_path))
        # Долг совпадает с суммой счёта; проценты > 0 (просрочка есть).
        self.assertEqual(result["total_debt"], "51 638,00")
        self.assertNotEqual(result["total_penalty"], "0,00")

    def test_comma_separated_inputs_do_not_crash(self):
        """Поля со значениями через запятую (RU-локаль) не роняют генерацию.

        Регрессия на ошибку decimal.ConversionSyntax: поля «Почтовые
        расходы», «Процент неустойки» и «ограничение» имеют тип text, и
        пользователь вводит «0,2» / «150,50» — раньше это падало.
        """
        request = self.build_valid_request()
        request["daily_rate_percent"] = "0,2"
        request["postal_costs"] = "150,50"
        request["cap_percent"] = "10,5"
        result = generate_lawsuit_package(request)
        self.assertEqual(len(result["created_files"]), 3)


if __name__ == "__main__":
    unittest.main()
