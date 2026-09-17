# -*- coding: utf-8 -*-
"""
Диспетчер JSON-RPC: связывает имена методов с функциями слоя логики.

Это граница между интерфейсом и логикой. Диспетчер знает о логике
(импортирует её функции), но логика не знает о диспетчере. Каждый метод —
это тонкая обёртка, которая извлекает параметры и вызывает одну функцию логики.
"""
from __future__ import annotations

from pathlib import Path

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
    find_claim_by_inn,
)
from logic.court_cases_dashboard import load_dashboard_data
from logic.knowledge_base import (
    acquire_lock,
    check_lock,
    create_article,
    delete_article,
    list_trash,
    list_versions,
    load_knowledge_base,
    read_article,
    purge_trash_entry,
    read_version,
    release_lock,
    resolve_inside_root,
    restore_article,
    restore_version,
    save_article,
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
        daily_rate_percent=params.get("daily_rate_percent", "0.1"),
        rate_type=params.get("rate_type", "day"),
        cap_percent=params.get("cap_percent"),
        penalty_type=params.get("penalty_type", "contractual"),
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


def handle_find_claim_by_inn(params: dict, report_progress) -> dict | None:
    """
    Обрабатывает запрос на поиск претензии должника по ИНН в реестре.

    Извлекает ИНН (и необязательную папку реестра — по умолчанию берётся
    сетевая папка из конфига) и возвращает номер и дату последней претензии
    этого должника для автоподстановки в форму иска.
    """
    return find_claim_by_inn(params["inn"], params.get("registry_folder"))


def handle_export_claim_document(params: dict, report_progress) -> dict:
    """
    Обрабатывает запрос на сохранение готовой претензии в выбранное место.

    Копирует временный файл претензии (DOCX или PDF) по указанному пути и
    кладёт рядом опись. Возвращает список сохранённых файлов.
    """
    return export_claim_document(params)


def handle_load_dashboard_data(params: dict, report_progress) -> dict:
    """
    Обрабатывает запрос на загрузку данных дашборда из Google-таблицы.

    Извлекает путь к JSON-ключу сервисного аккаунта и идентификатор таблицы и
    возвращает посчитанные показатели сразу по всем годам и по каждому году.
    Таблица только читается — записи в неё дашборд не делает.
    """
    return load_dashboard_data(params)


def handle_load_knowledge_base(params: dict, report_progress) -> dict:
    """
    Обрабатывает запрос на загрузку базы знаний целиком.

    Извлекает путь к корневой папке на сетевом диске и возвращает дерево
    разделов вместе с текстом всех статей. Интерфейс держит это в памяти и
    дальше открывает статьи и ищет по ним, не обращаясь к бэкенду.
    """
    return load_knowledge_base(Path(params["root_path"]))


def handle_read_kb_article(params: dict, report_progress) -> dict:
    """
    Обрабатывает запрос на перечитывание одной статьи базы знаний.

    Нужен, когда статья изменилась у коллеги и её нужно обновить, не
    перечитывая базу целиком. Возвращает свойства, текст и отпечаток
    содержимого.
    """
    root_path = Path(params["root_path"])
    return read_article(resolve_inside_root(root_path, params["relative_path"]))


def handle_save_kb_article(params: dict, report_progress) -> dict:
    """
    Обрабатывает сохранение статьи базы знаний.

    Извлекает корень базы, относительный путь, свойства, текст и отпечаток
    содержимого, полученный при открытии статьи. Возвращает признак conflict,
    если статью тем временем правил кто-то другой, — перезаписи в этом случае
    не происходит.
    """
    root_path = Path(params["root_path"])
    article_path = resolve_inside_root(root_path, params["relative_path"])
    return save_article(
        root_path,
        article_path,
        params["properties"],
        params["body"],
        params.get("expected_fingerprint"),
    )


def handle_create_kb_article(params: dict, report_progress) -> dict:
    """
    Обрабатывает создание статьи базы знаний.

    Извлекает корень базы, раздел, заголовок и автора. Возвращает карточку
    созданной статьи с её постоянным идентификатором.
    """
    return create_article(
        Path(params["root_path"]),
        params.get("folder_relative_path", ""),
        params["title"],
        params.get("author", ""),
        params.get("category", ""),
        params.get("icon", ""),
        params.get("body", ""),
    )


def handle_acquire_kb_lock(params: dict, report_progress) -> dict:
    """
    Обрабатывает захват статьи на редактирование.

    Извлекает корень базы, идентификатор статьи и признак перехвата
    брошенного замка. Возвращает признак успеха и сведения о том, кто
    держит статью, если захватить не удалось.
    """
    return acquire_lock(
        Path(params["root_path"]),
        params["article_id"],
        force=bool(params.get("force", False)),
    )


def handle_release_kb_lock(params: dict, report_progress) -> dict:
    """
    Обрабатывает снятие замка со статьи.

    Извлекает корень базы и идентификатор статьи. Чужой замок не снимается.
    """
    return release_lock(Path(params["root_path"]), params["article_id"])


def handle_check_kb_lock(params: dict, report_progress) -> dict | None:
    """
    Обрабатывает проверку, занята ли статья кем-то на редактирование.

    Возвращает сведения о владельце замка или None, если статья свободна.
    """
    return check_lock(Path(params["root_path"]), params["article_id"])


def handle_list_kb_versions(params: dict, report_progress) -> list:
    """
    Обрабатывает запрос списка снимков предыдущих версий статьи.

    Возвращает записи с именем снимка и временем сохранения, новые первыми.
    """
    return list_versions(Path(params["root_path"]), params["article_id"])


def handle_read_kb_version(params: dict, report_progress) -> dict:
    """
    Обрабатывает чтение содержимого одного снимка версии.

    Нужен, чтобы показать прежнюю версию до того, как пользователь решит
    её восстанавливать.
    """
    return read_version(
        Path(params["root_path"]), params["article_id"], params["version_name"],
    )


def handle_restore_kb_version(params: dict, report_progress) -> dict:
    """
    Обрабатывает восстановление статьи из снимка.

    Восстановление идёт обычным сохранением, поэтому текущая версия сама
    попадает в снимки и откат можно отменить тем же способом.
    """
    return restore_version(
        Path(params["root_path"]),
        params["relative_path"],
        params["version_name"],
        params.get("expected_fingerprint"),
    )


def handle_delete_kb_article(params: dict, report_progress) -> dict:
    """
    Обрабатывает удаление статьи базы знаний.

    Статья не стирается, а переносится в корзину вместе с записью об
    исходном пути: на общем диске случайное удаление обходится дорого.
    Возвращает запись корзины, по которой статью можно вернуть.
    """
    root_path = Path(params["root_path"])
    article_path = resolve_inside_root(root_path, params["relative_path"])
    return delete_article(root_path, article_path)


def handle_list_kb_trash(params: dict, report_progress) -> list:
    """
    Обрабатывает запрос содержимого корзины, недавно удалённые первыми.
    """
    return list_trash(Path(params["root_path"]))


def handle_restore_kb_trash_entry(params: dict, report_progress) -> dict:
    """
    Обрабатывает восстановление статьи из корзины на исходное место.

    Если на исходном пути уже лежит другая статья, она НЕ перезаписывается —
    восстановленная кладётся рядом под именем с пометкой.
    """
    return restore_article(Path(params["root_path"]), params["entry_id"])


def handle_purge_kb_trash_entry(params: dict, report_progress) -> None:
    """
    Обрабатывает окончательное удаление записи корзины.

    После этого восстановить статью средствами приложения нельзя.
    """
    purge_trash_entry(Path(params["root_path"]), params["entry_id"])


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
    "find_claim_by_inn": handle_find_claim_by_inn,
    "load_dashboard_data": handle_load_dashboard_data,
    "load_knowledge_base": handle_load_knowledge_base,
    "read_kb_article": handle_read_kb_article,
    "save_kb_article": handle_save_kb_article,
    "create_kb_article": handle_create_kb_article,
    "acquire_kb_lock": handle_acquire_kb_lock,
    "release_kb_lock": handle_release_kb_lock,
    "check_kb_lock": handle_check_kb_lock,
    "list_kb_versions": handle_list_kb_versions,
    "read_kb_version": handle_read_kb_version,
    "restore_kb_version": handle_restore_kb_version,
    "delete_kb_article": handle_delete_kb_article,
    "list_kb_trash": handle_list_kb_trash,
    "restore_kb_trash_entry": handle_restore_kb_trash_entry,
    "purge_kb_trash_entry": handle_purge_kb_trash_entry,
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
