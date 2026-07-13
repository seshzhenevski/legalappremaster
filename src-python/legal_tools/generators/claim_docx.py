# -*- coding: utf-8 -*-
"""
generators/claim_docx.py
────────────────────────
Генерация досудебной претензии в DOCX (python-docx) по образцу
«Претензия драфт.pdf». Это редактируемая версия письма — БЕЗ факсимиле
(подпись и печать вшиваются только в PDF, см. claim_pdf.py).

Шапка повторяет фирменный бланк АО «Тривио»: слева словесный логотип
«trivio», справа — два столбца реквизитов. Текст тела и подписант берутся
из claim_text.py (единый источник для DOCX и PDF).
"""
from __future__ import annotations

import io

from ..config import (
    LAW_PLAINTIFF_NAME, LAW_PLAINTIFF_INN, LAW_PLAINTIFF_OGRN,
    LAW_PLAINTIFF_ADDRESS, LAW_PLAINTIFF_EMAIL,
    CLAIM_PLAINTIFF_KPP, CLAIM_PLAINTIFF_PHONE, CLAIM_PLAINTIFF_SITE,
)
from ..assets.embedded import get_claim_logo_bytes
from . import claim_text

try:
    from docx import Document as DocxDocument
    from docx.shared import Pt as DocxPt, Cm as DocxCm, RGBColor as DocxRGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
    from docx.enum.table import WD_TABLE_ALIGNMENT
    _DOCX_OK = True
except Exception:
    _DOCX_OK = False

_BODY_FONT = "Calibri Light"
_LOGO_BLUE = (0x25, 0x63, 0xEB)


def _run(paragraph, text, *, bold=False, size=11, font=_BODY_FONT, color=None):
    """Добавляет оформленный ран в абзац и возвращает его."""
    r = paragraph.add_run(text)
    r.font.name = font
    r.font.size = DocxPt(size)
    r.bold = bold
    if color is not None:
        r.font.color.rgb = DocxRGBColor(*color)
    return r


def _blank_line(doc, size=11):
    """Пустой абзац фиксированной высоты (визуальный отступ)."""
    p = doc.add_paragraph()
    p.paragraph_format.space_before = DocxPt(0)
    p.paragraph_format.space_after = DocxPt(0)
    _run(p, "", size=size)
    return p


def _borderless_table(doc, col_widths_cm):
    """
    Создаёт таблицу без рамок с фиксированной шириной столбцов.

    Стиль по умолчанию у python-docx уже без видимых границ — используется
    как невидимая сетка для раскладки шапки, строки реквизита и подписанта.
    """
    table = doc.add_table(rows=1, cols=len(col_widths_cm))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    for row in table.rows:
        for idx, width_cm in enumerate(col_widths_cm):
            row.cells[idx].width = DocxCm(width_cm)
    return table


def _cell_lines(cell, lines, *, size=8.5, bold_first=False, align=None):
    """
    Заполняет ячейку набором строк (каждая — своим абзацем).

    lines — список строк; bold_first делает первую строку жирной (для
    названия организации в блоке реквизитов).
    """
    cell.text = ""
    for line_index, text in enumerate(lines):
        paragraph = cell.paragraphs[0] if line_index == 0 else cell.add_paragraph()
        paragraph.paragraph_format.space_before = DocxPt(0)
        paragraph.paragraph_format.space_after = DocxPt(0)
        if align is not None:
            paragraph.alignment = align
        _run(paragraph, text, bold=bold_first and line_index == 0, size=size)


def _build_letterhead(doc):
    """
    Строит фирменную шапку: словесный логотип «trivio» + два столбца реквизитов.

    Логотип воспроизводится текстом (отдельного файла-логотипа нет), реквизиты
    берутся из config. Таблица без рамок — как в образце.
    """
    table = _borderless_table(doc, [4.2, 6.0, 7.0])
    logo_cell, org_cell, contact_cell = table.rows[0].cells

    logo_cell.text = ""
    logo_paragraph = logo_cell.paragraphs[0]
    logo_paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
    logo_paragraph.add_run().add_picture(io.BytesIO(get_claim_logo_bytes()), width=DocxCm(3.8))

    _cell_lines(
        org_cell,
        [
            LAW_PLAINTIFF_NAME,
            f"ИНН {LAW_PLAINTIFF_INN}",
            f"КПП {CLAIM_PLAINTIFF_KPP}",
            f"ОГРН {LAW_PLAINTIFF_OGRN}",
        ],
        bold_first=True,
    )
    _cell_lines(
        contact_cell,
        [
            LAW_PLAINTIFF_ADDRESS,
            CLAIM_PLAINTIFF_PHONE,
            f"{LAW_PLAINTIFF_EMAIL} | {CLAIM_PLAINTIFF_SITE}",
        ],
    )


def _build_reference_row(doc, ctx):
    """Строка под шапкой: слева «Исх. № … от …», справа — должник и адрес."""
    table = _borderless_table(doc, [8.6, 8.6])
    left_cell, right_cell = table.rows[0].cells

    _cell_lines(left_cell, [claim_text.letter_reference(ctx["claim_number"], ctx["claim_date"])], size=11)

    recipient_lines = [ctx["defendant_name"]]
    address = (ctx.get("defendant_address") or "").strip()
    if address:
        recipient_lines.append(address)
    _cell_lines(right_cell, recipient_lines, size=11, align=WD_ALIGN_PARAGRAPH.RIGHT)


def generate_claim_docx(path: str, ctx: dict) -> None:
    """
    Строит DOCX досудебной претензии по образцу и сохраняет в path.

    ctx содержит: defendant_name, defendant_address, claim_number (голый),
    claim_date (date), contract_number, contract_date (date|None), debt_amount
    (Decimal). Факсимиле НЕ добавляется — это редактируемая версия письма.
    """
    if not _DOCX_OK:
        raise RuntimeError("Библиотека python-docx не установлена.")

    doc = DocxDocument()
    section = doc.sections[0]
    section.page_width = DocxCm(21.0)
    section.page_height = DocxCm(29.7)
    section.top_margin = DocxCm(1.5)
    section.bottom_margin = DocxCm(1.5)
    section.left_margin = DocxCm(2.0)
    section.right_margin = DocxCm(1.5)

    normal = doc.styles["Normal"]
    normal.font.name = _BODY_FONT
    normal.font.size = DocxPt(11)
    normal.paragraph_format.space_before = DocxPt(0)
    normal.paragraph_format.space_after = DocxPt(0)

    _build_letterhead(doc)
    _blank_line(doc)
    _build_reference_row(doc, ctx)
    _blank_line(doc)

    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _run(title, claim_text.LETTER_TITLE, bold=True)
    _blank_line(doc)

    for paragraph_runs in claim_text.letter_body(ctx):
        paragraph = doc.add_paragraph()
        paragraph.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        paragraph.paragraph_format.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
        paragraph.paragraph_format.line_spacing = 1.5
        paragraph.paragraph_format.first_line_indent = DocxCm(1.25)
        for text, bold in paragraph_runs:
            _run(paragraph, text, bold=bold)

    _blank_line(doc)
    _blank_line(doc)

    title_text, name_text = claim_text.signatory()
    signatory_table = _borderless_table(doc, [11.0, 6.2])
    left_cell, right_cell = signatory_table.rows[0].cells
    _cell_lines(left_cell, [title_text], size=11)
    _cell_lines(right_cell, [name_text], size=11, align=WD_ALIGN_PARAGRAPH.RIGHT)

    doc.save(path)
