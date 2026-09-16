# -*- coding: utf-8 -*-
"""
Тесты слоя логики базы знаний.

Работают на временной папке, без реального сетевого диска. Проверяют разбор
и запись блока свойств, обход дерева и — главное — что чужие правки не
затираются молча.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from logic.knowledge_base import (
    DEFAULT_ARTICLE_STATUS,
    LOCK_STALE_AFTER,
    MAX_VERSIONS_PER_ARTICLE,
    acquire_lock,
    check_lock,
    content_fingerprint,
    delete_article,
    generate_article_id,
    list_trash,
    list_tree,
    list_versions,
    lock_file_path,
    parse_article,
    purge_trash_entry,
    read_article,
    read_version,
    relative_path_string,
    release_lock,
    restore_article,
    safe_child_path,
    save_article,
    serialize_article,
)


class ArticleIdTests(unittest.TestCase):
    def test_id_has_expected_shape(self):
        article_id = generate_article_id()
        self.assertTrue(article_id.startswith("kb-"))
        self.assertEqual(len(article_id), 11)

    def test_ids_are_unique(self):
        ids = {generate_article_id() for _ in range(200)}
        self.assertEqual(len(ids), 200)


class ParseArticleTests(unittest.TestCase):
    def test_reads_all_properties_and_body(self):
        file_text = (
            "---\n"
            "id: kb-7f3a9c21\n"
            "title: Инструкция по обработке запросов\n"
            "category: Персональные данные\n"
            "status: актуально\n"
            "icon: 📄\n"
            "author: Иванов И.И.\n"
            "---\n"
            "\n"
            "Текст статьи.\n"
        )
        parsed = parse_article(file_text)
        properties = parsed["properties"]

        self.assertEqual(properties["id"], "kb-7f3a9c21")
        self.assertEqual(properties["title"], "Инструкция по обработке запросов")
        self.assertEqual(properties["category"], "Персональные данные")
        self.assertEqual(properties["status"], "актуально")
        self.assertEqual(properties["icon"], "📄")
        self.assertEqual(properties["author"], "Иванов И.И.")
        self.assertEqual(parsed["body"], "Текст статьи.")

    def test_title_with_colon_survives_round_trip(self):
        # Двоеточие в заголовке ломает наивный разбор «ключ: значение».
        title = "Инструкция: порядок действий при запросе"
        file_text = serialize_article({"id": "kb-1", "title": title}, "Текст")
        self.assertEqual(parse_article(file_text)["properties"]["title"], title)

    def test_file_without_front_matter_keeps_text(self):
        parsed = parse_article("Просто заметка без свойств.")
        self.assertEqual(parsed["body"], "Просто заметка без свойств.")
        self.assertEqual(parsed["properties"]["id"], "")

    def test_broken_front_matter_does_not_lose_body(self):
        file_text = "---\n: : : некорректный ямл : :\n---\nВажный текст\n"
        parsed = parse_article(file_text)
        self.assertIn("Важный текст", parsed["body"])

    def test_empty_properties_do_not_raise(self):
        parsed = parse_article("---\n---\nТекст\n")
        self.assertEqual(parsed["properties"]["status"], DEFAULT_ARTICLE_STATUS)

    def test_unknown_status_falls_back_to_draft(self):
        parsed = parse_article("---\nstatus: непонятно\n---\nТекст\n")
        self.assertEqual(parsed["properties"]["status"], DEFAULT_ARTICLE_STATUS)

    def test_date_value_becomes_string(self):
        # YAML отдаёт дату объектом datetime — фронтенду нужна строка.
        parsed = parse_article("---\nupdated_at: 2026-09-12 14:30:00\n---\nТекст\n")
        self.assertIsInstance(parsed["properties"]["updated_at"], str)
        self.assertTrue(parsed["properties"]["updated_at"].startswith("2026-09-12"))

    def test_custom_property_is_preserved(self):
        parsed = parse_article("---\nid: kb-1\nотдел: договорной\n---\nТекст\n")
        self.assertEqual(parsed["properties"]["отдел"], "договорной")


class SerializeArticleTests(unittest.TestCase):
    def test_russian_text_is_not_escaped(self):
        file_text = serialize_article({"title": "Персональные данные"}, "Текст")
        self.assertIn("Персональные данные", file_text)
        self.assertNotIn("\\u", file_text)

    def test_properties_keep_fixed_order(self):
        file_text = serialize_article(
            {"status": "актуально", "title": "Заголовок", "id": "kb-1"}, "Текст",
        )
        self.assertLess(file_text.index("id:"), file_text.index("title:"))
        self.assertLess(file_text.index("title:"), file_text.index("status:"))


class SaveArticleTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.article_path = self.root / "Раздел" / "statya.md"

    def tearDown(self):
        self.temporary_directory.cleanup()

    def save_initial_article(self) -> dict:
        return save_article(
            self.root,
            self.article_path,
            {"id": "kb-1", "title": "Заголовок", "status": "актуально"},
            "Первая версия",
        )

    def test_creates_missing_folders(self):
        self.save_initial_article()
        self.assertTrue(self.article_path.exists())

    def test_save_sets_updated_at(self):
        saved = self.save_initial_article()
        self.assertTrue(saved["properties"]["updated_at"].startswith(
            str(datetime.now().year)
        ))

    def test_round_trip_through_disk(self):
        self.save_initial_article()
        loaded = read_article(self.article_path)
        self.assertEqual(loaded["properties"]["title"], "Заголовок")
        self.assertEqual(loaded["body"], "Первая версия")

    def test_saving_with_current_fingerprint_succeeds(self):
        self.save_initial_article()
        loaded = read_article(self.article_path)
        result = save_article(
            self.root,
            self.article_path,
            loaded["properties"],
            "Моя правка",
            expected_fingerprint=loaded["fingerprint"],
        )
        self.assertFalse(result["conflict"])
        self.assertEqual(read_article(self.article_path)["body"], "Моя правка")

    def test_foreign_change_is_reported_as_conflict(self):
        self.save_initial_article()
        mine = read_article(self.article_path)

        # Коллега сохранил свою версию, пока статья была открыта у нас.
        save_article(self.root, self.article_path, mine["properties"], "Версия коллеги")

        result = save_article(
            self.root,
            self.article_path,
            mine["properties"],
            "Моя правка",
            expected_fingerprint=mine["fingerprint"],
        )
        self.assertTrue(result["conflict"])
        self.assertEqual(result["their_body"], "Версия коллеги")

    def test_conflict_leaves_foreign_version_on_disk(self):
        # Главное требование: чужие правки не затираются молча.
        self.save_initial_article()
        mine = read_article(self.article_path)
        save_article(self.root, self.article_path, mine["properties"], "Версия коллеги")

        save_article(
            self.root,
            self.article_path,
            mine["properties"],
            "Моя правка",
            expected_fingerprint=mine["fingerprint"],
        )
        self.assertEqual(read_article(self.article_path)["body"], "Версия коллеги")

    def test_save_without_fingerprint_overwrites(self):
        # Создание новой статьи: сверять нечего.
        self.save_initial_article()
        result = save_article(self.root, self.article_path, {"id": "kb-1"}, "Перезапись")
        self.assertFalse(result["conflict"])

    def test_no_temporary_files_left_behind(self):
        self.save_initial_article()
        leftovers = list(self.article_path.parent.glob("*.tmp-*"))
        self.assertEqual(leftovers, [])


class FingerprintTests(unittest.TestCase):
    def test_same_text_gives_same_fingerprint(self):
        self.assertEqual(content_fingerprint("текст"), content_fingerprint("текст"))

    def test_different_text_gives_different_fingerprint(self):
        self.assertNotEqual(content_fingerprint("текст"), content_fingerprint("тексты"))


class TreeTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)

        save_article(
            self.root,
            self.root / "Договорная работа" / "Персональные данные" / "zaprosy.md",
            {"id": "kb-1", "title": "Инструкция по запросам", "icon": "📄"},
            "Текст",
        )
        save_article(
            self.root,
            self.root / "Договорная работа" / "poziciya.md",
            {"id": "kb-2", "title": "Позиция РКН"},
            "Текст",
        )
        for service_name in (".assets", ".versions", ".locks", ".trash"):
            (self.root / service_name).mkdir()
        (self.root / ".trash" / "udalennaya.md").write_text("---\n---\nМусор\n", "utf-8")
        (self.root / "Договорная работа" / "заметка.txt").write_text("не статья", "utf-8")

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_nested_folders_are_walked(self):
        tree = list_tree(self.root)
        contract_folder = tree["folders"][0]
        self.assertEqual(contract_folder["name"], "Договорная работа")
        self.assertEqual(contract_folder["folders"][0]["name"], "Персональные данные")

    def test_article_summary_carries_properties(self):
        tree = list_tree(self.root)
        nested = tree["folders"][0]["folders"][0]["articles"][0]
        self.assertEqual(nested["id"], "kb-1")
        self.assertEqual(nested["title"], "Инструкция по запросам")
        self.assertEqual(nested["icon"], "📄")

    def test_service_folders_are_hidden(self):
        tree = list_tree(self.root)
        names = [folder["name"] for folder in tree["folders"]]
        for service_name in (".assets", ".versions", ".locks", ".trash"):
            self.assertNotIn(service_name, names)

    def test_non_markdown_files_are_ignored(self):
        tree = list_tree(self.root)
        titles = [item["title"] for item in tree["folders"][0]["articles"]]
        self.assertNotIn("заметка", titles)

    def test_paths_are_relative_with_forward_slashes(self):
        tree = list_tree(self.root)
        nested = tree["folders"][0]["folders"][0]["articles"][0]
        self.assertEqual(
            nested["relative_path"],
            "Договорная работа/Персональные данные/zaprosy.md",
        )

    def test_absolute_path_never_leaks_outward(self):
        # У коллеги сетевая папка под другой буквой диска — абсолютный путь
        # у него не откроется, наружу уходят только относительные.
        tree = list_tree(self.root)
        nested = tree["folders"][0]["folders"][0]["articles"][0]
        self.assertNotIn(":", nested["relative_path"])
        self.assertFalse(nested["relative_path"].startswith("/"))

    def test_path_outside_root_gives_empty_string(self):
        self.assertEqual(relative_path_string(Path("C:/другое"), self.root), "")

    def test_empty_base_does_not_raise(self):
        with tempfile.TemporaryDirectory() as empty_directory:
            tree = list_tree(Path(empty_directory))
            self.assertEqual(tree["folders"], [])
            self.assertEqual(tree["articles"], [])


class LockTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.ivanov = {"user": "Иванов И.И.", "computer": "PC-LEGAL-01"}
        self.petrov = {"user": "Петров П.П.", "computer": "PC-LEGAL-02"}

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_free_article_has_no_lock(self):
        self.assertIsNone(check_lock(self.root, "kb-1"))

    def test_first_user_acquires_lock(self):
        result = acquire_lock(self.root, "kb-1", self.ivanov)
        self.assertTrue(result["acquired"])
        self.assertEqual(result["holder"]["user"], "Иванов И.И.")

    def test_second_user_cannot_acquire_held_lock(self):
        acquire_lock(self.root, "kb-1", self.ivanov)
        result = acquire_lock(self.root, "kb-1", self.petrov)

        self.assertFalse(result["acquired"])
        self.assertEqual(result["holder"]["user"], "Иванов И.И.")
        self.assertEqual(result["holder"]["computer"], "PC-LEGAL-01")

    def test_lock_reports_capture_time(self):
        acquire_lock(self.root, "kb-1", self.ivanov)
        holder = check_lock(self.root, "kb-1")
        self.assertTrue(holder["acquired_at"].startswith(str(datetime.now().year)))

    def test_owner_can_reacquire_own_lock(self):
        # Повторный вход в режим правки не должен упираться в свой же замок.
        acquire_lock(self.root, "kb-1", self.ivanov)
        self.assertTrue(acquire_lock(self.root, "kb-1", self.ivanov)["acquired"])

    def test_same_user_on_another_computer_is_blocked(self):
        acquire_lock(self.root, "kb-1", self.ivanov)
        other_machine = {"user": "Иванов И.И.", "computer": "TERMINAL-SERVER"}
        self.assertFalse(acquire_lock(self.root, "kb-1", other_machine)["acquired"])

    def test_release_frees_article(self):
        acquire_lock(self.root, "kb-1", self.ivanov)
        self.assertTrue(release_lock(self.root, "kb-1", self.ivanov)["released"])
        self.assertIsNone(check_lock(self.root, "kb-1"))

    def test_stranger_cannot_release_foreign_lock(self):
        # Иначе выход из приложения у одного разблокировал бы статью,
        # которую в этот момент правит другой.
        acquire_lock(self.root, "kb-1", self.ivanov)
        result = release_lock(self.root, "kb-1", self.petrov)

        self.assertFalse(result["released"])
        self.assertIsNotNone(check_lock(self.root, "kb-1"))

    def test_releasing_absent_lock_is_not_an_error(self):
        self.assertTrue(release_lock(self.root, "kb-1", self.ivanov)["released"])

    def test_locks_are_independent_per_article(self):
        acquire_lock(self.root, "kb-1", self.ivanov)
        self.assertTrue(acquire_lock(self.root, "kb-2", self.petrov)["acquired"])

    def write_lock_with_age(self, article_id: str, age: timedelta) -> None:
        """Кладёт замок, захваченный указанное время назад."""
        lock_path = lock_file_path(self.root, article_id)
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_path.write_text(json.dumps({
            "user": self.ivanov["user"],
            "computer": self.ivanov["computer"],
            "acquired_at": (datetime.now() - age).isoformat(timespec="seconds"),
        }, ensure_ascii=False), encoding="utf-8")

    def test_fresh_lock_is_not_stale(self):
        self.write_lock_with_age("kb-1", LOCK_STALE_AFTER - timedelta(minutes=5))
        self.assertFalse(check_lock(self.root, "kb-1")["stale"])

    def test_old_lock_is_reported_stale(self):
        self.write_lock_with_age("kb-1", LOCK_STALE_AFTER + timedelta(minutes=5))
        self.assertTrue(check_lock(self.root, "kb-1")["stale"])

    def test_stale_lock_still_blocks_without_explicit_takeover(self):
        # Брошенный замок перехватывается только действием пользователя,
        # автоматически — никогда.
        self.write_lock_with_age("kb-1", LOCK_STALE_AFTER + timedelta(hours=1))
        self.assertFalse(acquire_lock(self.root, "kb-1", self.petrov)["acquired"])

    def test_forced_takeover_succeeds(self):
        self.write_lock_with_age("kb-1", LOCK_STALE_AFTER + timedelta(hours=1))
        result = acquire_lock(self.root, "kb-1", self.petrov, force=True)

        self.assertTrue(result["acquired"])
        self.assertEqual(check_lock(self.root, "kb-1")["user"], "Петров П.П.")

    def test_unreadable_lock_does_not_block_forever(self):
        lock_path = lock_file_path(self.root, "kb-1")
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_path.write_text("не json", encoding="utf-8")
        self.assertTrue(acquire_lock(self.root, "kb-1", self.petrov)["acquired"])


class VersionTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.article_path = self.root / "Раздел" / "statya.md"
        self.properties = {"id": "kb-1", "title": "Заголовок"}

    def tearDown(self):
        self.temporary_directory.cleanup()

    def save(self, body: str) -> dict:
        return save_article(self.root, self.article_path, self.properties, body)

    def test_first_save_makes_no_snapshot(self):
        self.save("Первая версия")
        self.assertEqual(list_versions(self.root, "kb-1"), [])

    def test_second_save_snapshots_previous_text(self):
        self.save("Первая версия")
        self.save("Вторая версия")

        versions = list_versions(self.root, "kb-1")
        self.assertEqual(len(versions), 1)
        restored = read_version(self.root, "kb-1", versions[0]["name"])
        self.assertEqual(restored["body"], "Первая версия")

    def test_only_last_versions_are_kept(self):
        for number in range(MAX_VERSIONS_PER_ARTICLE + 5):
            self.save(f"Версия {number}")
        self.assertEqual(
            len(list_versions(self.root, "kb-1")), MAX_VERSIONS_PER_ARTICLE,
        )

    def test_oldest_versions_are_dropped_first(self):
        for number in range(MAX_VERSIONS_PER_ARTICLE + 3):
            self.save(f"Версия {number}")

        versions = list_versions(self.root, "kb-1")
        oldest = read_version(self.root, "kb-1", versions[-1]["name"])
        self.assertNotIn("Версия 0", oldest["body"])

    def test_versions_are_listed_newest_first(self):
        self.save("Первая версия")
        self.save("Вторая версия")
        self.save("Третья версия")

        versions = list_versions(self.root, "kb-1")
        newest = read_version(self.root, "kb-1", versions[0]["name"])
        self.assertEqual(newest["body"], "Вторая версия")

    def test_article_without_versions_returns_empty_list(self):
        self.assertEqual(list_versions(self.root, "kb-неизвестная"), [])

    def test_version_name_cannot_escape_versions_folder(self):
        self.save("Первая версия")
        self.save("Вторая версия")
        with self.assertRaises(ValueError):
            read_version(self.root, "kb-1", "../../../statya.md")


class SafePathTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_plain_name_is_allowed(self):
        self.assertEqual(safe_child_path(self.root, "file.md").name, "file.md")

    def test_parent_traversal_is_rejected(self):
        with self.assertRaises(ValueError):
            safe_child_path(self.root, "../../secret.md")


class TrashTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.article_path = self.root / "Договорная работа" / "statya.md"
        save_article(
            self.root,
            self.article_path,
            {"id": "kb-1", "title": "Инструкция по запросам"},
            "Текст статьи",
        )

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_delete_removes_article_from_its_folder(self):
        delete_article(self.root, self.article_path)
        self.assertFalse(self.article_path.exists())

    def test_deleted_article_appears_in_trash(self):
        delete_article(self.root, self.article_path)

        entries = list_trash(self.root)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["title"], "Инструкция по запросам")
        self.assertEqual(
            entries[0]["original_relative_path"], "Договорная работа/statya.md",
        )

    def test_restore_returns_article_to_original_place(self):
        entry = delete_article(self.root, self.article_path)
        result = restore_article(self.root, entry["entry_id"])

        self.assertTrue(self.article_path.exists())
        self.assertFalse(result["renamed"])
        self.assertEqual(read_article(self.article_path)["body"], "Текст статьи")

    def test_restore_empties_the_trash_entry(self):
        entry = delete_article(self.root, self.article_path)
        restore_article(self.root, entry["entry_id"])
        self.assertEqual(list_trash(self.root), [])

    def test_restore_does_not_overwrite_a_newer_article(self):
        # На исходном пути успела появиться другая статья — затирать её
        # при восстановлении так же недопустимо, как при сохранении.
        entry = delete_article(self.root, self.article_path)
        save_article(
            self.root, self.article_path, {"id": "kb-2", "title": "Другая"}, "Новый текст",
        )

        result = restore_article(self.root, entry["entry_id"])

        self.assertTrue(result["renamed"])
        self.assertEqual(read_article(self.article_path)["body"], "Новый текст")
        self.assertIn("восстановлена", result["restored_relative_path"])

    def test_purge_removes_entry_permanently(self):
        entry = delete_article(self.root, self.article_path)
        purge_trash_entry(self.root, entry["entry_id"])

        self.assertEqual(list_trash(self.root), [])
        self.assertFalse(self.article_path.exists())

    def test_trash_folder_is_hidden_from_tree(self):
        delete_article(self.root, self.article_path)
        names = [folder["name"] for folder in list_tree(self.root)["folders"]]
        self.assertNotIn(".trash", names)

    def test_empty_trash_is_not_an_error(self):
        self.assertEqual(list_trash(self.root), [])

    def test_entry_id_cannot_escape_trash_folder(self):
        delete_article(self.root, self.article_path)
        with self.assertRaises(ValueError):
            restore_article(self.root, "../../statya")


if __name__ == "__main__":
    unittest.main()
