# -*- coding: utf-8 -*-
"""
generators/payment_pdf.py
─────────────────────────
Генерация платёжного поручения на госпошлину (reportlab, PDF).
Форма близка к ОКУД 0401060. Шрифты DejaVu берутся из assets.embedded.
"""
from __future__ import annotations

import io
from datetime import date
from decimal import Decimal

from ..config import (
    GP_PLAINTIFF, GP_RECIPIENT, GP_VID_OPERATSII, GP_OCHEREDNOST_PLATEZHA,
    GP_TAX_FIELDS_ZERO, GP_FONT_REGULAR, GP_FONT_BOLD,
)
from ..core.duty import amount_in_words
from ..assets.embedded import get_font_regular_bytes, get_font_bold_bytes

try:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib import colors as _rl_colors
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.enums import TA_LEFT, TA_CENTER
    from reportlab.platypus import (
        SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer,
    )
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    _REPORTLAB_OK = True
except Exception:
    _REPORTLAB_OK = False

_gp_fonts_registered = False


if _REPORTLAB_OK:


    def _gp_register_fonts():
        global _gp_fonts_registered
        if _gp_fonts_registered:
            return
        regular_bytes = get_font_regular_bytes()
        bold_bytes = get_font_bold_bytes()
        pdfmetrics.registerFont(TTFont(GP_FONT_REGULAR, io.BytesIO(regular_bytes)))
        pdfmetrics.registerFont(TTFont(GP_FONT_BOLD, io.BytesIO(bold_bytes)))
        _gp_fonts_registered = True

    def _gp_style(size=9.5, bold=False, center=False, color=_rl_colors.black):
        return ParagraphStyle(
            f"gp{size}{bold}{center}", fontName=GP_FONT_BOLD if bold else GP_FONT_REGULAR,
            fontSize=size, leading=size + 2.5,
            alignment=TA_CENTER if center else TA_LEFT,
            textColor=color,
        )

    def _gp_caption_style(center=False):
        return ParagraphStyle(
            "gpCaption", fontName=GP_FONT_REGULAR, fontSize=7.5, leading=9,
            alignment=TA_CENTER if center else TA_LEFT,
            textColor=_rl_colors.HexColor("#444444"),
        )

    def _gp_cap(text, center=False):
        return Paragraph(text, _gp_caption_style(center=center))

    def _gp_field(label: str, value: str = "", bold_value: bool = False) -> Paragraph:
        """Поле вида «Метка значение» в одну строку (как заполняется в реальном поручении)."""
        text = f"{label}&nbsp;&nbsp;{value}".strip() if value else label
        style = _gp_style(bold=bold_value)
        return Paragraph(text, style)

    def _gp_money(value: float) -> str:
        return f"{value:,.2f}".replace(",", " ").replace(".", ",") + " руб."

    def generate_payment_order(
        path: str,
        duty_amount: float,
        defendant_name: str,
        claim_amount: float,
        payment_date=None,
    ) -> str:
        """Формирует PDF-файл платёжного поручения на уплату госпошлины."""
        _gp_register_fonts()

        if payment_date is None:
            payment_date = date.today()
        date_str = payment_date.strftime("%d.%m.%Y")

        payer = GP_PLAINTIFF
        recipient = GP_RECIPIENT

        amount_str = _gp_money(duty_amount)
        amount_words = amount_in_words(duty_amount)
        claim_amount_str = _gp_money(claim_amount)

        purpose_text = (
            f"Государственная пошлина за рассмотрение иска к {defendant_name} "
            f"на сумму {claim_amount_str} в {recipient['court_name']}"
        )

        doc = SimpleDocTemplate(
            path, pagesize=A4,
            leftMargin=15 * mm, rightMargin=15 * mm,
            topMargin=14 * mm, bottomMargin=12 * mm,
            title="Платёжное поручение — госпошлина",
        )

        FULL = 180 * mm
        GRID = _rl_colors.HexColor("#000000")
        elements = []

        # 1. «Поступ. в банк плат.» / «Списано со сч. плат.»
        w = [72 * mm, 12 * mm, 72 * mm, 24 * mm]
        t1 = Table(
            [
                [Paragraph("&nbsp;", _gp_style()), "", Paragraph("&nbsp;", _gp_style()), ""],
                [_gp_cap("Поступ. в банк плат."), "", _gp_cap("Списано со сч. плат."), ""],
            ],
            colWidths=w,
        )
        t1.setStyle(TableStyle([
            ("LINEBELOW", (0, 0), (0, 0), 0.6, GRID),
            ("LINEBELOW", (2, 0), (2, 0), 0.6, GRID),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 1),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
        ]))
        elements.append(t1)
        elements.append(Spacer(1, 5 * mm))

        # 2. Заголовок: № поручения / Дата / Вид платежа
        w2 = [98 * mm, 42 * mm, 40 * mm]
        title_cell = Paragraph('<b>ПЛАТЁЖНОЕ ПОРУЧЕНИЕ №</b>', _gp_style(size=12.5, bold=True))
        date_cell = Paragraph(date_str, _gp_style(size=10, center=True))
        vid_cell = Paragraph("&nbsp;", _gp_style(size=10, center=True))
        t2 = Table(
            [
                [title_cell, date_cell, vid_cell],
                ["", _gp_cap("Дата", center=True), _gp_cap("Вид платежа", center=True)],
            ],
            colWidths=w2,
        )
        t2.setStyle(TableStyle([
            ("LINEBELOW", (1, 0), (1, 0), 0.6, GRID),
            ("LINEBELOW", (2, 0), (2, 0), 0.6, GRID),
            ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 1),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
        ]))
        elements.append(t2)
        elements.append(Spacer(1, 3 * mm))

        # 3. «Сумма прописью» (без рамки)
        t3 = Table([[_gp_field("Сумма прописью", amount_words)]], colWidths=[FULL])
        t3.setStyle(TableStyle([
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 1),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
        ]))
        elements.append(t3)

        # 4. Основная таблица с рамкой (6 колонок)
        c0, c1, c2, c3, c4, c5 = 54.0 * mm, 50.4 * mm, 18.0 * mm, 10.8 * mm, 23.4 * mm, 23.4 * mm
        col_widths = [c0, c1, c2, c3, c4, c5]

        blank = Paragraph("&nbsp;", _gp_style())

        rows = [
            [_gp_field("ИНН", payer["inn"]), _gp_field("КПП", payer["kpp"]),
             _gp_field("Сумма", amount_str, bold_value=True), "", "", ""],
            [blank, "", _gp_field("Сч. №", payer["account"]), "", "", ""],
            [_gp_field("Плательщик", payer["name"], bold_value=True), "", "", "", "", ""],
            [blank, "", _gp_field("БИК", payer["bik"]), "", "", ""],
            [_gp_field("Банк плательщика", payer["bank_name"]), "",
             _gp_field("Сч. №", payer["bank_corr_account"]), "", "", ""],
            [_gp_field("Банк получателя", recipient["bank_name"]), "",
             _gp_field("БИК", recipient["bik"]), "", "", ""],
            ["", "", _gp_field("К/с №", recipient["bank_corr_account"]), "", "", ""],
            [_gp_field("ИНН", recipient["inn"]), _gp_field("КПП", recipient["kpp"]),
             _gp_field("Р/с №", recipient["account"]), "", "", ""],
            [_gp_field("Получатель", recipient["name"], bold_value=True), "",
             _gp_field("Вид оп.", GP_VID_OPERATSII), "", _gp_field("Срок плат."), ""],
            ["", "", _gp_field("Наз пл."), "", _gp_field("Очер. плат", GP_OCHEREDNOST_PLATEZHA), ""],
            ["", "", "", "", _gp_field("Рез. поле"), ""],
            [Paragraph(recipient["kbk"], _gp_style()), "", Paragraph(recipient["oktmo"], _gp_style()), "", None, ""],
        ]

        # мини-таблица для 5 нулевых полей (106–110)
        zero_w = (c4 + c5) / 5
        mini = Table([GP_TAX_FIELDS_ZERO], colWidths=[zero_w] * 5)
        mini.setStyle(TableStyle([
            ("GRID", (0, 0), (-1, -1), 0.6, GRID),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("FONTNAME", (0, 0), (-1, -1), GP_FONT_REGULAR),
            ("FONTSIZE", (0, 0), (-1, -1), 9.5),
            ("LEFTPADDING", (0, 0), (-1, -1), 2),
            ("RIGHTPADDING", (0, 0), (-1, -1), 2),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        rows[11][4] = mini

        style_cmds = [
            ("GRID", (0, 0), (-1, -1), 0.7, GRID),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("SPAN", (2, 0), (5, 0)),
            ("SPAN", (0, 1), (1, 1)), ("SPAN", (2, 1), (5, 1)),
            ("SPAN", (0, 2), (5, 2)),
            ("SPAN", (0, 3), (1, 3)), ("SPAN", (2, 3), (5, 3)),
            ("SPAN", (0, 4), (1, 4)), ("SPAN", (2, 4), (5, 4)),
            ("SPAN", (0, 5), (1, 6)),
            ("SPAN", (2, 5), (5, 5)),
            ("SPAN", (2, 6), (5, 6)),
            ("SPAN", (2, 7), (5, 7)),
            ("SPAN", (0, 8), (1, 10)),
            ("SPAN", (2, 8), (3, 8)), ("SPAN", (4, 8), (5, 8)),
            ("SPAN", (2, 9), (3, 9)), ("SPAN", (4, 9), (5, 9)),
            ("SPAN", (2, 10), (3, 10)), ("SPAN", (4, 10), (5, 10)),
            ("SPAN", (0, 11), (1, 11)), ("SPAN", (2, 11), (3, 11)), ("SPAN", (4, 11), (5, 11)),
            ("LEFTPADDING", (4, 11), (5, 11), 0),
            ("RIGHTPADDING", (4, 11), (5, 11), 0),
            ("TOPPADDING", (4, 11), (5, 11), 0),
            ("BOTTOMPADDING", (4, 11), (5, 11), 0),
            ("VALIGN", (0, 8), (1, 10), "TOP"),
        ]

        table4 = Table(rows, colWidths=col_widths, rowHeights=None)
        table4.setStyle(TableStyle(style_cmds))
        elements.append(table4)

        # 5. Назначение платежа (без рамки) + подписи
        elements.append(Spacer(1, 2.5 * mm))
        t5 = Table([[Paragraph(purpose_text, _gp_style(size=9.5))]], colWidths=[FULL])
        t5.setStyle(TableStyle([
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]))
        elements.append(t5)
        elements.append(Spacer(1, 6 * mm))

        t6 = Table(
            [[Paragraph("&nbsp;", _gp_style())], [_gp_cap("Назначение платежа")]],
            colWidths=[FULL],
        )
        t6.setStyle(TableStyle([
            ("LINEBELOW", (0, 0), (0, 0), 0.6, GRID),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 1),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
        ]))
        elements.append(t6)
        elements.append(Spacer(1, 14 * mm))

        t7 = Table([["", "Отметки банка", "Подписи"]], colWidths=[100 * mm, 45 * mm, 35 * mm])
        t7.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, -1), GP_FONT_REGULAR),
            ("FONTSIZE", (0, 0), (-1, -1), 9.5),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ]))
        elements.append(t7)

        doc.build(elements)
        return path


else:
    def generate_payment_order(*args, **kwargs) -> str:
        raise RuntimeError("Библиотека reportlab не установлена.")
