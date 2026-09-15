# -*- coding: utf-8 -*-
"""
Слой логики: поиск реквизитов компании по ИНН.

Инкапсулирует обращение к внешнему сервису DaData и хранение API-ключа.
Возвращает простые словари, пригодные для передачи фронтенду.
"""
from __future__ import annotations

import re

from legal_tools.core.formatting import normalize_quotes, strip_all_quotes


DADATA_FIND_BY_ID_URL = (
    "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party"
)

# Карта организационно-правовых форм: краткое ОПФ из DaData уже приходит готовым,
# но на случай отсутствия поля используем полное название формы.
LEGAL_FORM_ABBREVIATIONS = {
    "ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ": "ООО",
    "АКЦИОНЕРНОЕ ОБЩЕСТВО": "АО",
    "ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО": "ПАО",
    "НЕПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО": "АО",
    "ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ": "ИП",
    "ГОСУДАРСТВЕННОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ": "ГУП",
    "МУНИЦИПАЛЬНОЕ УНИТАРНОЕ ПРЕДПРИЯТИЕ": "МУП",
}

# Краткие ОПФ, которые DaData отдаёт в виде, отличном от принятого в документах.
# «НАО» (непубличное акционерное общество) в наших документах пишется как «АО».
LEGAL_FORM_SHORT_OVERRIDES = {
    "НАО": "АО",
}


def normalize_legal_form(legal_form_short: str) -> str:
    """
    Приводит краткую ОПФ из DaData к виду, принятому в документах.

    Принимает краткую форму («ООО», «НАО», «АО»). Заменяет «НАО» на «АО»;
    остальные формы возвращает без изменений.
    """
    cleaned = (legal_form_short or "").strip()
    return LEGAL_FORM_SHORT_OVERRIDES.get(cleaned.upper(), cleaned)


def build_company_display_name(short_name: str, legal_form_short: str) -> str:
    """
    Собирает короткое наименование компании с аббревиатурой формы и ёлочками.

    Принимает краткое имя без формы (например «Концерн ОТ») и краткую
    организационно-правовую форму (например «ООО»). Возвращает строку вида
    «ООО «Концерн ОТ»» — все кавычки приводятся к ёлочкам.
    """
    name_without_quotes = strip_all_quotes(short_name)
    if not name_without_quotes:
        return ""
    if legal_form_short:
        return f"{legal_form_short} «{name_without_quotes}»"
    return f"«{name_without_quotes}»"


def extract_company_details_from_suggestion(suggestion: dict) -> dict:
    """
    Извлекает реквизиты компании из одного элемента ответа DaData.

    Принимает элемент массива suggestions и возвращает словарь с полями
    name, ogrn, inn, kpp, address, готовыми для заполнения формы иска.
    """
    company_data = suggestion.get("data", {})
    name_block = company_data.get("name", {})
    legal_form_block = company_data.get("opf", {}) or {}

    short_name = (name_block.get("short") or name_block.get("full") or "").strip()
    legal_form_short = normalize_legal_form(legal_form_block.get("short"))

    display_name = build_company_display_name(short_name, legal_form_short)
    if not display_name:
        fallback_name = (
            name_block.get("short_with_opf")
            or name_block.get("full_with_opf")
            or suggestion.get("value", "")
        )
        # В запасном варианте ОПФ уже вшита в строку — заменяем её там же.
        display_name = re.sub(r"^НАО\b", "АО", normalize_quotes(fallback_name).strip())

    address_block = company_data.get("address") or {}
    return {
        "name": display_name,
        "ogrn": (company_data.get("ogrn") or "").strip(),
        "inn": (company_data.get("inn") or "").strip(),
        "kpp": (company_data.get("kpp") or "").strip(),
        "address": (address_block.get("unrestricted_value") or "").strip(),
    }


def find_company_by_inn(inn: str, api_key: str) -> dict | None:
    """
    Ищет компанию по ИНН через сервис DaData.

    Принимает ИНН и API-ключ DaData. Возвращает словарь с реквизитами
    компании или None, если компания не найдена. Бросает исключение при
    сетевой ошибке или отсутствии ключа.
    """
    import json
    import re
    import urllib.request

    from legal_tools.core.network import shared_ssl_context

    cleaned_inn = re.sub(r"\D", "", inn)
    if not cleaned_inn:
        return None
    if not api_key:
        raise ValueError("NO_KEY")

    request_body = json.dumps({"query": cleaned_inn, "count": 1}).encode("utf-8")
    request = urllib.request.Request(
        DADATA_FIND_BY_ID_URL,
        data=request_body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Token {api_key}",
        },
    )

    with urllib.request.urlopen(
        request, timeout=10, context=shared_ssl_context(),
    ) as response:
        response_data = json.loads(response.read().decode("utf-8"))

    suggestions = response_data.get("suggestions", [])
    if not suggestions:
        return None
    return extract_company_details_from_suggestion(suggestions[0])
