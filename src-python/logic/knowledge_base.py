# -*- coding: utf-8 -*-
"""
Слой логики: база знаний юридического отдела.

Статьи хранятся файлами Markdown на общем сетевом диске: папка — раздел,
файл — статья. В начале файла лежит блок свойств (YAML front matter), в нём
постоянный идентификатор статьи. Ссылки между статьями хранят этот
идентификатор, а не имя файла, поэтому переименование и перенос статьи
ссылки не ломают.

Модуль ничего не знает об интерфейсе: принимает и возвращает простые
словари, пригодные для передачи фронтенду через RPC.
"""
from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

import yaml


# Служебные папки базы. Не показываются в дереве и не индексируются.
ASSETS_DIRNAME = ".assets"
VERSIONS_DIRNAME = ".versions"
LOCKS_DIRNAME = ".locks"
TRASH_DIRNAME = ".trash"
SERVICE_DIRNAMES = frozenset(
    {ASSETS_DIRNAME, VERSIONS_DIRNAME, LOCKS_DIRNAME, TRASH_DIRNAME}
)

ARTICLE_SUFFIX = ".md"

# Разделитель блока свойств в начале файла.
FRONT_MATTER_FENCE = "---"

ARTICLE_STATUSES = ("актуально", "устарело", "черновик")
DEFAULT_ARTICLE_STATUS = "черновик"

# Поля блока свойств в порядке записи: файл должен читаться человеком,
# поэтому порядок фиксирован и не зависит от порядка ключей в словаре.
PROPERTY_ORDER = (
    "id", "title", "category", "status", "icon",
    "author", "created_at", "updated_at",
)


def generate_article_id() -> str:
    """
    Создаёт постоянный идентификатор статьи.

    Возвращает строку вида «kb-7f3a9c21». Идентификатор присваивается один
    раз при создании статьи и не меняется ни при переименовании, ни при
    переносе в другую папку — на него ссылаются другие статьи.
    """
    return f"kb-{uuid.uuid4().hex[:8]}"


def content_fingerprint(text: str) -> str:
    """
    Считает отпечаток содержимого файла для обнаружения чужих правок.

    Принимает полный текст файла, возвращает шестнадцатеричный хеш.
    Намеренно используется отпечаток содержимого, а не время изменения:
    на сетевых дисках отметка времени округляется (у SMB и FAT — вплоть до
    двух секунд), и два сохранения подряд можно не заметить. Хеш файла
    в несколько килобайт считается мгновенно и не зависит ни от файловой
    системы, ни от часов чужой машины.
    """
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def normalize_properties(raw_properties: Dict[str, Any]) -> Dict[str, Any]:
    """
    Приводит свойства статьи к ожидаемому виду.

    Принимает словарь из блока front matter. Значения приводит к строкам
    (YAML отдаёт дату объектом datetime), неизвестный статус заменяет на
    «черновик», отсутствующие поля оставляет пустыми строками. Свойства,
    дописанные пользователем руками, сохраняются — файл принадлежит ему.
    """
    normalized: Dict[str, Any] = {}
    for key in PROPERTY_ORDER:
        value = raw_properties.get(key, "")
        if isinstance(value, datetime):
            value = value.isoformat(timespec="seconds")
        elif value is None:
            value = ""
        elif not isinstance(value, str):
            value = str(value)
        normalized[key] = value.strip()

    if normalized["status"] not in ARTICLE_STATUSES:
        normalized["status"] = DEFAULT_ARTICLE_STATUS

    for key, value in raw_properties.items():
        if key not in normalized:
            normalized[key] = value
    return normalized


def parse_article(file_text: str) -> Dict[str, Any]:
    """
    Разбирает текст файла статьи на свойства и содержимое.

    Принимает полный текст файла. Возвращает словарь с ключами properties
    (свойства из блока front matter) и body (текст статьи без блока).
    Файл без блока свойств или с испорченным блоком не считается ошибкой:
    свойства будут пустыми, а весь текст попадёт в body — статья всё равно
    откроется, и её можно будет починить руками.
    """
    lines = file_text.splitlines()
    if not lines or lines[0].strip() != FRONT_MATTER_FENCE:
        return {"properties": normalize_properties({}), "body": file_text}

    closing_index = None
    for index in range(1, len(lines)):
        if lines[index].strip() == FRONT_MATTER_FENCE:
            closing_index = index
            break
    if closing_index is None:
        return {"properties": normalize_properties({}), "body": file_text}

    front_matter_text = "\n".join(lines[1:closing_index])
    body = "\n".join(lines[closing_index + 1:])

    try:
        parsed = yaml.safe_load(front_matter_text)
    except yaml.YAMLError:
        # Блок испорчен правкой руками — текст статьи важнее свойств.
        return {"properties": normalize_properties({}), "body": file_text}

    properties = parsed if isinstance(parsed, dict) else {}
    return {
        "properties": normalize_properties(properties),
        "body": body.lstrip("\n"),
    }


def serialize_article(properties: Dict[str, Any], body: str) -> str:
    """
    Собирает текст файла статьи из свойств и содержимого.

    Принимает словарь свойств и текст статьи. Возвращает полный текст файла
    с блоком front matter в начале. Поля пишутся в фиксированном порядке,
    русские значения — как есть, без экранирования в escape-последовательности.
    """
    ordered: Dict[str, Any] = {}
    for key in PROPERTY_ORDER:
        if key in properties:
            ordered[key] = properties[key]
    for key, value in properties.items():
        if key not in ordered:
            ordered[key] = value

    front_matter_text = yaml.safe_dump(
        ordered,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
    )
    return (
        f"{FRONT_MATTER_FENCE}\n"
        f"{front_matter_text}"
        f"{FRONT_MATTER_FENCE}\n\n"
        f"{body.strip()}\n"
    )


