# -*- coding: utf-8 -*-
"""Юнит-тесты слоя логики: сортировка и сборка пакетов документов."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import unittest

from logic.document_sorter_service import (
    collect_log_messages,
    sort_documents_into_packages,
)


class DocumentSorterImportTests(unittest.TestCase):
    """Проверка, что сортировщик импортируется и создаётся без ошибок."""

    def test_sorter_service_imports_cleanly(self):
        """Модуль сортировщика импортируется без отсутствующих зависимостей."""
        # Сам факт успешного импорта вверху файла — уже проверка.
        # Дополнительно убеждаемся, что DocumentSorter доступен.
        from legal_tools.importers.document_sorter import DocumentSorter
        self.assertTrue(callable(DocumentSorter))


class LogCollectionTests(unittest.TestCase):
    """Проверки накопления сообщений лога от ядра сортировщика."""

    def test_callback_appends_messages_to_list(self):
        """Колбэк добавляет переданные строки в список сообщений."""
        messages, append = collect_log_messages()
        append("Первое сообщение")
        append("Второе сообщение")
        self.assertEqual(messages, ["Первое сообщение", "Второе сообщение"])

    def test_callback_ignores_tag_argument(self):
        """Колбэк принимает необязательный тег, но пишет только текст."""
        messages, append = collect_log_messages()
        append("Сообщение с тегом", tag="warn")
        self.assertEqual(messages, ["Сообщение с тегом"])

    def test_empty_at_start(self):
        """Список сообщений изначально пуст."""
        messages, _ = collect_log_messages()
        self.assertEqual(messages, [])


if __name__ == "__main__":
    unittest.main()
