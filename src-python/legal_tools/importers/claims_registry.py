# -*- coding: utf-8 -*-
"""
claims_registry.py
──────────────────
Чтение реестра отправленных претензий «ОТПРАВКИ ПРЕТЕНЗИЙ.xlsx» для дашборда.

Модуль знает только про доступ к файлу: открывает книгу на общей сетевой папке
и отдаёт сырые строки листа. Что означают колонки и как считать показатели —
дело слоя логики. Реестр только читается: запись в него делает генератор
претензий, дашборд к нему не прикасается.
"""
from __future__ import annotations

from pathlib import Path

from legal_tools.config import CLAIM_REGISTRY_FILENAME, CLAIM_REGISTRY_DEFAULT_FOLDER


class ClaimsRegistryError(RuntimeError):
    """Ошибка доступа к реестру претензий с текстом для показа пользователю."""


def read_claims_registry_rows(registry_folder: str | None = None) -> list[list]:
    """
    Читает лист реестра претензий и возвращает его строки.

    Принимает папку с реестром (по умолчанию — общая сетевая папка юротдела из
    конфига). Возвращает строки листа как список списков значений, включая
    строку заголовков. Бросает ClaimsRegistryError с понятным текстом, если
    сетевая папка недоступна, файла нет или он открыт в Excel монопольно.
    """
    folder = registry_folder or CLAIM_REGISTRY_DEFAULT_FOLDER
    registry_path = Path(folder) / CLAIM_REGISTRY_FILENAME

    try:
        import openpyxl
    except ImportError as error:
        raise ClaimsRegistryError(
            "Не установлена библиотека openpyxl для чтения реестра претензий."
        ) from error

    if not registry_path.exists():
        raise ClaimsRegistryError(
            f"Реестр претензий не найден: {registry_path}. Проверьте доступ к сетевой "
            "папке юридического департамента (диск Z:)."
        )

    try:
        workbook = openpyxl.load_workbook(registry_path, data_only=True, read_only=True)
    except PermissionError as error:
        raise ClaimsRegistryError(
            "Реестр претензий открыт в Excel монопольно. Закройте файл и обновите дашборд."
        ) from error
    except Exception as error:
        raise ClaimsRegistryError(
            "Не удалось прочитать реестр претензий — возможно, файл повреждён."
        ) from error

    try:
        worksheet = workbook.active
        return [list(row) for row in worksheet.iter_rows(values_only=True)]
    finally:
        workbook.close()
