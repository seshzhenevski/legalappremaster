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

import getpass
import hashlib
import json
import os
import platform
import shutil
import uuid
from datetime import datetime, timedelta
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

# Замок старше этого срока считается брошенным: приложение у коллеги
# закрылось аварийно и снять замок было некому.
LOCK_STALE_AFTER = timedelta(hours=2)

# Сколько снимков предыдущих версий хранить у каждой статьи.
MAX_VERSIONS_PER_ARTICLE = 10


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
    root_path: Path,
    article_path: Path,
    properties: Dict[str, Any],
    body: str,
    expected_fingerprint: str | None = None,
) -> Dict[str, Any]:
    """
    Сохраняет статью, предварительно проверив, не изменил ли её кто-то ещё.

    Принимает корень базы, путь к статье, свойства, текст и отпечаток
    содержимого, полученный при открытии. Если файл на диске с тех пор
    изменился, НИЧЕГО не перезаписывает и возвращает признак conflict вместе
    с чужой версией — решение принимает пользователь. Иначе снимает копию
    предыдущего содержимого и записывает файл.

    Снимок версии делается здесь, а не вызывающим кодом: сохранение без
    страховки не должно быть технически возможным. Приоритет требования —
    никогда не терять правки молча.
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

    if article_path.exists():
        snapshot_previous_version(
            root_path, properties.get("id", ""), article_path,
        )

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


# ── Блокировки редактирования ────────────────────────────────────────────────
# Файлы на общем диске не защищены от параллельной записи. Замок — первый из
# двух механизмов защиты: он предупреждает коллегу заранее, до того как тот
# начнёт печатать. Второй механизм — сверка отпечатка в save_article — ловит
# то, что замок пропустил.


def current_user_identity() -> Dict[str, str]:
    """
    Определяет, кто и с какой машины держит замок.

    Возвращает имя пользователя и имя компьютера. Имя компьютера важно
    не меньше имени: один человек может открыть базу и с рабочей машины,
    и с терминального сервера.
    """
    try:
        user_name = getpass.getuser()
    except Exception:
        user_name = "неизвестный пользователь"
    return {"user": user_name, "computer": platform.node() or ""}


def lock_file_path(root_path: Path, article_id: str) -> Path:
    """
    Возвращает путь к файлу-замку статьи.

    Принимает корень базы и идентификатор статьи. Замок именуется по
    идентификатору, а не по пути: статью могут переименовать или перенести
    прямо во время редактирования.
    """
    return root_path / LOCKS_DIRNAME / f"{article_id}.lock"


def describe_lock(lock_path: Path) -> Dict[str, Any] | None:
    """
    Читает содержимое замка и считает, не брошен ли он.

    Принимает путь к файлу-замку. Возвращает словарь с владельцем, временем
    захвата и признаком stale (замок старше двух часов — приложение у коллеги
    закрылось аварийно) либо None, если замка нет или он нечитаем.
    """
    try:
        payload = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None

    try:
        acquired_at = datetime.fromisoformat(payload.get("acquired_at", ""))
    except ValueError:
        # Замок без разбираемого времени считаем брошенным: иначе статья
        # останется заблокированной навсегда.
        acquired_at = datetime.min

    payload["stale"] = datetime.now() - acquired_at > LOCK_STALE_AFTER
    return payload


def check_lock(root_path: Path, article_id: str) -> Dict[str, Any] | None:
    """
    Сообщает, занята ли статья кем-то на редактирование.

    Принимает корень базы и идентификатор статьи. Возвращает описание замка
    или None, если статья свободна.
    """
    return describe_lock(lock_file_path(root_path, article_id))


def acquire_lock(
    root_path: Path,
    article_id: str,
    identity: Dict[str, str] | None = None,
    force: bool = False,
) -> Dict[str, Any]:
    """
    Пытается захватить статью на редактирование.

    Принимает корень базы, идентификатор статьи, сведения о пользователе и
    флаг перехвата. Возвращает признак acquired и описание текущего владельца,
    если захватить не удалось.

    Файл создаётся режимом «создать, только если не существует» — это одна
    операция файловой системы, поэтому двое одновременно нажавших «Изменить»
    не получат замок оба. Перехват брошенного замка делается только явным
    действием пользователя (force), автоматически — никогда.
    """
    identity = identity or current_user_identity()
    lock_path = lock_file_path(root_path, article_id)
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    existing_lock = describe_lock(lock_path)
    if existing_lock is not None:
        is_own_lock = (
            existing_lock.get("user") == identity["user"]
            and existing_lock.get("computer") == identity["computer"]
        )
        if not (is_own_lock or force):
            return {"acquired": False, "holder": existing_lock}
        lock_path.unlink(missing_ok=True)
    elif lock_path.exists():
        # Файл замка есть, но не читается — испорчен или записан наполовину.
        # Сказать по нему нечего, а оставить как есть значит заблокировать
        # статью навсегда, поэтому считаем его брошенным.
        lock_path.unlink(missing_ok=True)

    payload = {
        "user": identity["user"],
        "computer": identity["computer"],
        "acquired_at": datetime.now().isoformat(timespec="seconds"),
    }
    try:
        descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        # Между проверкой и созданием успел вклиниться коллега.
        return {"acquired": False, "holder": describe_lock(lock_path)}

    with os.fdopen(descriptor, "w", encoding="utf-8") as lock_file:
        json.dump(payload, lock_file, ensure_ascii=False)
    return {"acquired": True, "holder": payload}


def release_lock(
    root_path: Path,
    article_id: str,
    identity: Dict[str, str] | None = None,
    force: bool = False,
) -> Dict[str, Any]:
    """
    Снимает замок со статьи.

    Принимает корень базы, идентификатор статьи и сведения о пользователе.
    Чужой замок без флага force не снимается: иначе выход из приложения у
    одного пользователя разблокировал бы статью, которую в этот момент
    правит другой.
    """
    lock_path = lock_file_path(root_path, article_id)
    existing_lock = describe_lock(lock_path)
    if existing_lock is None:
        return {"released": True}

    identity = identity or current_user_identity()
    is_own_lock = (
        existing_lock.get("user") == identity["user"]
        and existing_lock.get("computer") == identity["computer"]
    )
    if not (is_own_lock or force):
        return {"released": False, "holder": existing_lock}

    lock_path.unlink(missing_ok=True)
    return {"released": True}


# ── Снимки предыдущих версий ─────────────────────────────────────────────────
# Не история изменений и не сравнение версий, а страховка: возможность
# откатиться, если правки всё же были затёрты.


def versions_directory(root_path: Path, article_id: str) -> Path:
    """
    Возвращает папку со снимками версий статьи.

    Принимает корень базы и идентификатор статьи. Папка именуется по
    идентификатору, поэтому снимки переживают переименование статьи.
    """
    return root_path / VERSIONS_DIRNAME / article_id


def snapshot_previous_version(
    root_path: Path, article_id: str, article_path: Path,
) -> Path | None:
    """
    Копирует текущее содержимое файла в снимки перед перезаписью.

    Принимает корень базы, идентификатор статьи и путь к файлу. Возвращает
    путь снимка или None, если снять копию не удалось. Сбой снимка не должен
    срывать сохранение — лучше сохранить статью без страховки, чем не
    сохранить вовсе, поэтому ошибки здесь проглатываются.
    """
    if not article_id:
        return None
    try:
        target_directory = versions_directory(root_path, article_id)
        target_directory.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S-%f")
        snapshot_path = target_directory / f"{stamp}{ARTICLE_SUFFIX}"
        shutil.copy2(article_path, snapshot_path)
        prune_old_versions(target_directory)
        return snapshot_path
    except OSError:
        return None


def prune_old_versions(versions_path: Path) -> None:
    """
    Оставляет только последние снимки статьи, удаляя лишние.

    Принимает папку со снимками. Имена снимков начинаются с даты и времени,
    поэтому обычная сортировка по имени совпадает с сортировкой по времени.
    """
    try:
        snapshots = sorted(versions_path.glob(f"*{ARTICLE_SUFFIX}"))
    except OSError:
        return
    for outdated in snapshots[:-MAX_VERSIONS_PER_ARTICLE]:
        try:
            outdated.unlink()
        except OSError:
            continue


def list_versions(root_path: Path, article_id: str) -> List[Dict[str, Any]]:
    """
    Перечисляет доступные снимки статьи, новые первыми.

    Принимает корень базы и идентификатор статьи. Возвращает список записей
    с именем снимка и временем сохранения.
    """
    versions_path = versions_directory(root_path, article_id)
    try:
        snapshots = sorted(versions_path.glob(f"*{ARTICLE_SUFFIX}"), reverse=True)
    except OSError:
        return []

    versions: List[Dict[str, Any]] = []
    for snapshot in snapshots:
        try:
            saved_at = datetime.fromtimestamp(snapshot.stat().st_mtime)
        except OSError:
            continue
        versions.append({
            "name": snapshot.name,
            "saved_at": saved_at.isoformat(timespec="seconds"),
        })
    return versions


def read_version(root_path: Path, article_id: str, version_name: str) -> Dict[str, Any]:
    """
    Читает содержимое снимка версии для показа пользователю.

    Принимает корень базы, идентификатор статьи и имя снимка. Возвращает
    свойства и текст той версии — перед восстановлением её дают посмотреть.
    """
    snapshot_path = safe_child_path(
        versions_directory(root_path, article_id), version_name,
    )
    return parse_article(snapshot_path.read_text(encoding="utf-8"))


def safe_child_path(parent_path: Path, child_name: str) -> Path:
    """
    Собирает путь внутри папки, не позволяя выйти за её пределы.

    Принимает папку и имя, пришедшее снаружи. Имя вроде «../../important.md»
    увело бы чтение или удаление за пределы базы, поэтому такое имя
    отклоняется, а не обрезается до последнего компонента: молча подменять
    запрошенный путь другим — значит работать не с тем файлом, о котором
    просили, и это хуже внятной ошибки.
    """
    name = str(child_name)
    if not name or Path(name).name != name:
        raise ValueError(f"Недопустимое имя: {child_name}")

    candidate = (parent_path / name).resolve()
    if parent_path.resolve() not in candidate.parents:
        raise ValueError(f"Недопустимое имя: {child_name}")
    return candidate


# ── Корзина ──────────────────────────────────────────────────────────────────
# Простая страховка от случайного удаления на общем диске: файл не исчезает,
# а переезжает в служебную папку вместе с записью о том, откуда он взят.


def trash_directory(root_path: Path) -> Path:
    """
    Возвращает папку корзины, создавая её при необходимости.

    Принимает корень базы. Папка служебная и в дереве не показывается.
    """
    path = root_path / TRASH_DIRNAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def delete_article(root_path: Path, article_path: Path) -> Dict[str, Any]:
    """
    Переносит статью в корзину, сохраняя исходный путь.

    Принимает корень базы и путь к статье. Рядом с перенесённым файлом
    кладётся запись с исходным относительным путём, заголовком и временем
    удаления — по ней статья возвращается ровно туда, откуда была взята.
    """
    parsed = parse_article(article_path.read_text(encoding="utf-8"))
    article_id = parsed["properties"].get("id") or "bez-id"
    entry_id = f"{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}-{article_id}"

    trash_path = trash_directory(root_path)
    shutil.move(str(article_path), str(trash_path / f"{entry_id}{ARTICLE_SUFFIX}"))

    entry = {
        "entry_id": entry_id,
        "article_id": article_id,
        "title": parsed["properties"].get("title") or article_path.stem,
        "original_relative_path": relative_path_string(article_path, root_path),
        "deleted_at": datetime.now().isoformat(timespec="seconds"),
    }
    (trash_path / f"{entry_id}.json").write_text(
        json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    return entry


def list_trash(root_path: Path) -> List[Dict[str, Any]]:
    """
    Перечисляет содержимое корзины, недавно удалённые первыми.

    Принимает корень базы. Возвращает записи с заголовком, исходным путём
    и временем удаления. Записи без сохранившегося файла пропускаются.
    """
    trash_path = root_path / TRASH_DIRNAME
    if not trash_path.exists():
        return []

    entries: List[Dict[str, Any]] = []
    for record_path in sorted(trash_path.glob("*.json"), reverse=True):
        try:
            entry = json.loads(record_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        article_file = trash_path / f"{entry.get('entry_id', '')}{ARTICLE_SUFFIX}"
        if article_file.exists():
            entries.append(entry)
    return entries


def restore_article(root_path: Path, entry_id: str) -> Dict[str, Any]:
    """
    Возвращает статью из корзины на исходное место.

    Принимает корень базы и идентификатор записи корзины. Если на исходном
    пути уже лежит другой файл, статья НЕ перезаписывает его, а кладётся
    рядом под именем с пометкой — потерять чужую работу при восстановлении
    так же недопустимо, как при сохранении.
    """
    trash_path = root_path / TRASH_DIRNAME
    record_path = safe_child_path(trash_path, f"{entry_id}.json")
    entry = json.loads(record_path.read_text(encoding="utf-8"))
    article_file = safe_child_path(trash_path, f"{entry_id}{ARTICLE_SUFFIX}")

    target_path = root_path / entry["original_relative_path"]
    target_path.parent.mkdir(parents=True, exist_ok=True)

    renamed = False
    if target_path.exists():
        stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        target_path = target_path.with_name(
            f"{target_path.stem}-восстановлена-{stamp}{ARTICLE_SUFFIX}"
        )
        renamed = True

    shutil.move(str(article_file), str(target_path))
    record_path.unlink(missing_ok=True)

    return {
        "restored_relative_path": relative_path_string(target_path, root_path),
        "renamed": renamed,
    }


def purge_trash_entry(root_path: Path, entry_id: str) -> None:
    """
    Удаляет запись корзины окончательно.

    Принимает корень базы и идентификатор записи. После этого восстановить
    статью средствами приложения уже нельзя.
    """
    trash_path = root_path / TRASH_DIRNAME
    safe_child_path(trash_path, f"{entry_id}{ARTICLE_SUFFIX}").unlink(missing_ok=True)
    safe_child_path(trash_path, f"{entry_id}.json").unlink(missing_ok=True)
