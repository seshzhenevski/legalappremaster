# -*- coding: utf-8 -*-
"""
Сборка Python-sidecar в исполняемый файл для Tauri.

Tauri требует, чтобы имя sidecar-бинарника заканчивалось на «триплет»
целевой платформы (например legal-sidecar-x86_64-pc-windows-msvc.exe).
Этот скрипт собирает main.py через PyInstaller и переименовывает результат
в нужный формат, кладя его в src-tauri/binaries/.

Запуск:  python build_sidecar.py
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
PYTHON_SOURCE_DIR = PROJECT_ROOT / "src-python"
BINARIES_DIR = PROJECT_ROOT / "src-tauri" / "binaries"
SIDECAR_BASE_NAME = "legal-sidecar"


def detect_target_triple() -> str:
    """
    Определяет триплет целевой платформы через rustc.

    Tauri ожидает бинарник с суффиксом триплета (напр.
    x86_64-pc-windows-msvc). Функция спрашивает его у rustc.
    """
    result = subprocess.run(
        ["rustc", "-Vv"],
        capture_output=True,
        text=True,
        check=True,
    )
    for line in result.stdout.splitlines():
        if line.startswith("host:"):
            return line.split("host:")[1].strip()
    raise RuntimeError("Не удалось определить триплет платформы через rustc")


def build_sidecar_executable() -> Path:
    """
    Собирает main.py в один исполняемый файл через PyInstaller.

    Возвращает путь к собранному файлу в папке dist. Все зависимости
    (docx, reportlab, Pillow, openpyxl, pypdf, num2words) вшиваются внутрь.
    Флаг --paths указывает PyInstaller, где искать пакеты rpc, logic и
    legal_tools; --collect-submodules гарантирует, что все подмодули
    переиспользуемого ядра попадут в сборку.
    """
    subprocess.run(
        [
            sys.executable, "-m", "PyInstaller",
            "--onefile",
            "--name", SIDECAR_BASE_NAME,
            "--paths", str(PYTHON_SOURCE_DIR),
            "--collect-submodules", "legal_tools",
            "--collect-submodules", "logic",
            "--collect-submodules", "rpc",
            # Pillow (PIL) нужен reportlab для вставки PNG-логотипа с прозрачностью
            # в PDF претензии; reportlab импортирует его лениво, поэтому собираем явно.
            "--collect-all", "PIL",
            "--distpath", str(PROJECT_ROOT / "dist-sidecar"),
            "--workpath", str(PROJECT_ROOT / "build-sidecar"),
            "--specpath", str(PROJECT_ROOT / "build-sidecar"),
            str(PYTHON_SOURCE_DIR / "main.py"),
        ],
        check=True,
    )
    executable_suffix = ".exe" if sys.platform == "win32" else ""
    return PROJECT_ROOT / "dist-sidecar" / f"{SIDECAR_BASE_NAME}{executable_suffix}"


def place_sidecar_with_triple_name(built_executable: Path, target_triple: str) -> Path:
    """
    Копирует собранный бинарник в binaries/ с именем-триплетом.

    Tauri ищет sidecar по имени вида legal-sidecar-<триплет>[.exe].
    Функция создаёт папку binaries и кладёт туда переименованную копию.
    """
    BINARIES_DIR.mkdir(parents=True, exist_ok=True)
    executable_suffix = ".exe" if sys.platform == "win32" else ""
    target_name = f"{SIDECAR_BASE_NAME}-{target_triple}{executable_suffix}"
    target_path = BINARIES_DIR / target_name
    shutil.copy2(built_executable, target_path)
    return target_path


def main() -> None:
    """
    Выполняет полную сборку sidecar: PyInstaller + переименование.

    Печатает итоговый путь к готовому бинарнику для Tauri.
    """
    print("Определяю платформу...")
    target_triple = detect_target_triple()
    print(f"  Триплет: {target_triple}")

    print("Собираю Python-sidecar через PyInstaller...")
    built_executable = build_sidecar_executable()

    print("Размещаю бинарник для Tauri...")
    final_path = place_sidecar_with_triple_name(built_executable, target_triple)
    print(f"  Готово: {final_path}")


if __name__ == "__main__":
    main()
