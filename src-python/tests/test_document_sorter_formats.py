# -*- coding: utf-8 -*-
"""Юнит-тесты распознавания форматов имён Счёт/УПД/Акт в сортировщике.

Регрессия на Задачу 2 из «Правки.pdf»: счета и УПД встречаются в двух
вариантах именования, оба должны корректно читаться при сортировке.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import os
import tempfile
import unittest
from datetime import datetime

from legal_tools.importers.document_sorter import DocumentSorter, _parse_date


class ParseDateTests(unittest.TestCase):
    """Разбор дат из имён файлов в разных форматах."""

    def test_dotted_full_year(self):
        self.assertEqual(_parse_date("25.02.2026"), datetime(2026, 2, 25))

    def test_dotted_short_year(self):
        self.assertEqual(_parse_date("28.02.25"), datetime(2025, 2, 28))

    def test_textual_month_with_suffix(self):
        """«02 марта 2026 г.» → 02.03.2026."""
        self.assertEqual(_parse_date("02 марта 2026 г."), datetime(2026, 3, 2))

    def test_textual_month_without_suffix(self):
        self.assertEqual(_parse_date("2 марта 2026"), datetime(2026, 3, 2))

    def test_textual_and_dotted_match(self):
        """Одна дата в текстовой и точечной записи даёт одно значение."""
        self.assertEqual(_parse_date("02 марта 2026 г."), _parse_date("02.03.2026"))

    def test_unknown_returns_none(self):
        self.assertIsNone(_parse_date("не дата"))


class FilenamePatternTests(unittest.TestCase):
    """Шаблоны имён файлов ловят оба варианта Счёт/УПД."""

    def _match(self, doc_type: str, filename: str):
        return DocumentSorter._PATTERNS[doc_type].search(filename)

    def test_invoice_dotted(self):
        m = self._match("счет", "Счет на оплату № 22642 от 25.02.2026.pdf")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "22642")
        self.assertEqual(_parse_date(m.group(2)), datetime(2026, 2, 25))

    def test_invoice_textual_date(self):
        m = self._match("счет", "Счет на оплату № 24243 от 02 марта 2026 г.pdf")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "24243")
        self.assertEqual(_parse_date(m.group(2)), datetime(2026, 3, 2))

    def test_upd_without_prefix(self):
        m = self._match("упд", "УПД №29731 от 28.02.25.pdf")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "29731")
        self.assertEqual(_parse_date(m.group(2)), datetime(2025, 2, 28))

    def test_upd_with_prefix(self):
        m = self._match("упд", "Печатная форма УПД №242371 от 02.12.25.pdf")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "242371")
        self.assertEqual(_parse_date(m.group(2)), datetime(2025, 12, 2))


class IndexMatchingTests(unittest.TestCase):
    """Индекс папки сопоставляет описание 1С с файлами обоих форматов."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        # Счёт с текстовой датой + УПД без префикса — «новые» форматы.
        for name in (
            "Счет на оплату № 24243 от 02 марта 2026 г.pdf",
            "УПД №29731 от 02.03.26.pdf",
        ):
            Path(self.temp_dir, name).write_bytes(b"%PDF-1.4\n%%EOF\n")

    def test_finds_both_formats_via_1c_text(self):
        sorter = DocumentSorter(
            source_folder=self.temp_dir,
            output_folder=os.path.join(self.temp_dir, "out"),
            log_callback=lambda *a, **k: None,
        )
        # Файл счёта с текстовой датой находится по точечной дате из 1С.
        self.assertIsNotNone(sorter.find_file("счет", "24243", "02.03.2026"))
        # Файл УПД без префикса «Печатная форма» тоже проиндексирован.
        self.assertIsNotNone(sorter.find_file("упд", "29731", "02.03.2026"))


if __name__ == "__main__":
    unittest.main()
