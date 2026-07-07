# -*- coding: utf-8 -*-
"""
Слой логики: сортировка и сборка пакетов документов.

Оборачивает DocumentSorter из ядра в функцию с простыми входными данными.
Транслирует лог и прогресс через report_progress в реальном времени (тот
же принцип, что и в lawsuit_generator), а также накапливает лог в список
для финального ответа. Ничего не знает об интерфейсе.
"""
from __future__ import annotations

from typing import List

from legal_tools.importers.document_sorter import DocumentSorter


def collect_log_messages(report_progress=None) -> tuple:
    """
    Создаёт список для накопления сообщений лога и колбэк для их записи.

    Возвращает пару: сам список сообщений и функцию, которую DocumentSorter
    будет вызывать для добавления строк. Функция и накапливает строку в
    список (для финального ответа), и сразу транслирует её через
    report_progress, чтобы интерфейс показывал лог в реальном времени.
    report_progress по умолчанию — заглушка (используется в тестах,
    вызывающих эту функцию напрямую без реального отслеживания прогресса).
    """
    if report_progress is None:
        report_progress = lambda message, percent=None: None

    log_messages: List[str] = []

    def append_log_message(text: str, tag=None) -> None:
        """Добавляет одну строку в список сообщений лога и в живой поток."""
        log_messages.append(text)
        report_progress(text)

    return log_messages, append_log_message


def sort_documents_into_packages(request: dict, report_progress=None) -> dict:
    """
    Собирает пакеты документов (Счёт + Акт + УПД) из папки с PDF.

    Принимает путь к папке с исходными файлами, папку вывода, текст с
    описанием счетов, необязательный флаг проверки целостности пакетов и
    необязательную функцию report_progress для трансляции хода работы в
    реальном времени (по умолчанию — заглушка; используется в тестах,
    вызывающих функцию напрямую). Создаёт объединённые PDF-пакеты и
    возвращает лог выполнения со статистикой созданных пакетов.
    """
    if report_progress is None:
        report_progress = lambda message, percent=None: None

    log_messages, append_log_message = collect_log_messages(report_progress)

    sorter = DocumentSorter(
        source_folder=request["source_folder"],
        output_folder=request["output_folder"],
        log_callback=append_log_message,
    )

    invoices = sorter.parse_invoice_info(request["invoice_text"])
    created_packages = build_all_packages(
        sorter, invoices, request.get("check_integrity", False),
        append_log_message, report_progress,
    )

    return {
        "log": log_messages,
        "packages_created": created_packages,
        "invoices_total": len(invoices),
    }


def build_all_packages(
    sorter: DocumentSorter,
    invoices: List[dict],
    check_integrity: bool,
    append_log_message,
    report_progress,
) -> int:
    """
    Создаёт пакет документов для каждого счёта из списка.

    Проходит по счетам, вызывает создание пакета для каждого и считает,
    сколько пакетов было успешно собрано. Если включена проверка
    целостности, дополнительно предупреждает, когда для счёта найдены не
    все ожидаемые документы. После каждого счёта отправляет обновлённый
    процент выполнения (доля обработанных счетов от общего числа).
    Возвращает число успешно созданных пакетов.
    """
    created_count = 0
    total = len(invoices)
    for index, invoice in enumerate(invoices, start=1):
        result = sorter.create_invoice_package(invoice, idx=index, total=total)
        if result:
            created_count += 1
            if check_integrity:
                expected_count = 1 + len(invoice["related_documents"])
                if result["documents_count"] < expected_count:
                    append_log_message(
                        f"⚠ Пакет для счёта № {invoice['invoice_number']} собран "
                        f"не полностью (найдено {result['documents_count']} из "
                        f"{expected_count})."
                    )
        if total:
            report_progress("", percent=int(100 * index / total))
    return created_count
