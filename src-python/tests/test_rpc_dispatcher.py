# -*- coding: utf-8 -*-
"""Юнит-тесты слоя RPC: диспетчер методов и обработка запросов sidecar."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import json
import unittest

from rpc.dispatcher import dispatch_rpc_method
from main import process_single_request


class RpcDispatcherTests(unittest.TestCase):
    """Проверки маршрутизации методов RPC."""

    def test_dispatches_state_duty_method(self):
        """Метод calculate_state_duty вызывает расчёт госпошлины."""
        result = dispatch_rpc_method(
            "calculate_state_duty", {"claim_amount": 5_000_000}
        )
        self.assertEqual(result["duty_amount"], 175_000.0)

    def test_unknown_method_raises_error(self):
        """Неизвестный метод приводит к ошибке ValueError."""
        with self.assertRaises(ValueError):
            dispatch_rpc_method("nonexistent_method", {})


class SidecarRequestProcessingTests(unittest.TestCase):
    """Проверки обработки одиночного запроса sidecar (stdin → stdout)."""

    def test_successful_request_returns_result(self):
        """Корректный запрос возвращает ответ с полем result."""
        request_line = json.dumps({
            "id": 1,
            "method": "calculate_state_duty",
            "params": {"claim_amount": 5_000_000},
        })
        response = json.loads(process_single_request(request_line))
        self.assertEqual(response["id"], 1)
        self.assertEqual(response["result"]["duty_amount"], 175_000.0)

    def test_invalid_method_returns_error_field(self):
        """Запрос с неизвестным методом возвращает ответ с полем error."""
        request_line = json.dumps({
            "id": 2,
            "method": "bad_method",
            "params": {},
        })
        response = json.loads(process_single_request(request_line))
        self.assertEqual(response["id"], 2)
        self.assertIn("error", response)

    def test_malformed_json_returns_error(self):
        """Некорректный JSON не роняет sidecar, а возвращает ошибку."""
        response = json.loads(process_single_request("{ not valid json"))
        self.assertIn("error", response)


if __name__ == "__main__":
    unittest.main()
