# -*- coding: utf-8 -*-
"""
Слой ядра: общий SSL-контекст для обращений к внешним сервисам.

Python на Windows проверяет сертификаты по системному хранилищу «ROOT».
В корпоративных сборках (LTSC, отключённое автообновление корневых
сертификатов групповой политикой) там не хватает современных корней —
например GlobalSign Root R46, которым подписан suggestions.dadata.ru.
Запрос падает с «CERTIFICATE_VERIFY_FAILED: unable to get local issuer
certificate», хотя сеть доступна.

Поэтому контекст доверяет объединению двух источников: системному
хранилищу (там лежат корни корпоративного прокси, который подменяет
сертификаты) и актуальному списку certifi (там лежат публичные корни,
которых нет в системе).
"""
from __future__ import annotations

import ssl


_shared_context: ssl.SSLContext | None = None


def certifi_ca_bundle_path() -> str | None:
    """
    Путь к файлу корневых сертификатов certifi или None, если пакета нет.

    В сборке PyInstaller certifi.where() сам указывает на распакованную
    во временную папку копию cacert.pem, поэтому отдельная обработка
    «замороженного» режима не нужна.
    """
    try:
        import certifi
    except ImportError:
        return None
    try:
        return certifi.where()
    except Exception:
        return None


def create_ssl_context() -> ssl.SSLContext:
    """
    Собирает контекст проверки сертификатов для urllib.

    Берёт стандартный контекст (системное хранилище) и дополняет его
    корнями certifi. Проверка имени хоста и цепочки остаётся включённой.
    """
    context = ssl.create_default_context()
    ca_bundle = certifi_ca_bundle_path()
    if ca_bundle:
        try:
            context.load_verify_locations(cafile=ca_bundle)
        except OSError:
            # Файл сертификатов недоступен — остаёмся на системном хранилище.
            pass
    return context


def shared_ssl_context() -> ssl.SSLContext:
    """
    Возвращает единый контекст на весь процесс, создавая его при первом вызове.

    Загрузка хранилищ сертификатов заметно дороже самого запроса, а объект
    контекста безопасно переиспользовать между соединениями.
    """
    global _shared_context
    if _shared_context is None:
        _shared_context = create_ssl_context()
    return _shared_context
