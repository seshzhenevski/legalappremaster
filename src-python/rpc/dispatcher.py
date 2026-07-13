# -*- coding: utf-8 -*-
"""
Диспетчер JSON-RPC: связывает имена методов с функциями слоя логики.

Это граница между интерфейсом и логикой. Диспетчер знает о логике
(импортирует её функции), но логика не знает о диспетчере. Каждый метод —
это тонкая обёртка, которая извлекает параметры и вызывает одну функцию логики.
"""
from __future__ import annotations

from logic.state_duty_calculator import calculate_duty_for_claim_amount
from logic.penalty_calculator import calculate_penalty_for_debts
from logic.company_lookup import find_company_by_inn
from logic.lawsuit_generator import generate_lawsuit_package
from logic.document_sorter_service import sort_documents_into_packages
from logic.payment_order_generator import generate_state_duty_payment_order
from logic.penalty_excel_import import import_debts_and_payments_from_excel
from logic.claim_generator import (
    generate_claim_package,
    summarize_invoices_excel,
    export_claim_document,
)


def handle_calculate_state_duty(params: dict, report_progress) -> dict:
    """
    Обрабатывает запрос на расчёт госпошлины.

    Извлекает цену иска из параметров и возвращает результат расчёта.
    """
    return calculate_duty_for_claim_amount(params["claim_amount"])


def handle_calculate_penalty(params: dict, report_progress) -> dict:
    """
    Обрабатывает запрос на расчёт неустойки.

    Извлекает задолженности, платежи, дату окончания, ставку, тип ставки
    (день/год) и необязательное ограничение из параметров и возвращает
    результат расчёта.
    """
    return calculate_penalty_for_debts(
        debts_input=params["debts"],
        payments_input=params.get("payments", []),
        period_end_date=params["period_end_date"],
        daily_rate_percent=params["daily_rate_percent"],
        rate_type=params.get("rate_type", "day"),
        cap_percent=params.get("cap_percent"),
    )


def handle_find_company_by_inn(params: dict, report_progress) -> dict | None:
    """
    Обрабатывает запрос на поиск компании по ИНН.

    Извлекает ИНН и API-ключ из параметров и возвращает реквизиты компании.
    """
    return find_company_by_inn(params["inn"], params["api_key"])


def handle_generate_lawsuit(params: dict, report_progress) -> dict:
    """
    Обрабатывает запрос на генерацию пакета документов по иску.

    Передаёт весь запрос и функцию отправки прогресса в генератор иска.
    Возвращает пути к созданным файлам вместе с итоговыми суммами. Ход
    работы транслируется в реальном времени через report_progress.
    """
    return generate_lawsuit_package(params, report_progress)


def handle_sort_documents(params: dict, report_progress) -> dict:
    """
    Обрабатывает запрос на сборку пакетов документов.

    Передаёт запрос (включая необязательный флаг проверки целостности) и
    функцию отправки прогресса в сервис сортировки. Возвращает статистику
    созданных пакетов; сам ход работы транслируется в реальном времени
    через report_progress.
    """
    return sort_documents_into_packages(params, report_progress)


def handle_generate_payment_order_pdf(params: dict, report_progress) -> dict:
    """
    Обрабатывает запрос на генерацию платёжного поручения по госпошлине.

    Извлекает путь сохранения, сумму пошлины, ответчика, сумму иска и дату
    платежа из параметров и возвращает путь к созданному PDF-файлу.
    """
    return generate_state_duty_payment_order(
        output_path=params["output_path"],
        duty_amount=params["duty_amount"],
        defendant_name=params["defendant_name"],
        claim_amount=params["claim_amount"],
        payment_date=params.get("payment_date"),
    )


def handle_import_penalty_excel(params: dict, report_progress) -> dict:
    """
    Обрабатывает запрос на импорт задолженностей и платежей из Excel.

    Извлекает путь к файлу из параметров и возвращает списки задолженностей
    и платежей, готовые для подстановки в форму расчёта неустойки.
    """
    return import_debts_and_payments_from_excel(params["excel_path"])


def handle_generate_claim(params: dict, report_progress) -> dict:
    """
    Обрабатывает запрос на генерацию досудебной претензии.

    Передаёт весь запрос и функцию отправки прогресса в генератор претензии.
    Возвращает пути к временным файлам (DOCX, PDF, опись) и сводку; ход работы
    транслируется в реальном времени через report_progress.
    """
    return generate_claim_package(params, report_progress)


def handle_summarize_claim_excel(params: dict, report_progress) -> dict:
    """
    Обрабатывает запрос на подсчёт итогов из загруженного Excel со счетами.

    Извлекает путь к файлу и возвращает общую сумму и реквизиты договора
    для автоподстановки в поля формы претензии.
    """
    return summarize_invoices_excel(params["excel_path"])


def handle_export_claim_document(params: dict, report_progress) -> dict:
    """
    Обрабатывает запрос на сохранение готовой претензии в выбранное место.

    Копирует временный файл претензии (DOCX или PDF) по указанному пути и
    кладёт рядом опись. Возвращает список сохранённых файлов.
    """
    return export_claim_document(params)


# Карта методов RPC: имя метода → функция-обработчик.
# Добавление нового метода — это одна строка здесь плюс одна функция выше.
METHOD_HANDLERS = {
    "calculate_state_duty": handle_calculate_state_duty,
    "calculate_penalty": handle_calculate_penalty,
    "find_company_by_inn": handle_find_company_by_inn,
    "generate_lawsuit": handle_generate_lawsuit,
    "sort_documents": handle_sort_documents,
    "generate_payment_order_pdf": handle_generate_payment_order_pdf,
    "import_penalty_excel": handle_import_penalty_excel,
    "generate_claim": handle_generate_claim,
    "summarize_claim_excel": handle_summarize_claim_excel,
    "export_claim_document": handle_export_claim_document,
}


def dispatch_rpc_method(method_name: str, params: dict, report_progress=None):
    """
    Вызывает обработчик для указанного метода RPC.

    Находит функцию по имени метода в карте обработчиков и вызывает её
    с переданными параметрами и функцией отправки прогресса (по умолчанию —
    заглушка, ничего не делающая; используется в тестах, вызывающих
    диспетчер напрямую). Бросает ValueError, если метод неизвестен.
    """
    handler = METHOD_HANDLERS.get(method_name)
    if handler is None:
        raise ValueError(f"Неизвестный метод: {method_name}")
    return handler(params, report_progress or _noop_progress)


def _noop_progress(message: str, percent: int | None = None) -> None:
    """Заглушка report_progress для вызовов без реального отслеживания хода работы."""
