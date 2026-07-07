# -*- coding: utf-8 -*-
"""
core/duty.py
────────────
Расчёт государственной пошлины (ст. 333.21 НК РФ) и сумма прописью.

calculate_state_duty() сохраняет исходную сигнатуру (float→float) для
совместимости с существующими вызовами. Округление — через Decimal
с ROUND_HALF_UP (копейки < 50 отбрасываются, ≥ 50 округляются вверх).
"""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

from ..config import (
    GP_BRACKETS,
    GP_BASE_ABOVE_50M,
    GP_RATE_ABOVE_50M,
    GP_MAX_VARIABLE_PART_ABOVE_50M,
)

try:
    from num2words import num2words as _num2words
    _NUM2WORDS_OK = True
except Exception:
    _NUM2WORDS_OK = False


def calculate_state_duty(claim_amount: float) -> float:
    """
    Размер госпошлины (в рублях, целые рубли) для цены иска.
    Расчёт строго по ст. 333.21 НК РФ.
    """
    if claim_amount is None:
        raise ValueError("Сумма иска не указана")
    if claim_amount <= 0:
        raise ValueError("Сумма иска должна быть больше нуля")

    amount = float(claim_amount)

    if amount <= 100_000:
        duty = 10_000.0
    else:
        duty = None
        for upper_bound, lower_bound, rate, base in GP_BRACKETS:
            if amount <= upper_bound:
                duty = base + (amount - lower_bound) * rate
                break
        if duty is None:
            variable_part = min(
                (amount - 50_000_000) * GP_RATE_ABOVE_50M,
                GP_MAX_VARIABLE_PART_ABOVE_50M,
            )
            duty = GP_BASE_ABOVE_50M + variable_part

    duty_decimal = Decimal(str(round(duty, 2))).quantize(
        Decimal("1"), rounding=ROUND_HALF_UP
    )
    return float(duty_decimal)


def plural_form(n: int, one: str, few: str, many: str) -> str:
    """Верная форма слова после числительного (русское склонение)."""
    n_abs = abs(n)
    last_two = n_abs % 100
    last_one = n_abs % 10
    if 11 <= last_two <= 14:
        return many
    if last_one == 1:
        return one
    if 2 <= last_one <= 4:
        return few
    return many


def amount_in_words(amount: float) -> str:
    """
    Сумма прописью: рубли словами, копейки цифрами —
    «Один миллион ... рублей 00 копеек».
    """
    if not _NUM2WORDS_OK:
        raise RuntimeError("Библиотека num2words не установлена.")
    if amount < 0:
        raise ValueError("Сумма не может быть отрицательной")

    rubles = int(amount)
    kopecks = round((amount - rubles) * 100)
    if kopecks == 100:
        rubles += 1
        kopecks = 0

    rubles_words = "ноль" if rubles == 0 else _num2words(rubles, lang="ru")
    rubles_words = rubles_words[0].upper() + rubles_words[1:]

    rub_form = plural_form(rubles, "рубль", "рубля", "рублей")
    kop_form = plural_form(kopecks, "копейка", "копейки", "копеек")

    return f"{rubles_words} {rub_form} {kopecks:02d} {kop_form}"
