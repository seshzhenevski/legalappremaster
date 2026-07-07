# -*- coding: utf-8 -*-
"""Юнит-тесты слоя логики: сборка имени компании и извлечение реквизитов."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import unittest

from logic.company_lookup import (
    build_company_display_name,
    extract_company_details_from_suggestion,
)


class CompanyDisplayNameTests(unittest.TestCase):
    """Проверки сборки короткого наименования компании."""

    def test_wraps_short_name_with_form_and_guillemets(self):
        """Краткое имя оборачивается формой и ёлочками: ООО «Концерн ОТ»."""
        self.assertEqual(
            build_company_display_name("Концерн ОТ", "ООО"),
            "ООО «Концерн ОТ»",
        )

    def test_strips_existing_quotes_before_wrapping(self):
        """Существующие кавычки убираются перед обёрткой в ёлочки."""
        self.assertEqual(
            build_company_display_name('"Ромашка"', "АО"),
            "АО «Ромашка»",
        )

    def test_without_legal_form_only_guillemets(self):
        """Без формы собственности имя оборачивается только ёлочками."""
        self.assertEqual(
            build_company_display_name("Тест", ""),
            "«Тест»",
        )

    def test_empty_name_returns_empty_string(self):
        """Пустое имя даёт пустую строку."""
        self.assertEqual(build_company_display_name("", "ООО"), "")


class CompanyDetailsExtractionTests(unittest.TestCase):
    """Проверки извлечения реквизитов из ответа DaData."""

    def test_extracts_all_fields_from_suggestion(self):
        """Из ответа DaData извлекаются имя, ОГРН, ИНН, КПП и адрес."""
        suggestion = {
            "value": "ООО ГИТИ",
            "data": {
                "name": {"short": "ГИТИ"},
                "opf": {"short": "ООО"},
                "ogrn": "1127747255349",
                "inn": "7710929008",
                "kpp": "771001001",
                "address": {"unrestricted_value": "г. Москва, ул. Тест, 1"},
            },
        }
        details = extract_company_details_from_suggestion(suggestion)
        self.assertEqual(details["name"], "ООО «ГИТИ»")
        self.assertEqual(details["ogrn"], "1127747255349")
        self.assertEqual(details["inn"], "7710929008")
        self.assertEqual(details["kpp"], "771001001")
        self.assertEqual(details["address"], "г. Москва, ул. Тест, 1")


if __name__ == "__main__":
    unittest.main()
