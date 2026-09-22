// kb-markdown.test.js
// Юнит-тесты отрисовки статьи базы знаний.
// Запуск: node --test src/js/kb-markdown.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dropRedundantEscapes,
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

// Выпадающий список редактора предлагает шесть уровней. Понимай
// отрисовщик только три — выбранный «Заголовок 4» уезжал бы в статью
// абзацем с решётками, и человек увидел бы мусор вместо заголовка.
test("заголовки с четвёртого по шестой уровень тоже отрисовываются", () => {
  const html = renderMarkdown("#### Четвёртый\n##### Пятый\n###### Шестой");
  assert.ok(html.includes("<h4"));
  assert.ok(html.includes("<h5"));
  assert.ok(html.includes("<h6"));
  assert.ok(!html.includes("#### Четвёртый"));
});

test("седьмая решётка заголовком уже не считается", () => {
  const html = renderMarkdown("####### Семь решёток");
  assert.ok(!html.includes("<h7"));
  assert.ok(html.includes("####### Семь решёток"));
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

// Оглавление отбирает уровни само, а extractHeadings обязан отдавать все:
// якоря считаются по порядковому номеру заголовка, и пропуск глубоких
// увёл бы ссылки оглавления не туда.
test("extractHeadings отдаёт и глубокие заголовки", () => {
  const headings = extractHeadings("# Первый\n#### Четвёртый");
  assert.equal(headings.length, 2);
  assert.equal(headings[1].level, 4);
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

test("подпись ссылки остаётся такой, как её написал автор", () => {
  // Ссылка ставится на слово внутри фразы: подмена его заголовком статьи
  // ломала бы предложение.
  const html = renderMarkdown(
    "Реквизиты и сведения из [ЕГРЮЛ](kb-1a2b3c4d)",
    registry([["kb-1a2b3c4d", "Корпоративка"]]),
  );
  assert.ok(html.includes(">ЕГРЮЛ</a>"));
  assert.ok(!html.includes(">Корпоративка<"));
});

test("актуальный заголовок статьи показывается подсказкой", () => {
  // Переименование должно оставаться заметным, не меняя текст статьи.
  const html = renderMarkdown(
    "[ЕГРЮЛ](kb-1a2b3c4d)", registry([["kb-1a2b3c4d", "Корпоративка"]]),
  );
  assert.ok(html.includes('title="Статья: Корпоративка"'));
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

test("заголовок статьи в подсказке экранируется", () => {
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

/** Справочник доступности документов, каким его отдаёт бэкенд. */
function documents(entries) {
  return new Map(entries.map(([target, available, reason]) =>
    [target, { available: available, reason: reason || "" }]));
}

test("вложение отрисовывается ссылкой со значком по типу файла", () => {
  const html = renderMarkdown(
    "см. [договор](.assets/kb-1/Договор%20поставки.docx)",
    null, documents([[".assets/kb-1/Договор%20поставки.docx", true]]),
  );
  assert.ok(html.includes('data-kb-document=".assets/kb-1/Договор%20поставки.docx"'));
  assert.ok(html.includes("📝"));
  assert.ok(html.includes("договор"));
});

test("имя документа в подсказке раскодировано", () => {
  const html = renderMarkdown(
    "[договор](.assets/kb-1/Договор%20поставки.docx)",
    null, documents([[".assets/kb-1/Договор%20поставки.docx", true]]),
  );
  assert.ok(html.includes('title="Договор поставки.docx"'));
  // В самом адресе ссылки кодирование остаётся — оно там и нужно.
  assert.ok(html.includes('data-kb-document=".assets/kb-1/Договор%20поставки.docx"'));
});

test("недоступный документ помечается и не открывается", () => {
  const html = renderMarkdown(
    "[договор](.assets/kb-1/Нет.docx)",
    null, documents([[".assets/kb-1/Нет.docx", false, "Файл не найден"]]),
  );
  assert.ok(html.includes("kb-doc-broken"));
  assert.ok(html.includes('title="Файл не найден"'));
  assert.ok(!html.includes("data-kb-document"));
});

test("ссылка на файл в сетевой папке узнаётся по схеме", () => {
  const html = renderMarkdown(
    "[регламент](file:Z:/Общая/Регламент.pdf)",
    null, documents([["file:Z:/Общая/Регламент.pdf", true]]),
  );
  assert.ok(html.includes("data-kb-document"));
  assert.ok(html.includes("📕"));
  assert.ok(html.includes('title="Регламент.pdf"'));
});

test("неизвестное расширение получает общий значок", () => {
  const html = renderMarkdown(
    "[файл](.assets/kb-1/данные.xyz)", null,
    documents([[".assets/kb-1/данные.xyz", true]]),
  );
  assert.ok(html.includes("📎"));
});

test("документ без справочника считается доступным", () => {
  // Предпросмотр в редакторе отрисовывается до проверки файлов.
  const html = renderMarkdown("[договор](.assets/kb-1/Д.docx)");
  assert.ok(html.includes("data-kb-document"));
});

test("документы не путаются со ссылками на статьи и сайты", () => {
  const html = renderMarkdown(
    "[статья](kb-1a2b3c4d) [сайт](https://example.com) [файл](.assets/kb-1/Д.docx)",
    registry([["kb-1a2b3c4d", "Статья"]]), documents([]),
  );
  assert.ok(html.includes("data-kb-article-link"));
  assert.ok(html.includes("data-kb-external"));
  assert.ok(html.includes("data-kb-document"));
});

// ── Обратные слеши ──────────────────────────────────────────────────────────
// Редактор экранирует всё, что вставлено из Word: «\- начиная с 1 \(Первого\)
// дня \, 0\,05%». До этих тестов слеши доезжали до экрана как есть.

test("экранированные скобки и запятые показываются знаками", () => {
  const html = renderMarkdown(String.raw`0\,05% за 1 \(Первый\) день`);
  assert.ok(html.includes("0,05% за 1 (Первый) день"));
  assert.ok(!html.includes("\\"));
});

test("экранированный дефис в начале строки не делает список", () => {
  const html = renderMarkdown(String.raw`\- начиная с первого дня`);
  assert.ok(!html.includes("<ul"));
  assert.ok(html.includes("- начиная с первого дня"));
});

test("экранированная звёздочка не превращается в курсив", () => {
  const html = renderMarkdown(String.raw`\*не курсив\*`);
  assert.ok(!html.includes("<em>"));
  assert.ok(html.includes("*не курсив*"));
});

test("экранированные квадратные скобки не делают ссылку", () => {
  const html = renderMarkdown(String.raw`\[не ссылка\](kb-1)`);
  assert.ok(!html.includes("<a "));
  assert.ok(html.includes("[не ссылка]"));
});

test("слеш перед буквой остаётся слешем", () => {
  // Путь к сетевой папке — обычное содержимое статьи юротдела.
  const html = renderMarkdown(String.raw`C:\temp\договор`);
  assert.ok(html.includes(String.raw`C:\temp\договор`));
});

test("экранирование внутри моноширинного участка не разбирается", () => {
  const html = renderMarkdown("код `a\\,b` в строке");
  assert.ok(html.includes("a\\,b"));
});

test("dropRedundantEscapes снимает слеши со скобок и запятых", () => {
  const cleaned = dropRedundantEscapes(String.raw`1 \(Первый\) день \, 0\,05%\;`);
  assert.equal(cleaned, "1 (Первый) день , 0,05%;");
});

test("dropRedundantEscapes бережёт то, что держит текст текстом", () => {
  const source = String.raw`\- пункт \* звезда \# решётка \[скобка\]`;
  assert.equal(dropRedundantEscapes(source), source);
});

test("dropRedundantEscapes не трогает блок кода", () => {
  const source = ["```", String.raw`printf("%s\, строка")`, "```"].join("\n");
  assert.equal(dropRedundantEscapes(source), source);
});

test("dropRedundantEscapes не трогает моноширинный участок в строке", () => {
  const source = String.raw`текст \(в скобках\) и код ` + "`a\\,b`";
  assert.equal(dropRedundantEscapes(source), "текст (в скобках) и код `a\\,b`");
});

// ── Блоки внутри цитаты ─────────────────────────────────────────────────────
// Редактор «как в документе» делает цитату со списком одной кнопкой, а
// отрисовщик разбирал содержимое цитаты только как строки текста: список
// оставался звёздочками, и первая пара звёздочек съедалась курсивом.

test("список внутри цитаты остаётся списком", () => {
  const html = renderMarkdown([
    "> Перечень документов:",
    ">",
    "> * Акт приёма-передачи;",
    "> * УПД на сервисные сборы;",
  ].join("\n"));

  assert.ok(html.includes("<blockquote"));
  assert.ok(html.includes("<ul"));
  assert.equal(html.match(/<li>/g).length, 2);
  assert.ok(!html.includes("<em>"));
  assert.ok(!html.includes("*"));
});

test("обычная цитата остаётся цитатой", () => {
  const html = renderMarkdown("> Сведения предоставляются в течение 30 дней.");
  assert.ok(html.includes("<blockquote"));
  assert.ok(html.includes("Сведения предоставляются в течение 30 дней."));
});

test("две строки цитаты подряд остаются одним абзацем", () => {
  const html = renderMarkdown("> Первая строка\n> вторая строка");
  assert.ok(html.includes("Первая строка<br>вторая строка"));
});

test("заголовок внутри цитаты отрисовывается заголовком", () => {
  const html = renderMarkdown("> ## Важно\n>\n> текст");
  assert.ok(html.includes("<h2"));
});

test("вложенная цитата отрисовывается вложенной", () => {
  const html = renderMarkdown("> внешняя\n>\n> > внутренняя");
  assert.equal(html.match(/<blockquote/g).length, 2);
});

test("опасный HTML внутри цитаты экранируется ровно один раз", () => {
  const html = renderMarkdown("> <script>alert(1)</script>");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("&amp;lt;"));
});
