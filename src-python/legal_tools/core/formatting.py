# -*- coding: utf-8 -*-
"""
core/formatting.py
──────────────────
Чистые утилиты форматирования и парсинга: суммы, даты, номера договоров,
имена файлов, кавычки. Без зависимостей от Qt, docx, PDF — только stdlib.

Qt-специфичные конверсии (_q2d/_d2q) вынесены в ui/qt_helpers.py, т.к.
требуют QDate и не относятся к чистой логике.
"""
from __future__ import annotations

import re
from datetime import date, timedelta, datetime as dt_
from decimal import Decimal, ROUND_HALF_UP
from functools import lru_cache
from typing import Optional, Tuple

try:
    from openpyxl.utils.datetime import from_excel as _xl_from_excel
except Exception:
    _xl_from_excel = None


# ── Форматирование сумм ───────────────────────────────────────────────────────

def fmt(v: Decimal) -> str:
    """100 000,25 — формат для отображения в RU-локали."""
    sign = "-" if v < 0 else ""
    v = abs(v)
    raw = f"{v:,.2f}"
    raw = raw.replace(",", " ").replace(".", ",")
    return sign + raw


def parse_dec(text: str) -> Optional[Decimal]:
    if text is None:
        return None
    t = str(text).strip().replace("\u00a0", "").replace(" ", "").replace(",", ".")
    if not t:
        return None
    try:
        return Decimal(t)
    except Exception:
        return None


def parse_amount_cell(raw) -> Optional[Decimal]:
    """Максимально терпимый парсер суммы из ячейки Excel."""
    if raw is None:
        return None
    if isinstance(raw, (int, float, Decimal)):
        try:
            return Decimal(str(raw))
        except Exception:
            return None
    s = str(raw).replace("\u00a0", " ").strip()
    if not s:
        return None
    s = re.sub(r"[a-zA-Zа-яА-ЯёЁ₽]+\.?", "", s)
    s = re.sub(r"[^\d,.\-]", "", s)
    if not s or s in ("-", ".", ","):
        return None
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    else:
        s = s.replace(",", ".")
    try:
        return Decimal(s)
    except Exception:
        return None


# ── Парсинг дат ───────────────────────────────────────────────────────────────

@lru_cache(maxsize=1024)
def parse_any_date(text: str) -> Optional[date]:
    """Гибкий парсер даты из текста. Кешируется — безопасно для потоков."""
    if not text:
        return None
    t = str(text).strip()
    fmts = [
        "%d.%m.%Y", "%d.%m.%y", "%d/%m/%Y", "%d/%m/%y",
        "%Y-%m-%d", "%Y.%m.%d", "%d-%m-%Y", "%d %m %Y",
    ]
    for f in fmts:
        try:
            return dt_.strptime(t, f).date()
        except Exception:
            pass
    digits = re.sub(r"[^\d]", "", t)
    if len(digits) == 8:
        try:
            return dt_.strptime(digits, "%d%m%Y").date()
        except Exception:
            pass
    return None


def parse_date_cell(raw) -> Optional[date]:
    if raw is None:
        return None
    if isinstance(raw, dt_):
        return raw.date()
    if isinstance(raw, date):
        return raw
    if isinstance(raw, (int, float)):
        if _xl_from_excel is not None:
            try:
                return _xl_from_excel(raw).date()
            except Exception:
                return None
        return None
    return parse_any_date(str(raw))


# ── Дни и периоды ─────────────────────────────────────────────────────────────

def next_day(d: date, working: bool) -> date:
    """Прибавляет 1 календарный или 1 рабочий день."""
    d += timedelta(days=1)
    if working:
        while d.weekday() >= 5:
            d += timedelta(days=1)
    return d


def count_days(start: date, end_ex: date, working: bool) -> int:
    """Количество дней от start (включ.) до end_ex (не включ.)."""
    if not working:
        return max(0, (end_ex - start).days)
    n, c = start, 0
    while n < end_ex:
        if n.weekday() < 5:
            c += 1
        n += timedelta(days=1)
    return c


# ── Неустойка (формула) ───────────────────────────────────────────────────────

def penalty(amount: Decimal, rate: Decimal, days: int, per_year: bool) -> Decimal:
    if per_year:
        p = amount * rate / Decimal(100) / Decimal(365) * days
    else:
        p = amount * rate / Decimal(100) * days
    return p.quantize(Decimal("0.01"), ROUND_HALF_UP)


def formula_text(amount: Decimal, days: int, rate_text: str, per_year: bool) -> str:
    base = f"{fmt(amount)} × {days} × {rate_text}%"
    return base + "/365" if per_year else base


# ── Кавычки ───────────────────────────────────────────────────────────────────

def normalize_quotes(text: str) -> str:
    """Заменяет ВСЕ виды кавычек на ёлочки «»."""
    if not text:
        return text
    for open_q, close_q in (
        ("\u201c", "\u201d"), ("\u201e", "\u201d"), ("\u201e", "\u201c"),
        ("\u2018", "\u2019"), ("\u201b", "\u2019"), ("\u201f", "\u201d"),
    ):
        text = text.replace(open_q, "«").replace(close_q, "»")
    if '"' in text:
        parts, count = [], 0
        for ch in text:
            if ch == '"':
                parts.append("«" if count % 2 == 0 else "»")
                count += 1
            else:
                parts.append(ch)
        text = "".join(parts)
    text = text.replace("»«", "» «")
    return text


def strip_all_quotes(text: str) -> str:
    """Удаляет все виды кавычек для последующей обёртки в ёлочки."""
    _QUOTES = '"\'\u00ab\u00bb\u201c\u201d\u201e\u201f\u2018\u2019\u201b'
    for ch in _QUOTES:
        text = text.replace(ch, "")
    return text.strip()


# ── Договор и номер счёта ────────────────────────────────────────────────────

_CONTRACT_RE = re.compile(
    r"^(.*?)\s+от\s+(\d{1,2}\.\d{1,2}\.\d{2,4})\s*$", re.IGNORECASE
)
_NUMBER_PREFIX_RE = re.compile(r"^[A-Za-zА-Яа-яЁё]+-")


def parse_contract_ref(raw: str) -> Tuple[str, str, str]:
    """
    '1002/25-НП3 от 10.02.2025' → (полная_строка, номер, дата).
    Если формат не распознан — (raw, raw, '').
    """
    raw = (raw or "").strip()
    m = _CONTRACT_RE.match(raw)
    if m:
        return raw, m.group(1).strip(), m.group(2).strip()
    return raw, raw, ""


def strip_number_prefix(number: str) -> str:
    """'ТРБП-034509' → '034509'. Убирает буквенный префикс с дефисом."""
    return _NUMBER_PREFIX_RE.sub("", number, count=1)


# ── Имя файла ─────────────────────────────────────────────────────────────────

def sanitize_filename(text: str, fallback: str = "Документ") -> str:
    """Очищает строку для имени файла (убирает запрещённые символы)."""
    cleaned = re.sub(r'[\\/:*?"<>|]', "", (text or "")).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned or fallback
