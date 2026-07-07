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
