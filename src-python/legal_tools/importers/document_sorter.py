# -*- coding: utf-8 -*-
"""
importers/document_sorter.py
────────────────────────────
Поиск PDF-файлов закрывающих документов и сборка их в пакеты
(Счёт + Акт + УПД) с потоковым слиянием без загрузки в память.
"""
from __future__ import annotations

import re
import threading
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from ..config import LogTag


def _parse_date(date_str: str) -> Optional[datetime]:
    """Парсит дату из строки в форматах ДД.ММ.ГГГГ или ДД.ММ.ГГ."""
    for fmt in ("%d.%m.%Y", "%d.%m.%y"):
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            pass
    return None

try:
    from pypdf import PdfWriter, PdfReader
    _PYPDF_NEW = True
except Exception:
    from PyPDF2 import PdfMerger
    _PYPDF_NEW = False


def _merge_pdfs(file_paths: List[Path], out_path: Path) -> None:
    """
    Слияние PDF без загрузки всех файлов в память.

    PdfWriter.append(path) читает страницы потоково, а не держит весь файл
    в RAM. Это позволяет сливать десятки крупных PDF без риска нехватки
    памяти (раньше все исходники загружались в байтовые буферы целиком).
    """
    if _PYPDF_NEW:
        writer = PdfWriter()
        try:
            for path in file_paths:
                # append принимает путь и читает страницы по мере необходимости,
                # не загружая весь файл в память заранее.
                writer.append(str(path))
            with open(out_path, "wb") as f:
                writer.write(f)
        finally:
            writer.close()
    else:
        # Fallback на PyPDF2
        merger = PdfMerger()
        try:
            for path in file_paths:
                merger.append(str(path))
            merger.write(str(out_path))
        finally:
            merger.close()


