# -*- coding: utf-8 -*-
"""
core/key_rate.py
────────────────
Чистые утилиты работы с историей ключевой ставки Банка России для расчёта
процентов по ст. 395 ГК РФ. Без сети и файлового ввода-вывода — только
разбор истории, поиск действующей ставки на дату и число дней в году.

История — это список пар (дата начала действия, ставка в % годовых),
отсортированный по дате. Загрузка/сохранение JSON и обращение к API ЦБ —
в logic.key_rate_service.
"""
from __future__ import annotations

import calendar
from datetime import date
from decimal import Decimal
from typing import List, Optional, Tuple

RateHistory = List[Tuple[date, Decimal]]


def _parse_iso(iso_date: str) -> date:
    """«ГГГГ-ММ-ДД» → date."""
    year, month, day = (int(part) for part in str(iso_date).split("-"))
    return date(year, month, day)


def parse_history(raw: List[dict]) -> RateHistory:
    """
    Преобразует «сырой» список записей в отсортированную историю.

    Каждая запись — словарь {"from": "ГГГГ-ММ-ДД", "rate": "16.00"}.
    Возвращает список (date, Decimal), отсортированный по дате начала.
    Дубликаты по дате схлопываются (побеждает последняя запись).
    """
    by_date: dict = {}
    for item in raw:
        by_date[_parse_iso(item["from"])] = Decimal(str(item["rate"]))
    return sorted(by_date.items(), key=lambda pair: pair[0])


def history_to_raw(history: RateHistory) -> List[dict]:
    """История (date, Decimal) → список словарей для сохранения в JSON."""
    return [{"from": d.isoformat(), "rate": str(r)} for d, r in history]


def rate_on(history: RateHistory, day: date) -> Optional[Decimal]:
    """
    Ставка, действующая на дату day — последняя запись с датой начала ≤ day.

    Возвращает None, если day раньше самой ранней записи в истории.
    """
    result: Optional[Decimal] = None
    for start, rate in history:
        if start <= day:
            result = rate
        else:
            break
    return result


def latest_start(history: RateHistory) -> Optional[date]:
    """Дата начала самой поздней (текущей) ставки в истории."""
    return history[-1][0] if history else None


def days_in_year(year: int) -> int:
    """Число дней в году: 366 для високосного, иначе 365 (для ст. 395)."""
    return 366 if calendar.isleap(year) else 365


def rate_change_dates(history: RateHistory) -> List[date]:
    """Список дат смены ставки (даты начала записей истории)."""
    return [start for start, _ in history]
