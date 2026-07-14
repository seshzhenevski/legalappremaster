# -*- coding: utf-8 -*-
"""
google_sheets.py
────────────────
Чтение Google-таблицы через Sheets API от имени сервисного аккаунта.

Модуль знает только про транспорт: авторизацию по JSON-ключу и получение
сырых значений листов. Что означают колонки и как считать показатели — не его
дело (это слой логики). Операций записи здесь нет и быть не должно: таблица
открывается сервисному аккаунту только на чтение.
"""
from __future__ import annotations

import json
from pathlib import Path

# Единственная область доступа: только чтение. Даже если сервисному аккаунту
# выдали право редактирования, этим токеном изменить таблицу нельзя.
READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly"

API_ROOT = "https://sheets.googleapis.com/v4/spreadsheets"

# Диапазон, который запрашивается с листа. Верхняя граница взята с запасом:
# Sheets API возвращает только реально заполненные строки, лишнего трафика нет.
SHEET_RANGE_LIMIT = "A1:Z20000"

REQUEST_TIMEOUT_SECONDS = 30


class SheetsAccessError(RuntimeError):
    """Ошибка доступа к таблице, текст которой можно показать пользователю."""


def read_sheets_values(credentials_path: str, spreadsheet_id: str, sheet_titles: list[str]) -> dict:
    """
    Читает указанные листы таблицы и возвращает их сырые значения.

    Принимает путь к JSON-ключу сервисного аккаунта, идентификатор таблицы и
    список названий листов. Возвращает словарь «название листа → список строк»,
    где строка — список значений ячеек (как их отдаёт Sheets API: строками,
    с пропуском хвостовых пустых ячеек). Лист, которого нет в таблице,
    возвращается пустым списком — это не ошибка.

    Бросает SheetsAccessError с понятным текстом, если ключ не найден, не
    подходит, нет сети или к таблице не выдан доступ.
    """
    session = _authorized_session(credentials_path)
    available_titles = _fetch_sheet_titles(session, spreadsheet_id)

    resolved = {title: _match_sheet_title(title, available_titles) for title in sheet_titles}
    ranges = [f"'{actual}'!{SHEET_RANGE_LIMIT}" for actual in resolved.values() if actual]

    values_by_actual_title = _fetch_ranges(session, spreadsheet_id, ranges) if ranges else {}

    return {
        title: values_by_actual_title.get(actual, [])
        for title, actual in resolved.items()
    }


def _authorized_session(credentials_path: str):
    """
    Создаёт HTTP-сессию, подписанную сервисным аккаунтом.

    Читает JSON-ключ с диска и получает токен доступа с областью «только
    чтение». Библиотеки Google импортируются здесь, а не на уровне модуля,
    чтобы отсутствие зависимости не ломало импорт остальной логики.
    """
    key_file = Path(credentials_path or "")
    if not key_file.is_file():
        raise SheetsAccessError(
            "Файл ключа сервисного аккаунта не найден. Укажите путь к JSON-ключу "
            "в настройках дашборда."
        )

    try:
        from google.oauth2 import service_account
        from google.auth.transport.requests import AuthorizedSession
    except ImportError as error:
        raise SheetsAccessError(
            "Не установлены библиотеки для работы с Google API "
            "(google-auth). Переустановите приложение."
        ) from error

    try:
        credentials = service_account.Credentials.from_service_account_file(
            str(key_file), scopes=[READONLY_SCOPE]
        )
    except (ValueError, KeyError, json.JSONDecodeError) as error:
        raise SheetsAccessError(
            "Файл ключа повреждён или это не JSON-ключ сервисного аккаунта Google."
        ) from error

    return AuthorizedSession(credentials)


def _fetch_sheet_titles(session, spreadsheet_id: str) -> list[str]:
    """
    Возвращает названия всех листов таблицы.

    Нужен, чтобы найти нужный лист, даже если его название записано с другим
    регистром или лишними пробелами, и чтобы отличить «листа нет» от «нет
    доступа к таблице».
    """
    payload = _get_json(
        session,
        f"{API_ROOT}/{spreadsheet_id}",
        params={"fields": "sheets.properties.title"},
    )
    return [
        sheet.get("properties", {}).get("title", "")
        for sheet in payload.get("sheets", [])
    ]


def _fetch_ranges(session, spreadsheet_id: str, ranges: list[str]) -> dict:
    """
    Читает несколько диапазонов одним запросом.

    Возвращает словарь «название листа → строки значений». Названия берутся из
    ответа API (там они приходят в том виде, в каком записаны в таблице).
    """
    payload = _get_json(
        session,
        f"{API_ROOT}/{spreadsheet_id}/values:batchGet",
        params=[("ranges", one_range) for one_range in ranges]
        + [("majorDimension", "ROWS"), ("valueRenderOption", "UNFORMATTED_VALUE")],
    )

    values_by_title = {}
    for value_range in payload.get("valueRanges", []):
        title = _title_from_range(value_range.get("range", ""))
        values_by_title[title] = value_range.get("values", [])
    return values_by_title


def _get_json(session, url: str, params) -> dict:
    """
    Выполняет GET-запрос к Sheets API и разбирает ответ.

    Все сетевые и HTTP-ошибки переводятся в SheetsAccessError с текстом,
    который не стыдно показать юристу: приложение не должно падать из-за
    отсутствия сети или неверно выданного доступа.
    """
    try:
        response = session.get(url, params=params, timeout=REQUEST_TIMEOUT_SECONDS)
    except Exception as error:
        raise SheetsAccessError(
            "Не удалось связаться с Google Таблицами. Проверьте подключение к интернету."
        ) from error

    if response.status_code in (401, 403):
        raise SheetsAccessError(
            "Google отказал в доступе к таблице. Убедитесь, что таблица расшарена на "
            "адрес сервисного аккаунта с правом «Просмотр»."
        )
    if response.status_code == 404:
        raise SheetsAccessError(
            "Таблица с таким идентификатором не найдена. Проверьте ID таблицы в настройках."
        )
    if response.status_code >= 400:
        raise SheetsAccessError(
            f"Google Таблицы вернули ошибку {response.status_code}. Попробуйте позже."
        )

    try:
        return response.json()
    except ValueError as error:
        raise SheetsAccessError("Google Таблицы вернули неожиданный ответ.") from error


def _match_sheet_title(wanted: str, available: list[str]) -> str | None:
    """
    Находит реальное название листа по искомому.

    Сравнение нечувствительно к регистру и лишним пробелам — юристы правят
    названия листов, и дашборд не должен от этого ломаться. Возвращает None,
    если такого листа в таблице нет.
    """
    normalized_wanted = " ".join(wanted.lower().split())
    for title in available:
        if " ".join(title.lower().split()) == normalized_wanted:
            return title
    return None


def _title_from_range(range_notation: str) -> str:
    """
    Достаёт название листа из A1-нотации ответа API.

    Ответ приходит в виде «'Судебные дела'!A1:P200» — берётся часть до «!»
    и снимаются кавычки, если API их добавил.
    """
    sheet_part = range_notation.split("!")[0]
    if sheet_part.startswith("'") and sheet_part.endswith("'"):
        sheet_part = sheet_part[1:-1].replace("''", "'")
    return sheet_part
