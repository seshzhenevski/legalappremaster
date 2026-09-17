// kb-search.test.js
// Юнит-тесты поиска по базе знаний.
// Запуск: node --test src/js/kb-search.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSnippet,
  findMatches,
  normalizeForSearch,
  searchArticles,
  searchStem,
} from "./kb-search.js";

/** Статья в том виде, в каком её держит вкладка. */
function article(title, body) {
  return { id: "kb-1", title: title, body: body, relative_path: "Раздел/Статья.md" };
}

test("регистр не влияет на поиск", () => {
  assert.equal(normalizeForSearch("НеУстОйКа"), "неустойка");
});

test("ё и е считаются одной буквой", () => {
  // В документах пишут и так, и этак.
  assert.equal(normalizeForSearch("зачёт"), normalizeForSearch("зачет"));
});

test("основа слова отбрасывает окончание", () => {
  assert.equal(searchStem("неустойка"), "неустой");
  assert.equal(searchStem("неустойки"), "неустой");
  assert.equal(searchStem("неустойкой"), "неустойк");
});

test("короткие слова не обрезаются до бессмыслицы", () => {
  assert.equal(searchStem("иск"), "иск");
  assert.equal(searchStem("суд"), "суд");
});

test("разные падежи находят друг друга", () => {
  const found = searchArticles(
    [article("Расчёт неустойки", "Неустойка начисляется за каждый день.")],
    "неустойкой",
  );
  assert.equal(found.length, 1);
});

test("находит по части слова в тексте", () => {
  const found = searchArticles(
    [article("Подготовка иска", "Проверить соблюдение претензионного порядка.")],
    "претензионного",
  );
  assert.equal(found.length, 1);
});

test("считает число совпадений", () => {
  const found = searchArticles(
    [article("Договоры", "Договор, договора и ещё раз договор.")], "договор",
  );
  assert.equal(found[0].matchCount, 4);
});

test("совпадение в заголовке ставится выше совпадения в тексте", () => {
  const found = searchArticles([
    article("Позиция РКН", "Здесь встречается неустойка вскользь."),
    article("Расчёт неустойки", "Порядок расчёта."),
  ], "неустойка");

  assert.equal(found[0].article.title, "Расчёт неустойки");
  assert.equal(found[0].inTitle, true);
  assert.equal(found[1].inTitle, false);
});

test("не находит того, чего нет", () => {
  assert.equal(searchArticles([article("Иск", "Текст")], "реорганизация").length, 0);
});

test("пустой запрос ничего не находит", () => {
  assert.equal(searchArticles([article("Иск", "Текст")], "   ").length, 0);
});

test("фрагмент показывает текст вокруг найденного", () => {
  const body = "Срок оплаты наступает в момент, когда неустойка начисляется полностью.";
  const found = searchArticles([article("Статья", body)], "неустойка");
  const snippet = found[0].snippets[0];

  assert.ok(snippet.before.includes("когда"));
  assert.equal(snippet.match, "неустой");
  assert.ok(snippet.after.includes("начисляется"));
});

test("фрагмент в середине статьи обрезается многоточиями", () => {
  const body = "а".repeat(200) + " неустойка " + "б".repeat(200);
  const snippet = searchArticles([article("Статья", body)], "неустойка")[0].snippets[0];

  assert.ok(snippet.before.startsWith("…"));
  assert.ok(snippet.after.endsWith("…"));
});

test("фрагмент в начале статьи не начинается с многоточия", () => {
  const snippet = searchArticles(
    [article("Статья", "Неустойка начисляется за каждый день просрочки.")],
    "неустойка",
  )[0].snippets[0];
  assert.ok(!snippet.before.startsWith("…"));
});

test("переносы строк во фрагменте сворачиваются в пробел", () => {
  const body = "Первая строка\n\nвторая строка с неустойкой\n\nтретья";
  const snippet = searchArticles([article("Статья", body)], "неустойка")[0].snippets[0];

  assert.ok(!snippet.before.includes("\n"));
  assert.ok(!snippet.after.includes("\n"));
});

test("число фрагментов ограничено, счётчик — нет", () => {
  // Список должен оставаться обозримым даже у статьи с десятками упоминаний.
  const body = Array.from({ length: 30 }, (_, i) => `пункт ${i} про договор`).join(". ");
  const found = searchArticles([article("Статья", body)], "договор")[0];

  assert.equal(found.snippets.length, 3);
  assert.equal(found.matchCount, 30);
});

test("findMatches перечисляет все позиции", () => {
  assert.deepEqual(findMatches("аба-аба", "аба"), [0, 4]);
});

test("buildSnippet не выходит за границы текста", () => {
  const snippet = buildSnippet("коротко", 0, 7);
  assert.equal(snippet.match, "коротко");
  assert.equal(snippet.before, "");
  assert.equal(snippet.after, "");
});
