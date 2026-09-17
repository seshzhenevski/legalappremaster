# -*- coding: utf-8 -*-
"""
Интеграционные тесты контракта JSON-RPC между Tauri (Rust) и Python.

Проверяют, что формат запроса, который формирует Rust (build_request_line),
понимается Python, а формат ответа Python корректно разбирается Rust.
Эти тесты защищают границу между слоями от рассогласования.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import json
import unittest

from main import process_single_request


class RustPythonContractTests(unittest.TestCase):
    """Проверки совместимости формата запросов и ответов Rust ↔ Python."""

    def test_rust_style_request_is_understood(self):
        """Запрос в формате Rust build_request_line обрабатывается Python."""
        # Точная копия структуры, которую формирует Rust.
        rust_request = json.dumps({
            "id": 1,
            "method": "calculate_state_duty",
            "params": {"claim_amount": 5_000_000},
        })
        response = json.loads(process_single_request(rust_request))
        self.assertEqual(response["id"], 1)
        self.assertEqual(response["result"]["duty_amount"], 175_000.0)

    def test_response_is_valid_json_for_rust_parsing(self):
        """Ответ Python — валидный JSON, который Rust сможет разобрать."""
        request = json.dumps({
            "id": 1,
            "method": "calculate_state_duty",
            "params": {"claim_amount": 100_000},
        })
        response_line = process_single_request(request)
        # Если строка парсится без исключения — Rust parse_response_line тоже справится.
        parsed = json.loads(response_line)
        self.assertIn("result", parsed)

    def test_knowledge_base_method_through_contract(self):
        """Метод load_knowledge_base работает через контракт Rust ↔ Python."""
        import tempfile

        with tempfile.TemporaryDirectory() as base_directory:
            request = json.dumps({
                "id": 1,
                "method": "load_knowledge_base",
                "params": {"root_path": base_directory},
            })
            response = json.loads(process_single_request(request))

        self.assertNotIn("error", response)
        self.assertTrue(response["result"]["available"])
        self.assertEqual(response["result"]["articles"], [])

    def test_missing_knowledge_base_folder_is_not_an_error(self):
        """Недоступная папка базы возвращается признаком, а не ошибкой RPC."""
        request = json.dumps({
            "id": 1,
            "method": "load_knowledge_base",
            "params": {"root_path": "Z:/нет такой папки/база"},
        })
        response = json.loads(process_single_request(request))

        self.assertNotIn("error", response)
        self.assertFalse(response["result"]["available"])

    def test_every_knowledge_base_method_is_wired(self):
        """
        Каждый зарегистрированный метод базы знаний действительно вызывается.

        Ошибка вида «name ... is not defined» возникает, когда обработчик
        написан, но нужная функция логики не попала в импорты диспетчера:
        модуль при этом импортируется без нареканий, а падает только при
        обращении к методу. Юнит-тесты логики такое не ловят по определению.
        """
        import tempfile
        from rpc.dispatcher import METHOD_HANDLERS

        with tempfile.TemporaryDirectory() as base:
            # Заготовки: создаём раздел и статью, чтобы методам было с чем работать.
            article = json.loads(process_single_request(json.dumps({
                "id": 1, "method": "create_kb_article",
                "params": {"root_path": base, "folder_relative_path": "Раздел",
                           "title": "Проверка"},
            })))["result"]

            parameters = {
                "load_knowledge_base": {"root_path": base},
                "read_kb_article": {"root_path": base,
                                    "relative_path": article["relative_path"]},
                "save_kb_article": {"root_path": base,
                                    "relative_path": article["relative_path"],
                                    "properties": {"id": article["id"],
                                                   "title": "Проверка"},
                                    "body": "Текст"},
                "create_kb_article": {"root_path": base,
                                      "folder_relative_path": "Раздел",
                                      "title": "Ещё одна"},
                "acquire_kb_lock": {"root_path": base, "article_id": article["id"]},
                "release_kb_lock": {"root_path": base, "article_id": article["id"]},
                "check_kb_lock": {"root_path": base, "article_id": article["id"]},
                "list_kb_versions": {"root_path": base, "article_id": article["id"]},
                "list_kb_trash": {"root_path": base},
                "move_kb_article": {"root_path": base,
                                    "relative_path": article["relative_path"],
                                    "target_folder_relative_path": ""},
                "create_kb_folder": {"root_path": base, "parent_relative_path": "",
                                     "folder_name": "Новый раздел"},
                "rename_kb_folder": {"root_path": base,
                                     "folder_relative_path": "Новый раздел",
                                     "new_name": "Переименованный"},
                "delete_kb_folder": {"root_path": base,
                                     "folder_relative_path": "Переименованный"},
            }

            kb_methods = [name for name in METHOD_HANDLERS
                          if "kb" in name or "knowledge" in name]
            unchecked = [name for name in kb_methods if name not in parameters]

            for method_name, params in parameters.items():
                self.assertIn(method_name, METHOD_HANDLERS, method_name)
                response = json.loads(process_single_request(json.dumps({
                    "id": 1, "method": method_name, "params": params,
                }, ensure_ascii=False)))
                error = response.get("error", "")
                self.assertNotIn("is not defined", error,
                                 f"{method_name}: {error}")

        # Методы, требующие особой подготовки, проверяются отдельными тестами;
        # список ниже нужен, чтобы новый метод не остался вовсе без проверки.
        self.assertEqual(sorted(unchecked), [
            "delete_kb_article", "purge_kb_trash_entry",
            "read_kb_version", "restore_kb_trash_entry", "restore_kb_version",
        ])

    def test_penalty_method_through_contract(self):
        """Метод calculate_penalty работает через контракт Rust ↔ Python."""
        request = json.dumps({
            "id": 1,
            "method": "calculate_penalty",
            "params": {
                "debts": [{"amount": "100000", "start_date": "2026-01-01"}],
                "payments": [],
                "period_end_date": "2026-01-11",
                "daily_rate_percent": "0.1",
            },
        })
        response = json.loads(process_single_request(request))
        self.assertEqual(response["result"]["total_penalty"], "1 100,00")

    def test_error_response_shape_for_rust(self):
        """Ошибка возвращается в поле error — Rust отличит её от result."""
        request = json.dumps({
            "id": 1,
            "method": "unknown_method",
            "params": {},
        })
        response = json.loads(process_single_request(request))
        self.assertIn("error", response)
        self.assertNotIn("result", response)


if __name__ == "__main__":
    unittest.main()
