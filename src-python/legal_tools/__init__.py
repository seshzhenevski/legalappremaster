# -*- coding: utf-8 -*-
"""
legal_tools
───────────
Юридический инструментарий: генерация исков, сортировка документов,
расчёт неустойки и госпошлины.

Запуск:  python -m legal_tools

Структура пакета:
  config            — все константы (реквизиты, шкала госпошлины)
  core/             — чистая бизнес-логика (без UI и I/O)
      formatting    — форматирование, парсинг дат/сумм, кавычки
      penalty       — расчёт неустойки, FIFO-распределение платежей
      duty          — госпошлина (ст. 333.21 НК РФ), сумма прописью
  generators/       — генерация выходных файлов
      lawsuit_docx  — исковое заявление и опись (python-docx)
      payment_pdf   — платёжное поручение (reportlab)
  importers/        — чтение входных данных
      excel         — реестр счетов, группировка, расчёт иска
      document_sorter — поиск и слияние PDF закрывающих документов
  assets/embedded   — встроенные шрифты и шаблоны (base64)
  ui/               — слой представления (PySide6)
"""
from .config import APP_VERSION, APP_TITLE

__version__ = APP_VERSION
__all__ = ["APP_VERSION", "APP_TITLE"]
