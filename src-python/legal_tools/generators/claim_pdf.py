# -*- coding: utf-8 -*-
"""
generators/claim_pdf.py
───────────────────────
Генерация досудебной претензии в PDF (reportlab) по образцу
«Претензия драфт.pdf», с вшитыми факсимиле (подпись + печать).

PDF собирается «с нуля» (как платёжка в payment_pdf.py), поэтому раскладка
полностью под контролем. Подпись и печать рисуются ВНУТРИ отдельного
flowable фиксированной высоты (SignatureBlock): он резервирует своё место в
потоке, и наложение картинок физически не может сдвинуть текст или разрывы
страниц. Белый фон JPEG-ов убирается параметром mask (белый → прозрачный).
"""
from __future__ import annotations

import io
import os
from xml.sax.saxutils import escape

from ..config import (
    LAW_PLAINTIFF_NAME, LAW_PLAINTIFF_INN, LAW_PLAINTIFF_OGRN,
    LAW_PLAINTIFF_ADDRESS, LAW_PLAINTIFF_EMAIL,
    CLAIM_PLAINTIFF_KPP, CLAIM_PLAINTIFF_PHONE, CLAIM_PLAINTIFF_SITE,
    GP_FONT_REGULAR, GP_FONT_BOLD,
)
from ..assets.embedded import (
    get_font_regular_bytes, get_font_bold_bytes,
    get_claim_signature_bytes, get_claim_stamp_bytes, get_claim_logo_bytes,
)
from . import claim_text

try:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib import colors as _rl_colors
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.enums import TA_LEFT, TA_RIGHT, TA_CENTER, TA_JUSTIFY
    from reportlab.lib.utils import ImageReader
    from reportlab.platypus import (
        SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Flowable, Image,
    )
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    _REPORTLAB_OK = True
except Exception:
    _REPORTLAB_OK = False

_fonts_registered = False
# Имена шрифтов, которыми реально рендерится претензия. По умолчанию —
# встроенный DejaVu, но _register_fonts заменяет их на Calibri Light/Bold,
# если те есть в системе (чтобы PDF визуально совпадал с DOCX-версией).
_FONT_REGULAR = GP_FONT_REGULAR
_FONT_BOLD = GP_FONT_BOLD
# Диапазон «почти белого», который drawImage делает прозрачным, чтобы белый
# фон JPEG-факсимиле не закрывал текст и не перекрывал подпись/печать.
_WHITE_MASK = [235, 255, 235, 255, 235, 255]
_LOGO_BLUE = _rl_colors.HexColor("#2563EB") if _REPORTLAB_OK else None


