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

from pypdf import PdfWriter

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

    def test_textual_month_with_full_suffix(self):
        """«23 июня 2025 года» → 23.06.2025."""
        self.assertEqual(_parse_date("23 июня 2025 года"), datetime(2025, 6, 23))

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

    def test_act_full_name(self):
        m = self._match("акт", "Акт приема-передачи № 206391 от 23.06.2025.pdf")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "206391")
        self.assertEqual(_parse_date(m.group(2)), datetime(2025, 6, 23))

    def test_act_short_name_with_prefix(self):
        """«Акт №…» без слов «приема-передачи»."""
        m = self._match("акт", "Печатная форма Акт №431237 от 07.09.26.pdf")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "431237")
        self.assertEqual(_parse_date(m.group(2)), datetime(2026, 9, 7))

    def test_act_reconciliation_is_not_act(self):
        """Акт сверки — не закрывающий документ, в индекс не попадает."""
        self.assertIsNone(self._match("акт", "Акт сверки № 15 от 01.09.26.pdf"))

    def test_textual_dates_for_every_document_type(self):
        """«23 июня 2025 г.», «… года» и без хвоста — у Счёта, Акта и УПД."""
        names = {
            "счет": "Счет на оплату № 65625 от 23 июня 2025{}.pdf",
            "акт":  "Акт приема-передачи № 206391 от 23 июня 2025{}.pdf",
            "упд":  "Печатная форма УПД №107867 от 23 июня 2025{}.pdf",
        }
        for doc_type, template in names.items():
            for suffix in (" г.", " г", " года", ""):
                name = template.format(suffix)
                with self.subTest(name=name):
                    m = self._match(doc_type, name)
                    self.assertIsNotNone(m)
                    self.assertEqual(_parse_date(m.group(2)), datetime(2025, 6, 23))


class InvoiceTextTests(unittest.TestCase):
    """Разбор описания счёта из 1С."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.sorter = DocumentSorter(
            source_folder=self.temp_dir,
            output_folder=os.path.join(self.temp_dir, "out"),
            log_callback=lambda *a, **k: None,
        )

    def test_short_act_line(self):
        invoices = self.sorter.parse_invoice_info(
            "Счет на оплату № 70001 от 08.09.26 на сумму 1 000 рублей\n"
            "1. Акт №431237 от 07.09.26\n"
            "2. Акт приема-передачи № 206391 от 23.06.2025"
        )
        self.assertEqual(len(invoices), 1)
        self.assertEqual(invoices[0]["related_documents"], [
            {"type": "акт", "number": "431237", "date": "07.09.26"},
            {"type": "акт", "number": "206391", "date": "23.06.2025"},
        ])

    def test_textual_dates_for_every_document_type(self):
        """Текстовые даты в описании: с «г.», с «года» и без хвоста."""
        for suffix in (" г.", " года", ""):
            with self.subTest(suffix=suffix):
                invoices = self.sorter.parse_invoice_info(
                    f"Счет на оплату № 65625 от 24 июня 2025{suffix} на сумму 40 480 рублей\n"
                    f"1. Акт приема-передачи № 206391 от 23 июня 2025{suffix}\n"
                    f"2. УПД № 107867 от 23 июня 2025{suffix}"
                )
                self.assertEqual(len(invoices), 1)
                self.assertEqual(invoices[0]["invoice_number"], "65625")
                self.assertEqual(
                    _parse_date(invoices[0]["invoice_date"]), datetime(2025, 6, 24))
                self.assertEqual(invoices[0]["related_documents"], [
                    {"type": "акт", "number": "206391", "date": "23 июня 2025"},
                    {"type": "упд", "number": "107867", "date": "23 июня 2025"},
                ])

    def test_dotted_date_keeps_trailing_text_out(self):
        """Точка в конце строки и «г.» после цифровой даты в дату не попадают."""
        invoices = self.sorter.parse_invoice_info(
            "Счет на оплату № 65625 от 24.06.2025 г. на сумму 40 480 рублей\n"
            "1. Акт № 206391 от 23.06.2025."
        )
        self.assertEqual(invoices[0]["invoice_date"], "24.06.2025")
        self.assertEqual(invoices[0]["related_documents"][0]["date"], "23.06.2025")


class IndexMatchingTests(unittest.TestCase):
    """Индекс папки сопоставляет описание 1С с файлами обоих форматов."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        # Счёт с текстовой датой + УПД без префикса — «новые» форматы.
        for name in (
            "Счет на оплату № 24243 от 02 марта 2026 г.pdf",
            "УПД №29731 от 02.03.26.pdf",
            "Печатная форма Акт №431237 от 02.03.26.pdf",
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
        # Короткий «Акт №…» находится по полному названию из 1С.
        self.assertIsNotNone(sorter.find_file("акт", "431237", "02.03.2026"))
        # Текстовая дата из 1С находит файлы с цифровой датой.
        self.assertIsNotNone(sorter.find_file("упд", "29731", "2 марта 2026"))


class PackageNameTests(unittest.TestCase):
    """Имя собранного пакета не зависит от записи даты в 1С."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        # Пакет реально сливается, поэтому нужен настоящий одностраничный PDF.
        writer = PdfWriter()
        writer.add_blank_page(595, 842)
        with open(Path(self.temp_dir, "Счет на оплату № 65625 от 24 июня 2025 г..pdf"), "wb") as f:
            writer.write(f)
        self.sorter = DocumentSorter(
            source_folder=self.temp_dir,
            output_folder=os.path.join(self.temp_dir, "out"),
            log_callback=lambda *a, **k: None,
        )

    def _package_name(self, description: str) -> str:
        invoice = self.sorter.parse_invoice_info(description)[0]
        return Path(self.sorter.create_invoice_package(invoice)["output_file"]).name

    def test_textual_date_gives_digits(self):
        self.assertEqual(
            self._package_name("Счет на оплату № 65625 от 24 июня 2025 года"),
            "Счет_65625_от_24-06-2025_полный_пакет.pdf",
        )

    def test_dotted_date_unchanged(self):
        self.assertEqual(
            self._package_name("Счет на оплату № 65625 от 24.06.2025"),
            "Счет_65625_от_24-06-2025_полный_пакет.pdf",
        )


if __name__ == "__main__":
    unittest.main()
