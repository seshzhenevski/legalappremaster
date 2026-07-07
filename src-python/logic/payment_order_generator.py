# -*- coding: utf-8 -*-
"""
Слой логики: генерация платёжного поручения на госпошлину отдельно от иска.

Оборачивает готовый генератор PDF (legal_tools.generators.payment_pdf) в
функцию с простыми входными данными для вкладки «Калькулятор госпошлины».
"""
from __future__ import annotations

from datetime import date

from legal_tools.generators.payment_pdf import generate_payment_order


def parse_iso_date(iso_date_string: str) -> date:
    """
    Преобразует строку даты формата ГГГГ-ММ-ДД в объект date.

    Фронтенд передаёт даты в ISO-формате (из <input type="date">),
    эта функция превращает их в питоновский date для генератора PDF.
    """
    year, month, day = (int(part) for part in iso_date_string.split("-"))
    return date(year, month, day)


def generate_state_duty_payment_order(
    output_path: str,
    duty_amount: float,
    defendant_name: str,
    claim_amount: float,
    payment_date: str | None = None,
) -> dict:
    """
    Формирует PDF-файл платёжного поручения на госпошлину.

    Принимает путь сохранения, сумму пошлины, наименование ответчика, сумму
    иска и необязательную дату платежа (ISO-строка). Возвращает путь к
    созданному файлу.
    """
    generate_payment_order(
        path=output_path,
        duty_amount=float(duty_amount),
        defendant_name=defendant_name,
        claim_amount=float(claim_amount),
        payment_date=parse_iso_date(payment_date) if payment_date else None,
    )
    return {"created_file": output_path}