if _REPORTLAB_OK:

    def _system_font_path(filename: str):
        """Путь к системному шрифту Windows или None, если файла нет."""
        windir = os.environ.get("WINDIR", r"C:\Windows")
        path = os.path.join(windir, "Fonts", filename)
        return path if os.path.exists(path) else None

    def _register_fonts():
        """
        Регистрирует шрифты для PDF претензии.

        Приоритетно берёт системный Calibri Light (обычный) и Calibri Bold
        (жирный), чтобы PDF был визуально идентичен DOCX (тот использует
        «Calibri Light» 11). Если Calibri в системе нет — откатывается на
        встроенный DejaVu, чтобы генерация не падала. Связывает начертания в
        семейство, иначе inline-теги <b> в абзацах не переключаются на жирный.
        """
        global _fonts_registered, _FONT_REGULAR, _FONT_BOLD
        if _fonts_registered:
            return

        calibri_light = _system_font_path("calibril.ttf")
        calibri_bold = _system_font_path("calibrib.ttf")
        if calibri_light and calibri_bold:
            _FONT_REGULAR, _FONT_BOLD = "CalibriLight", "CalibriBold"
            pdfmetrics.registerFont(TTFont(_FONT_REGULAR, calibri_light))
            pdfmetrics.registerFont(TTFont(_FONT_BOLD, calibri_bold))
        else:
            _FONT_REGULAR, _FONT_BOLD = GP_FONT_REGULAR, GP_FONT_BOLD
            pdfmetrics.registerFont(TTFont(_FONT_REGULAR, io.BytesIO(get_font_regular_bytes())))
            pdfmetrics.registerFont(TTFont(_FONT_BOLD, io.BytesIO(get_font_bold_bytes())))

        pdfmetrics.registerFontFamily(
            _FONT_REGULAR,
            normal=_FONT_REGULAR, bold=_FONT_BOLD,
            italic=_FONT_REGULAR, boldItalic=_FONT_BOLD,
        )
        _fonts_registered = True

    def _style(name, *, size=11, bold=False, align=TA_LEFT, leading=None, color=None):
        return ParagraphStyle(
            name,
            fontName=_FONT_BOLD if bold else _FONT_REGULAR,
            fontSize=size,
            leading=leading if leading is not None else size + 2.5,
            alignment=align,
            textColor=color if color is not None else _rl_colors.black,
        )

    def _runs_to_markup(runs) -> str:
        """Склеивает раны (текст, bold) в inline-разметку reportlab с <b>."""
        parts = []
        for text, bold in runs:
            safe = escape(text)
            parts.append(f"<b>{safe}</b>" if bold else safe)
        return "".join(parts)

    class SignatureBlock(Flowable):
        """
        Блок подписанта фиксированной высоты с наложенными факсимиле.

        Резервирует в потоке прямоугольник постоянной высоты и внутри него
        рисует строку «должность … ФИО» и (если with_facsimile) подпись и
        печать. Факсимиле центрируются РОВНО в зазоре между «должностью»
        (слева) и «ФИО» (справа): по горизонтали — по центру зазора, по
        вертикали — по центру строки подписанта. Так как высота блока
        фиксирована, наложение картинок не сдвигает текст и разрывы страниц.
        """

        HEIGHT = 27 * mm
        TEXT_Y = 12 * mm            # базовая линия строки подписанта в блоке
        FONT_SIZE = 11

        def __init__(self, title: str, name: str, with_facsimile: bool = True):
            super().__init__()
            self.title = title
            self.name = name
            self.with_facsimile = with_facsimile
            self.width = 0

        def wrap(self, avail_width, avail_height):
            self.width = avail_width
            return (avail_width, self.HEIGHT)

        def draw(self):
            canvas = self.canv
            canvas.setFont(_FONT_REGULAR, self.FONT_SIZE)
            canvas.drawString(0, self.TEXT_Y, self.title)
            canvas.drawRightString(self.width, self.TEXT_Y, self.name)

            if not self.with_facsimile:
                return

            # Зазор между концом «должности» и началом «ФИО» и его центр.
            title_w = pdfmetrics.stringWidth(self.title, _FONT_REGULAR, self.FONT_SIZE)
            name_w = pdfmetrics.stringWidth(self.name, _FONT_REGULAR, self.FONT_SIZE)
            gap_center_x = (title_w + (self.width - name_w)) / 2.0
            # Вертикальный центр строки (≈ середина заглавной высоты шрифта).
            line_center_y = self.TEXT_Y + self.FONT_SIZE * 0.32

            sig_w = 40 * mm
            sig_h = sig_w * 79.0 / 332.0
            stamp_w = 26 * mm
            stamp_h = stamp_w * 155.0 / 164.0

            # Кластер «подпись + печать»: подпись слева, печать справа с
            # небольшим нахлёстом. Весь кластер центрируется по зазору.
            overlap = 10 * mm
            cluster_w = sig_w + stamp_w - overlap
            origin_x = gap_center_x - cluster_w / 2.0
            sig_x = origin_x
            stamp_x = origin_x + sig_w - overlap

            sig = ImageReader(io.BytesIO(get_claim_signature_bytes()))
            canvas.drawImage(
                sig, sig_x, line_center_y - sig_h / 2.0,
                width=sig_w, height=sig_h, mask=_WHITE_MASK,
            )
            stamp = ImageReader(io.BytesIO(get_claim_stamp_bytes()))
            canvas.drawImage(
                stamp, stamp_x, line_center_y - stamp_h / 2.0,
                width=stamp_w, height=stamp_h, mask=_WHITE_MASK,
            )

    def _build_letterhead(full_width):
        """Фирменная шапка: логотип «trivio» + два столбца реквизитов."""
        logo_width = 38 * mm
        logo_height = logo_width * 750.0 / 1449.0
        logo = Image(io.BytesIO(get_claim_logo_bytes()), width=logo_width, height=logo_height)
        logo.hAlign = "LEFT"
        org = Paragraph(
            f"<b>{escape(LAW_PLAINTIFF_NAME)}</b><br/>ИНН {LAW_PLAINTIFF_INN}"
            f"<br/>КПП {CLAIM_PLAINTIFF_KPP}<br/>ОГРН {LAW_PLAINTIFF_OGRN}",
            _style("org", size=8.5, leading=11),
        )
        contact = Paragraph(
            f"{escape(LAW_PLAINTIFF_ADDRESS)}<br/>{escape(CLAIM_PLAINTIFF_PHONE)}"
            f"<br/>{escape(LAW_PLAINTIFF_EMAIL)} | {CLAIM_PLAINTIFF_SITE}",
            _style("contact", size=8.5, leading=11),
        )
        widths = [40 * mm, full_width - 115 * mm, 75 * mm]
        table = Table([[logo, org, contact]], colWidths=widths)
        table.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]))
        return table

    def _build_reference_row(ctx, full_width):
        """Строка «Исх. № … от …» (слева) и должник + адрес (справа)."""
        left = Paragraph(
            escape(claim_text.letter_reference(ctx["claim_number"], ctx["claim_date"])),
            _style("ref", size=11),
        )
        recipient = f"<b>{escape(ctx['defendant_name'])}</b>"
        address = (ctx.get("defendant_address") or "").strip()
        if address:
            recipient += f"<br/>{escape(address)}"
        right = Paragraph(recipient, _style("recipient", size=10, align=TA_RIGHT, leading=13))
        table = Table([[left, right]], colWidths=[full_width * 0.5, full_width * 0.5])
        table.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]))
        return table

    def generate_claim_pdf(path: str, ctx: dict, with_facsimile: bool = True) -> str:
        """
        Формирует PDF досудебной претензии по образцу и сохраняет в path.

        ctx: defendant_name, defendant_address, claim_number (голый), claim_date
        (date), contract_number, contract_date (date|None), debt_amount (Decimal).
        with_facsimile управляет наложением подписи и печати (по умолчанию — да).
        """
        _register_fonts()

        left_margin, right_margin = 20 * mm, 15 * mm
        full_width = A4[0] - left_margin - right_margin

        doc = SimpleDocTemplate(
            path, pagesize=A4,
            leftMargin=left_margin, rightMargin=right_margin,
            topMargin=14 * mm, bottomMargin=12 * mm,
            title="Досудебная претензия",
        )

        # Межстрочный интервал и отступы подобраны так, чтобы письмо со всей
        # подписью гарантированно помещалось на ОДНУ страницу A4 (в т.ч. при
        # длинном 3-строчном адресе получателя). Шрифт — Calibri Light 11, как
        # в DOCX-версии.
        body_style = _style("body", size=11, align=TA_JUSTIFY, leading=15.5)
        body_style.firstLineIndent = 12.5 * mm
        body_style.spaceAfter = 5

        elements = [
            _build_letterhead(full_width),
            Spacer(1, 6 * mm),
            _build_reference_row(ctx, full_width),
            Spacer(1, 6 * mm),
            Paragraph(escape(claim_text.LETTER_TITLE), _style("title", size=11, bold=True, align=TA_CENTER)),
            Spacer(1, 5 * mm),
        ]
        for paragraph_runs in claim_text.letter_body(ctx):
            elements.append(Paragraph(_runs_to_markup(paragraph_runs), body_style))

        elements.append(Spacer(1, 6 * mm))
        title_text, name_text = claim_text.signatory()
        elements.append(SignatureBlock(title_text, name_text, with_facsimile=with_facsimile))

        doc.build(elements)
        return path

else:
    def generate_claim_pdf(*args, **kwargs) -> str:
        raise RuntimeError("Библиотека reportlab не установлена.")
