# -*- coding: utf-8 -*-
"""
Слой логики: хранение и актуализация истории ключевой ставки ЦБ РФ.

Рабочая история ключевой ставки хранится в JSON-файле в пользовательской
папке (%LOCALAPPDATA%\\LegalApp\\key_rate_history.json) — отдельно от папки
установки, чтобы обновление приложения не затирало данные. При первом запуске
файл создаётся из встроенной «затравки» (legal_tools.core.key_rate_seed).

Когда расчёт по ст. 395 доходит до текущей (последней известной) ставки,
приложение обращается к официальному веб-сервису ЦБ (SOAP-метод KeyRate) и
дописывает новые значения. Если сети нет — расчёт идёт по сохранённой истории,
а пользователю возвращается предупреждение.
"""
from __future__ import annotations

import json
import os
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path
from typing import List, Tuple

from legal_tools.core.key_rate import (
    RateHistory, parse_history, history_to_raw, latest_start,
)
from legal_tools.core.key_rate_seed import KEY_RATE_SEED

CBR_ENDPOINT = "https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx"
HISTORY_FILENAME = "key_rate_history.json"
NETWORK_TIMEOUT_SECONDS = 6


def user_data_dir() -> Path:
    """
    Пользовательская папка данных приложения (создаётся при необходимости).

    Windows — %LOCALAPPDATA%\\LegalApp (или %APPDATA%); иначе — ~/.legalapp.
    Намеренно отличается от папки установки «Legal App», чтобы переустановка
    приложения не удаляла накопленную историю ставок.
    """
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
    path = (Path(base) / "LegalApp") if base else (Path.home() / ".legalapp")
    path.mkdir(parents=True, exist_ok=True)
    return path


def history_path() -> Path:
    """Путь к рабочему JSON-файлу истории ключевой ставки."""
    return user_data_dir() / HISTORY_FILENAME


def _collapse(history: RateHistory) -> RateHistory:
    """Схлопывает подряд идущие одинаковые ставки в точки изменения.

    Официальный сервис ЦБ отдаёт ставку по КАЖДОМУ дню периода; без схлопывания
    каждая дата стала бы «сменой ставки» и раздробила бы расчёт на однодневные
    отрезки (искажая округление). Оставляем только записи, где ставка меняется.
    """
    collapsed: RateHistory = []
    previous = None
    for start, rate in history:  # history уже отсортирована по дате
        if rate != previous:
            collapsed.append((start, rate))
            previous = rate
    return collapsed


def _merge_raw(*sources: List[dict]) -> RateHistory:
    """Сливает несколько «сырых» списков записей; при совпадении даты
    побеждает более поздний источник. Возвращает отсортированную и схлопнутую
    (только точки изменения ставки) историю."""
    merged: dict = {}
    for source in sources:
        for item in source or []:
            try:
                merged[str(item["from"])] = str(item["rate"])
            except (KeyError, TypeError):
                continue
    history = parse_history([{"from": k, "rate": v} for k, v in merged.items()])
    return _collapse(history)


def load_history() -> RateHistory:
    """
    Загружает историю ставки: встроенная затравка, поверх — пользовательский
    JSON (если есть и читается). Если файла ещё нет — создаёт его из затравки.
    """
    path = history_path()
    stored: List[dict] = []
    if path.exists():
        try:
            stored = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            stored = []
    history = _merge_raw(KEY_RATE_SEED, stored)
    if not path.exists():
        save_history(history)
    return history


def save_history(history: RateHistory) -> None:
    """Сохраняет историю ставки в пользовательский JSON-файл."""
    history_path().write_text(
        json.dumps(history_to_raw(history), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _build_keyrate_soap(from_date: date, to_date: date) -> bytes:
    """Тело SOAP 1.2-запроса метода KeyRate за период [from_date, to_date]."""
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<soap12:Envelope '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xmlns:xsd="http://www.w3.org/2001/XMLSchema" '
        'xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">'
        '<soap12:Body><KeyRate xmlns="http://web.cbr.ru/">'
        f'<fromDate>{from_date.isoformat()}</fromDate>'
        f'<ToDate>{to_date.isoformat()}</ToDate>'
        '</KeyRate></soap12:Body></soap12:Envelope>'
    ).encode("utf-8")


def fetch_cbr_key_rate(from_date: date, to_date: date) -> RateHistory:
    """
    Запрашивает ключевую ставку у официального сервиса ЦБ за период.

    Возвращает историю (только точки изменения). Бросает исключение при
    сетевой ошибке/таймауте — вызывающая сторона обрабатывает оффлайн.
    """
    request = urllib.request.Request(
        CBR_ENDPOINT,
        data=_build_keyrate_soap(from_date, to_date),
        headers={"Content-Type": "application/soap+xml; charset=utf-8"},
    )
    with urllib.request.urlopen(request, timeout=NETWORK_TIMEOUT_SECONDS) as response:
        payload = response.read().decode("utf-8")

    root = ET.fromstring(payload)
    raw: List[dict] = []
    for node in root.iter("KR"):
        day = node.findtext("DT")
        rate = node.findtext("Rate")
        if day and rate:
            raw.append({"from": day[:10], "rate": rate.strip().replace(",", ".")})
    return parse_history(raw)


def ensure_fresh_history(
    period_end: date, allow_network: bool = True,
) -> Tuple[RateHistory, List[str]]:
    """
    Возвращает (история_ставок, предупреждения) для расчёта до period_end.

    Если период доходит до текущей (последней известной) ставки и разрешена
    сеть — обращается к API ЦБ и дописывает новые значения в файл. При ошибке
    сети возвращает сохранённую историю и текстовое предупреждение.
    """
    history = load_history()
    warnings: List[str] = []

    latest = latest_start(history)
    if not allow_network or latest is None or period_end < latest:
        return history, warnings

    try:
        fetched = fetch_cbr_key_rate(latest, period_end)
    except Exception:
        warnings.append(
            "Не удалось проверить актуальность ключевой ставки ЦБ (нет соединения "
            "с сайтом cbr.ru). Расчёт выполнен по сохранённой истории — при "
            "необходимости сверьте текущую ставку вручную."
        )
        return history, warnings

    updated = _merge_raw(history_to_raw(history), history_to_raw(fetched))
    if updated != history:
        save_history(updated)
    return updated, warnings
