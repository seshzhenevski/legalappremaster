// kb-markdown.test.js
// Юнит-тесты отрисовки статьи базы знаний.
// Запуск: node --test src/js/kb-markdown.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  escapeHtml,
  extractArticleLinks,
  extractHeadings,
  headingAnchorId,
  renderMarkdown,
} from "./kb-markdown.js";

/** Справочник статей, каким его передаёт вкладка из своей памяти. */
function registry(entries) {
  return new Map(entries.map(([id, title]) => [id, { title: title }]));
}

test("escapeHtml обезвреживает угловые скобки", () => {
  assert.equal(escapeHtml("<b>жирный</b>"), "&lt;b&gt;жирный&lt;/b&gt;");
});

test("статья не может протащить собственный тег script", () => {
  const html = renderMarkdown("<script>alert(1)</script>");
  assert.ok(!html.includes("<script"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("статья не может протащить обработчик события", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">');
  assert.ok(!html.includes("onerror=\""));
});

test("заголовки трёх уровней отрисовываются", () => {
  const html = renderMarkdown("# Первый\n## Второй\n### Третий");
  assert.ok(html.includes("<h1"));
  assert.ok(html.includes("<h2"));
  assert.ok(html.includes("<h3"));
});

test("жирный и курсив отрисовываются", () => {
  const html = renderMarkdown("Обычный **жирный** и *курсив*");
  assert.ok(html.includes("<strong>жирный</strong>"));
  assert.ok(html.includes("<em>курсив</em>"));
});

test("маркированный список собирается в один ul", () => {
  const html = renderMarkdown("- первый\n- второй\n- третий");
  assert.equal(html.match(/<ul/g).length, 1);
  assert.equal(html.match(/<li/g).length, 3);
});

test("нумерованный список отрисовывается через ol", () => {
  const html = renderMarkdown("1. первый\n2. второй");
  assert.ok(html.includes("<ol"));
});

test("чек-лист отличает отмеченный пункт от неотмеченного", () => {
  const html = renderMarkdown("- [x] сделано\n- [ ] не сделано");
  assert.ok(html.includes("kb-check-done"));
  assert.equal(html.match(/kb-check-done/g).length, 1);
});

test("цитата отрисовывается blockquote", () => {
  assert.ok(renderMarkdown("> цитата из письма").includes("<blockquote"));
});

test("блок кода сохраняет содержимое без форматирования", () => {
  const html = renderMarkdown("```\nне **жирный** текст\n```");
  assert.ok(html.includes("<pre"));
  assert.ok(!html.includes("<strong>"));
});

test("моноширинный участок выводится из-под курсива", () => {
  const html = renderMarkdown("текст `a * b * c` дальше");
  assert.ok(html.includes("<code"));
  assert.ok(!html.includes("<em>"));
});

test("числа рядом с моноширинным участком остаются числами", () => {
  // Заполнитель, которым код прячется на время форматирования, не должен
  // путаться с обычными числами: в статьях всюду сроки и суммы.
  const html = renderMarkdown("Срок 5 рабочих дней, статус `Не согласовано`.");
  assert.ok(html.includes("Срок 5 рабочих дней"));
  assert.ok(html.includes("<code class=\"kb-code\">Не согласовано</code>"));
  assert.ok(!html.includes("undefined"));
});

test("несколько моноширинных участков восстанавливаются каждый на своё место", () => {
  const html = renderMarkdown("сначала `первый`, потом `второй`, и 10 дней");
  assert.ok(html.includes(">первый</code>"));
  assert.ok(html.includes(">второй</code>"));
  assert.ok(html.includes("10 дней"));
});

test("горизонтальный разделитель отрисовывается", () => {
  assert.ok(renderMarkdown("текст\n\n---\n\nдалее").includes("<hr"));
});

test("таблица собирается с шапкой и телом", () => {
  const html = renderMarkdown(
    "| Основание | Срок |\n| --- | --- |\n| Претензия | 30 дней |",
  );
  assert.ok(html.includes("<th>Основание</th>"));
  assert.ok(html.includes("<td>Претензия</td>"));
  assert.ok(!html.includes("---"));
});

test("внешняя ссылка отрисовывается ссылкой", () => {
  const html = renderMarkdown("см. [сайт РКН](https://rkn.gov.ru)");
  assert.ok(html.includes('data-kb-external="https://rkn.gov.ru"'));
  assert.ok(html.includes(">сайт РКН</a>"));
});

test("ссылка со схемой javascript остаётся текстом", () => {
  // Такая ссылка выполнила бы код в окне приложения.
  const html = renderMarkdown("[нажми](javascript:alert(1))");
  assert.ok(!html.includes("<a "));
  assert.ok(html.includes("нажми"));
});

test("абзацы разделяются пустой строкой", () => {
  const html = renderMarkdown("Первый абзац.\n\nВторой абзац.");
  assert.equal(html.match(/<p>/g).length, 2);
});

test("пустая статья не ломает отрисовку", () => {
  assert.equal(renderMarkdown(""), "");
});

test("незакрытый блок кода всё равно отображается", () => {
  assert.ok(renderMarkdown("```\nтекст без закрытия").includes("<pre"));
});

test("extractHeadings перечисляет заголовки по порядку", () => {
  const headings = extractHeadings("# Первый\nтекст\n## Второй");
  assert.equal(headings.length, 2);
  assert.equal(headings[0].text, "Первый");
  assert.equal(headings[1].level, 2);
});

test("extractHeadings не считает решётки внутри блока кода", () => {
  const headings = extractHeadings("```\n# не заголовок\n```\n# заголовок");
  assert.equal(headings.length, 1);
  assert.equal(headings[0].text, "заголовок");
});

test("якоря одинаковых заголовков различаются", () => {
  assert.notEqual(headingAnchorId("Порядок", 0), headingAnchorId("Порядок", 1));
});

test("якорь заголовка совпадает с проставленным при отрисовке", () => {
  const heading = extractHeadings("# Порядок действий")[0];
  assert.ok(renderMarkdown("# Порядок действий").includes(`id="${heading.anchorId}"`));
});

test("ссылка на статью подставляет её актуальный заголовок", () => {
  // В тексте осталось прежнее название, статью с тех пор переименовали.
  const html = renderMarkdown(
    "см. [Старое название](kb-1a2b3c4d)",
    registry([["kb-1a2b3c4d", "Новое название"]]),
  );
  assert.ok(html.includes(">Новое название</a>"));
  assert.ok(!html.includes("Старое название"));
});

test("ссылка на статью помечается для перехода внутри приложения", () => {
  const html = renderMarkdown(
    "[текст](kb-1a2b3c4d)", registry([["kb-1a2b3c4d", "Статья"]]),
  );
  assert.ok(html.includes('data-kb-article-link="kb-1a2b3c4d"'));
  assert.ok(!html.includes("data-kb-external"));
});

test("ссылка на удалённую статью показывается битой, а не ведёт в никуда", () => {
  const html = renderMarkdown("[Позиция РКН](kb-deadbeef)", registry([]));
  assert.ok(html.includes("kb-link-broken"));
  assert.ok(html.includes("Позиция РКН"));
  assert.ok(!html.includes("<a "));
});

test("заголовок статьи в ссылке экранируется", () => {
  const html = renderMarkdown(
    "[текст](kb-1a2b3c4d)", registry([["kb-1a2b3c4d", "<script>alert(1)</script>"]]),
  );
  assert.ok(!html.includes("<script"));
});

test("внешние ссылки не путаются со ссылками на статьи", () => {
  const html = renderMarkdown("[сайт](https://rkn.gov.ru)", registry([]));
  assert.ok(html.includes("data-kb-external"));
  assert.ok(!html.includes("kb-link-broken"));
});

test("ссылка на статью работает без справочника", () => {
  // Предпросмотр в редакторе может отрисовываться до загрузки базы.
  const html = renderMarkdown("[текст](kb-1a2b3c4d)");
  assert.ok(html.includes("kb-link-broken"));
});

test("extractArticleLinks собирает идентификаторы из текста", () => {
  const links = extractArticleLinks(
    "начало [первая](kb-11111111) середина [вторая](kb-22222222) конец",
  );
  assert.deepEqual([...links].sort(), ["kb-11111111", "kb-22222222"]);
});

test("extractArticleLinks не считает внешние ссылки", () => {
  const links = extractArticleLinks("[сайт](https://example.com)");
  assert.equal(links.size, 0);
});

test("extractArticleLinks не повторяет один идентификатор дважды", () => {
  const links = extractArticleLinks("[раз](kb-11111111) и [два](kb-11111111)");
  assert.equal(links.size, 1);
});