class DocumentSorter:
    """Поиск PDF-файлов и сборка пакетов документов."""

    DOC_ORDER = {"счет": 0, "акт": 1, "упд": 2}

    # Паттерны компилируются один раз на уровне класса
    _PATTERNS: Dict[str, re.Pattern] = {
        "счет": re.compile(r"Счет на оплату № (\d+) от ([\d.]+)\.pdf"),
        "акт":  re.compile(r"Печатная форма Акт приема-передачи № (\d+) от ([\d.]+)\.pdf"),
        "упд":  re.compile(r"Печатная форма УПД №(\d+) от ([\d.]+)\.pdf"),
    }
    _INVOICE_RE = re.compile(r"Счет на оплату № (\d+) от ([\d.]+)")
    _ACT_RE     = re.compile(r"Акт приема-передачи № (\d+) от ([\d.]+)")
    _UPD_RE     = re.compile(r"УПД № (\d+) от ([\d.]+)")

    def __init__(self, source_folder: str, output_folder: str,
                 log_callback=None):
        self.source_folder = Path(source_folder)
        self.output_folder = Path(output_folder)
        self.output_folder.mkdir(parents=True, exist_ok=True)
        self._log = log_callback or (lambda m, t=LogTag.NORMAL: print(m))
        self._log_lock = threading.Lock()   # синхронизация лога между потоками

        # Оптимизация 1: индекс файлов — O(1) поиск вместо glob() на каждый документ
        self._log("🔍 Индексирование папки с файлами...")
        self._file_index: Dict[tuple, Path] = self._build_index()
        self._log(f"   Проиндексировано файлов: {len(self._file_index)}")

    def _build_index(self) -> Dict[tuple, Path]:
        """Один проход по папке → словарь (тип, номер, дата) → Path."""
        index: Dict[tuple, Path] = {}
        for file in self.source_folder.glob("*.pdf"):
            for doc_type, pattern in self._PATTERNS.items():
                m = pattern.search(file.name)
                if m:
                    d = _parse_date(m.group(2))
                    if d is not None:
                        index[(doc_type, m.group(1), d)] = file
                    break  # файл подходит только под один тип
        return index

    def _emit_log(self, lines: List[tuple]):
        """Выводит буфер лог-строк атомарно (блоком), чтобы не перемежались потоки."""
        with self._log_lock:
            for msg, tag in lines:
                self._log(msg, tag)

    def parse_invoice_info(self, invoice_text: str) -> List[dict]:
        invoices = []
        for block in re.split(r"(?=Счет на оплату)", invoice_text):
            if not block.strip():
                continue
            m = self._INVOICE_RE.search(block)
            if not m:
                continue
            related: List[dict] = []
            for act in self._ACT_RE.findall(block):
                related.append({"type": "акт", "number": act[0], "date": act[1]})
            for upd in self._UPD_RE.findall(block):
                related.append({"type": "упд", "number": upd[0], "date": upd[1]})
            invoices.append({
                "invoice_number":    m.group(1),
                "invoice_date":      m.group(2),
                "related_documents": related,
            })
        return invoices

    def find_file(self, doc_type: str, doc_number: str,
                  doc_date: str) -> Optional[Path]:
        """O(1) поиск через индекс."""
        d = _parse_date(doc_date)
        return self._file_index.get((doc_type, doc_number, d)) if d else None

    def create_invoice_package(self, invoice_data: dict,
                               idx: int = 0, total: int = 0) -> Optional[dict]:
        """
        Сборка одного пакета. Потокобезопасен: читает только _file_index (read-only).
        Весь лог — включая разделитель и заголовок — собирается в локальный буфер
        и выводится одним атомарным блоком, поэтому строки разных счетов
        никогда не перемешиваются.
        """
        number = invoice_data["invoice_number"]
        d = invoice_data["invoice_date"]

        # Собираем лог локально — выведем блоком в самом конце
        log_buf: List[tuple] = []

        # Разделитель и заголовок идут первыми в буфере — атомарно с остальным
        if idx and total:
            log_buf.append((f"\n{'─' * 50}", LogTag.NORMAL))
            log_buf.append((f"📄 [{idx}/{total}] Счет № {number}", LogTag.NORMAL))

        invoice_file = self.find_file("счет", number, d)
        if not invoice_file:
            log_buf.append(("❌ Файл счета не найден!", LogTag.WARN))
            self._emit_log(log_buf)
            return None

        log_buf.append((f"✓ Найден счет: {invoice_file.name}", LogTag.NORMAL))
        found = [{"type": "счет", "file": invoice_file}]

        for doc in invoice_data["related_documents"]:
            doc_file = self.find_file(doc["type"], doc["number"], doc["date"])
            if doc_file:
                log_buf.append(
                    (f"✓ Найден {doc['type'].upper()}: {doc_file.name}", LogTag.NORMAL)
                )
                found.append({"type": doc["type"], "file": doc_file})
            else:
                log_buf.append((
                    f"[!] Не найден {doc['type'].upper()} "
                    f"№ {doc['number']} от {doc['date']}",
                    LogTag.WARN,
                ))

        # Порядок: 1-счёт, 2-акт, 3-упд
        found.sort(key=lambda x: self.DOC_ORDER.get(x["type"], 99))

        out_name = f"Счет_{number}_от_{d.replace('.', '-')}_полный_пакет.pdf"
        out_path = self.output_folder / out_name

        for item in found:
            log_buf.append((
                f"  → [{item['type'].upper()}]: {item['file'].name}",
                LogTag.NORMAL,
            ))

        # Оптимизация 2: параллельное чтение + слияние в памяти
        _merge_pdfs([item["file"] for item in found], out_path)

        log_buf.append((f"✅ Пакет создан: {out_name}", LogTag.NORMAL))

        # Выводим весь буфер одним блоком — лог не перемешивается с другими потоками
        self._emit_log(log_buf)

        return {
            "invoice":         number,
            "output_file":     str(out_path),
            "documents_count": len(found),
            "files":           [i["file"].name for i in found],
        }