def read_article(article_path: Path) -> Dict[str, Any]:
    """
    Читает статью с диска вместе с отпечатком содержимого.

    Принимает путь к файлу статьи. Возвращает свойства, текст и поле
    fingerprint — его нужно передать обратно в save_article, чтобы
    обнаружить правки, сделанные тем временем другим пользователем.
    """
    file_text = article_path.read_text(encoding="utf-8")
    parsed = parse_article(file_text)
    parsed["fingerprint"] = content_fingerprint(file_text)
    return parsed


def write_article_atomically(article_path: Path, file_text: str) -> None:
    """
    Записывает текст статьи так, чтобы файл не остался записанным наполовину.

    Пишет во временный файл рядом с целевым и подменяет им целевой одним
    системным вызовом. На сетевом диске это важно: обрыв связи посреди
    прямой записи оставил бы коллегам обрезанную статью.
    """
    temporary_path = article_path.with_name(f"{article_path.name}.tmp-{os.getpid()}")
    temporary_path.write_text(file_text, encoding="utf-8")
    os.replace(temporary_path, article_path)


def save_article(
    article_path: Path,
    properties: Dict[str, Any],
    body: str,
    expected_fingerprint: str | None = None,
) -> Dict[str, Any]:
    """
    Сохраняет статью, предварительно проверив, не изменил ли её кто-то ещё.

    Принимает путь, свойства, текст и отпечаток содержимого, полученный при
    открытии статьи. Если файл на диске с тех пор изменился, НИЧЕГО не
    перезаписывает и возвращает признак conflict вместе с чужой версией —
    решение принимает пользователь. Иначе записывает файл и возвращает новый
    отпечаток. Приоритет требования: никогда не терять правки молча.
    """
    if expected_fingerprint is not None and article_path.exists():
        current_text = article_path.read_text(encoding="utf-8")
        if content_fingerprint(current_text) != expected_fingerprint:
            other_version = parse_article(current_text)
            return {
                "conflict": True,
                "their_properties": other_version["properties"],
                "their_body": other_version["body"],
                "their_fingerprint": content_fingerprint(current_text),
            }

    saved_properties = dict(properties)
    saved_properties["updated_at"] = datetime.now().isoformat(timespec="seconds")

    file_text = serialize_article(saved_properties, body)
    article_path.parent.mkdir(parents=True, exist_ok=True)
    write_article_atomically(article_path, file_text)

    return {
        "conflict": False,
        "properties": saved_properties,
        "fingerprint": content_fingerprint(file_text),
    }


def is_service_directory(directory_name: str) -> bool:
    """
    Отвечает, является ли папка служебной и подлежит ли скрытию.

    Служебные папки базы начинаются с точки; проверка по точке, а не по
    списку имён, заодно прячет чужой мусор вроде .git.
    """
    return directory_name.startswith(".")


def relative_path_string(target_path: Path, root_path: Path) -> str:
    """
    Возвращает путь относительно корня базы строкой с прямыми слешами.

    Наружу уходят только относительные пути: у коллег сетевая папка
    подключена под другой буквой диска, и абсолютный путь вида «Z:\\...»
    у них не откроется.
    """
    try:
        relative = target_path.relative_to(root_path)
    except ValueError:
        return ""
    return relative.as_posix()


def build_article_summary(article_path: Path, root_path: Path) -> Dict[str, Any]:
    """
    Собирает краткую карточку статьи для дерева.

    Принимает путь к файлу и корень базы. Возвращает идентификатор, заголовок,
    статус, значок и относительный путь. Заголовок берётся из свойств, а если
    их нет — из имени файла, чтобы статья не осталась в дереве безымянной.
    """
    parsed = parse_article(article_path.read_text(encoding="utf-8"))
    properties = parsed["properties"]
    return {
        "id": properties.get("id", ""),
        "title": properties.get("title") or article_path.stem,
        "status": properties.get("status", DEFAULT_ARTICLE_STATUS),
        "icon": properties.get("icon", ""),
        "category": properties.get("category", ""),
        "relative_path": relative_path_string(article_path, root_path),
    }


def build_folder_node(folder_path: Path, root_path: Path) -> Dict[str, Any]:
    """
    Собирает один узел дерева: папку с вложенными папками и статьями.

    Принимает путь папки и корень базы (для относительных путей). Рекурсивно
    обходит вложенные папки. Нечитаемые файлы и папки пропускаются, а не
    роняют обход всего дерева: на общем диске часть путей может быть
    недоступна конкретному пользователю.
    """
    folders: List[Dict[str, Any]] = []
    articles: List[Dict[str, Any]] = []

    try:
        entries = sorted(folder_path.iterdir(), key=lambda item: item.name.lower())
    except OSError:
        entries = []

    for entry in entries:
        try:
            if entry.is_dir():
                if is_service_directory(entry.name):
                    continue
                folders.append(build_folder_node(entry, root_path))
            elif entry.suffix.lower() == ARTICLE_SUFFIX:
                articles.append(build_article_summary(entry, root_path))
        except OSError:
            continue

    return {
        "name": folder_path.name,
        "relative_path": relative_path_string(folder_path, root_path),
        "folders": folders,
        "articles": articles,
    }


def list_tree(root_path: Path) -> Dict[str, Any]:
    """
    Читает дерево разделов и статей с сетевого диска.

    Принимает корневую папку базы. Возвращает вложенную структуру из папок
    (ключ folders) и статей (ключ articles) с их свойствами. Служебные папки
    пропускаются. Вложенность произвольной глубины берётся из файловой
    системы и отдельной реализации не требует.
    """
    return build_folder_node(root_path, root_path)
