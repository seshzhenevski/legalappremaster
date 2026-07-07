# -*- coding: utf-8 -*-
"""
Точка входа Python-sidecar.

Читает JSON-RPC-запросы из stdin построчно, передаёт их диспетчеру
и пишет JSON-ответы в stdout. Каждый запрос и ответ — одна строка JSON
(формат JSON Lines), что упрощает потоковый обмен с Tauri.

Формат запроса:  {"id": 1, "method": "calculate_state_duty", "params": {...}}
Формат ответа:   {"id": 1, "result": {...}}  или  {"id": 1, "error": "..."}

Долгие методы (генерация иска, сортировка документов) дополнительно
могут писать в stdout строки прогресса ДО финального ответа:
  {"type": "progress", "id": 1, "message": "...", "percent": 42}
Rust-сторона ретранслирует такие строки как события интерфейсу в реальном
времени и продолжает ждать финальную строку с result/error.
"""
from __future__ import annotations

import io
import json
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", newline="")
sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8")

from rpc.dispatcher import dispatch_rpc_method


def build_success_response(request_id, result) -> str:
    """
    Собирает строку успешного JSON-ответа.

    Принимает идентификатор запроса и результат, возвращает JSON-строку.
    """
    return json.dumps(
        {"id": request_id, "result": result},
        ensure_ascii=False,
    )


def build_error_response(request_id, error_message: str) -> str:
    """
    Собирает строку ответа с ошибкой.

    Принимает идентификатор запроса и текст ошибки, возвращает JSON-строку.
    """
    return json.dumps(
        {"id": request_id, "error": error_message},
        ensure_ascii=False,
    )


def make_progress_reporter(request_id):
    """
    Создаёт функцию отправки промежуточного сообщения о прогрессе.

    Принимает id текущего запроса. Возвращает функцию report_progress(message,
    percent=None), которая немедленно пишет строку прогресса в stdout со
    сбросом буфера — Rust читает её раньше финального ответа и ретранслирует
    интерфейсу как событие.
    """
    def report_progress(message: str, percent: int | None = None) -> None:
        payload = {"type": "progress", "id": request_id, "message": message}
        if percent is not None:
            payload["percent"] = percent
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    return report_progress


def process_single_request(raw_request_line: str) -> str:
    """
    Обрабатывает одну строку запроса и возвращает строку ответа.

    Разбирает JSON, вызывает диспетчер (передавая ему функцию отправки
    прогресса) и оборачивает результат или ошибку в соответствующий ответ.
    Не бросает исключений — любая ошибка попадает в поле error ответа.
    """
    request_id = None
    try:
        request = json.loads(raw_request_line)
        request_id = request.get("id")
        method_name = request["method"]
        params = request.get("params", {})
        report_progress = make_progress_reporter(request_id)
        result = dispatch_rpc_method(method_name, params, report_progress)
        return build_success_response(request_id, result)
    except Exception as error:
        return build_error_response(request_id, str(error))


def run_sidecar_loop() -> None:
    """
    Запускает основной цикл чтения запросов из stdin.

    Читает stdin построчно до конца потока. Каждую непустую строку
    обрабатывает и немедленно пишет ответ в stdout с принудительным сбросом
    буфера, чтобы Tauri получал ответы без задержки.
    """
    for raw_line in sys.stdin:
        stripped_line = raw_line.strip()
        if not stripped_line:
            continue
        response_line = process_single_request(stripped_line)
        sys.stdout.write(response_line + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    run_sidecar_loop()
