# -*- coding: utf-8 -*-
"""
Слой логики: расчёт государственной пошлины.

Этот модуль ничего не знает об интерфейсе. Он предоставляет чистые функции,
которые принимают простые данные и возвращают простые данные (dict/число),
пригодные для сериализации в JSON и передачи фронтенду.
"""
from __future__ import annotations

from decimal import Decimal

from legal_tools.core.duty import calculate_state_duty, amount_in_words


def calculate_duty_for_claim_amount(claim_amount: float) -> dict:
    """
    Рассчитывает государственную пошлину для заданной цены иска.

    Принимает цену иска в рублях и возвращает словарь с суммой пошлины
    числом и той же суммой прописью. Расчёт выполняется по ст. 333.21 НК РФ.
    """
    duty_amount = calculate_state_duty(claim_amount)
    return {
        "duty_amount": duty_amount,
        "duty_amount_in_words": amount_in_words(duty_amount),
    }
