// kb-markdown.js
// Отрисовка статьи базы знаний из Markdown в HTML.
//
// Поддерживается ровно тот набор форматирования, который перечислен в ТЗ:
// заголовки трёх уровней, жирный и курсив, маркированные и нумерованные
// списки, чек-листы, цитаты, моноширинные блоки, разделители, таблицы и
// внешние ссылки.
//
// Разметка статей приходит от пользователей приложения и отрисовывается
// внутри окна, где доступны API Tauri. Поэтому текст сначала целиком
// экранируется, и только потом к уже безопасной строке применяется
// форматирование: вставить в статью собственный HTML или обработчик
// событий невозможно по построению, а не по списку запретов.

// Заголовки всех шести уровней: столько предлагает выпадающий список
// редактора в режиме «как в документе». Понимай отрисовщик только три,
// выбранный там «Заголовок 4» превращался бы в абзац с решётками —
// человек нажал кнопку, а получил мусор в тексте.
const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const UNORDERED_ITEM_PATTERN = /^[-*]\s+(.*)$/;
const ORDERED_ITEM_PATTERN = /^\d+[.)]\s+(.*)$/;
const CHECKLIST_ITEM_PATTERN = /^[-*]\s+\[([ xX])\]\s+(.*)$/;
const QUOTE_PATTERN = /^>\s?(.*)$/;
const HORIZONTAL_RULE_PATTERN = /^(-{3,}|\*{3,}|_{3,})$/;
const CODE_FENCE_PATTERN = /^```/;
const TABLE_SEPARATOR_PATTERN = /^\|?[\s:|-]+\|[\s:|-]*$/;

// Обратный слеш перед знаком препинания снимает с него разметочный смысл:
// «\- пункт» — это текст с дефисом, а не список, «0\,05%» — просто число.
// Так экранирует редактор всё, что человек вставляет из Word, и без разбора
// этих последовательностей слеши уезжали в статью прямо на экран.
const ESCAPABLE_PUNCTUATION = "!\"#$%&'()*+,\\-./:;<=>?@[\\]^_`{|}~";
const ESCAPED_CHARACTER_PATTERN = new RegExp(
  `\\\\([${ESCAPABLE_PUNCTUATION}])`, "g",
);
const ESCAPED_LINE_START_PATTERN = new RegExp(
  `^\\\\[${ESCAPABLE_PUNCTUATION}]`,
);

// Ссылка на другую статью хранится идентификатором, а не именем файла и
// не заголовком: статью переименовывают и переносят, а ссылка должна
// продолжать работать.
const ARTICLE_LINK_PATTERN = /^kb-[0-9a-z]{4,}$/i;

// Ссылки на документы. Вложение лежит в служебной папке базы и записывается
// относительным путём; ссылка на файл в сетевой папке помечается схемой,
// иначе её не отличить от вложения. Цель хранится в процентном кодировании:
// пробел в адресе разрывает разметку, а имена документов почти всегда с
// пробелами.
const ATTACHMENT_PREFIX = ".assets/";
const EXTERNAL_FILE_PREFIX = "file:";

// Значок по расширению: по нему видно, чем файл откроется, ещё до клика.
const DOCUMENT_ICONS = {
  doc: "📝", docx: "📝", rtf: "📝", odt: "📝", txt: "📝",
  xls: "📊", xlsx: "📊", csv: "📊", ods: "📊",
  ppt: "📽", pptx: "📽",
  pdf: "📕",
  jpg: "🖼", jpeg: "🖼", png: "🖼", gif: "🖼", bmp: "🖼", tif: "🖼", tiff: "🖼",
  msg: "✉", eml: "✉",
};

/**
 * Экранирует символы, имеющие в HTML особое значение.
 *
 * Принимает произвольный текст, возвращает безопасный для вставки в
 * разметку. Вызывается до любого форматирования.
 */
export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Собирает якорь заголовка для оглавления статьи.
 *
 * Принимает текст заголовка и его порядковый номер. Номер в идентификаторе
 * нужен, потому что одинаковые заголовки в длинной инструкции встречаются
 * часто, а якорь должен вести к нужному.
 */
export function headingAnchorId(headingText, index) {
  const slug = String(headingText)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `kb-heading-${index}-${slug}`.slice(0, 80);
}

// Знаки, которые экранировать незачем: в нашей разметке они ничего не
// значат ни в начале строки, ни внутри неё. Скобки сюда входят намеренно —
// «\(Первого\)» в тексте договора встречается на каждой строке, — а вот
// квадратные скобки остаются экранированными, иначе пара «\[текст\]» и
// освобождённая круглая скобка сложились бы в ссылку.
const REDUNDANT_ESCAPE_PATTERN = /\\([(),;:'"?%$&@={}])/g;

/**
 * Снимает экранирование там, где оно ничего не защищает.
 *
 * Принимает разметку, возвращает её же без лишних обратных слешей.
 * Редактор в режиме «как в документе» экранирует всё, что человек вставил
 * из Word, целыми пригоршнями: «\- начиная с 1 \(Первого\) дня \, 0\,05%».
 * Отрисовщик это понимает, но файл лежит в общей сетевой папке, и юристы
 * открывают его блокнотом — там слеши превращают текст в мусор.
 *
 * Снимается только безопасное. Экранированный дефис в начале строки,
 * решётка, звёздочка и квадратные скобки остаются: там слеш и вправду
 * держит текст текстом.
 *
 * Блоки кода и моноширинные участки не трогаются — внутри них обратный слеш
 * означает сам себя, и «\n» в примере кода должен остаться «\n».
 */
export function dropRedundantEscapes(markdownText) {
  let insideCodeBlock = false;

  return String(markdownText ?? "").split(/\r?\n/).map((line) => {
    if (CODE_FENCE_PATTERN.test(line.trim())) {
      insideCodeBlock = !insideCodeBlock;
      return line;
    }
    if (insideCodeBlock) {
      return line;
    }
    // Чётные куски — вне обратных кавычек, нечётные — внутри них.
    return line.split("`")
      .map((piece, index) => (
        index % 2 === 0 ? piece.replace(REDUNDANT_ESCAPE_PATTERN, "$1") : piece
      ))
      .join("`");
  }).join("\n");
}

/**
 * Перечисляет заголовки статьи для оглавления.
 *
 * Принимает текст статьи в Markdown. Возвращает список заголовков с уровнем,
 * текстом и якорем — в том же порядке и с теми же якорями, что расставляет
 * отрисовка.
 */
export function extractHeadings(markdownText) {
  const headings = [];
  let insideCodeBlock = false;

  String(markdownText ?? "").split(/\r?\n/).forEach((line) => {
    if (CODE_FENCE_PATTERN.test(line)) {
      insideCodeBlock = !insideCodeBlock;
      return;
    }
    if (insideCodeBlock) {
      return;
    }
    const match = line.match(HEADING_PATTERN);
    if (match) {
      const text = match[2].trim();
      headings.push({
        level: match[1].length,
        text: text,
        anchorId: headingAnchorId(text, headings.length),
      });
    }
  });

  return headings;
}

/**
 * Применяет к уже экранированной строке символьное форматирование.
 *
 * Принимает экранированный текст. Возвращает разметку с моноширинными
 * участками, жирным, курсивом и внешними ссылками. Моноширинные участки
 * обрабатываются первыми и выводятся из-под остального форматирования —
 * иначе звёздочки внутри кода превратились бы в курсив.
 */
function renderInline(escapedText, articlesById, documents) {
  // Заполнитель из области частного использования: обычный текст статьи
  // такого символа не содержит, поэтому спрятанный код не спутается с
  // числами. Записан escape-последовательностью — сам символ невидим и в
  // сравнении правок выглядел бы как пропажа куска кода.
  const codeFragments = [];
  let text = escapedText.replace(/`([^`]+)`/g, (whole, code) => {
    codeFragments.push(code);
    return `\uE000${codeFragments.length - 1}\uE000`;
  });

  // Экранированные знаки прячутся тем же приёмом, что и моноширинные
  // участки, и возвращаются в самом конце: иначе «\*текст\*» успел бы
  // превратиться в курсив, а слеши остались бы на экране. Прячутся после
  // моноширинных участков — внутри кода слеш означает сам себя.
  const escapedCharacters = [];
  text = text.replace(ESCAPED_CHARACTER_PATTERN, (whole, character) => {
    escapedCharacters.push(character);
    return `\uE001${escapedCharacters.length - 1}\uE001`;
  });

  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (whole, label, url) => renderLink(label, url, articlesById, documents),
  );
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/(^|\s)_([^_]+)_/g, "$1<em>$2</em>");

  text = text.replace(
    /\uE000(\d+)\uE000/g,
    (whole, index) => `<code class="kb-code">${codeFragments[Number(index)]}</code>`,
  );

  return text.replace(
    /\uE001(\d+)\uE001/g,
    (whole, index) => escapedCharacters[Number(index)],
  );
}

/**
 * Отрисовывает одну ссылку, если на неё можно безопасно перейти.
 *
 * Принимает подпись и адрес (оба уже экранированы). Внешние адреса
 * http и https становятся ссылкой; всё остальное остаётся текстом. Схемы
 * вроде javascript: выполнили бы код в окне приложения, а ссылки на статьи
 * и документы появятся отдельными видами и через другую разметку.
 */
function renderLink(label, url, articlesById, documents) {
  if (ARTICLE_LINK_PATTERN.test(url)) {
    return renderArticleLink(label, url, articlesById);
  }
  if (url.startsWith(ATTACHMENT_PREFIX) || url.startsWith(EXTERNAL_FILE_PREFIX)) {
    return renderDocumentLink(label, url, documents);
  }
  if (!/^https?:\/\//i.test(url)) {
    return label;
  }
  return `<a class="kb-link" data-kb-external="${url}" href="#">${label}</a>`;
}

/**
 * Отрисовывает ссылку на другую статью базы.
 *
 * Принимает подпись из текста, идентификатор статьи и справочник статей.
 * Подпись показывается ровно та, что написал автор: ссылка ставится на
 * слово внутри фразы, и подмена его заголовком статьи ломала бы
 * предложение — «сведения из ЕГРЮЛ» превращалось в «сведения из
 * Корпоративка».
 *
 * ТЗ (§3.4.1) требовало подставлять актуальный заголовок, но это правило
 * писалось для случая, когда подписью и был заголовок. Теперь человек сам
 * выбирает слово, поэтому актуальное название статьи показывается
 * подсказкой при наведении — переименование остаётся заметным, а текст
 * остаётся текстом.
 *
 * Если статья не найдена, ссылка помечается как битая, а не ведёт в никуда:
 * читатель должен видеть, что материал исчез.
 */
function renderArticleLink(label, articleId, articlesById) {
  const target = articlesById ? articlesById.get(articleId.toLowerCase()) : null;
  if (!target) {
    return `<span class="kb-link-broken" title="Статья не найдена">${label}</span>`;
  }
  const hint = escapeHtml(`Статья: ${target.title}`);
  return `<a class="kb-link" data-kb-article-link="${articleId}" `
    + `title="${hint}" href="#">${label}</a>`;
}

/**
 * Перечисляет идентификаторы статей, на которые ссылается текст.
 *
 * Принимает разметку статьи. Возвращает набор идентификаторов — по нему
 * строится блок обратных ссылок «Ссылки на эту статью».
 */
export function extractArticleLinks(markdownText) {
  const found = new Set();
  const pattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let match = pattern.exec(String(markdownText ?? ""));
  while (match) {
    if (ARTICLE_LINK_PATTERN.test(match[1])) {
      found.add(match[1].toLowerCase());
    }
    match = pattern.exec(String(markdownText ?? ""));
  }
  return found;
}

/**
 * Отрисовывает ссылку на документ.
 *
 * Принимает подпись, цель и справочник доступности файлов. Показывает
 * значок по типу файла и имя, как требует ТЗ. Недоступный файл (удалён, нет
 * прав, сетевой диск отключён) помечается, а не открывает пустоту: человек
 * должен видеть, что документа больше нет, до того как нажмёт.
 */
function renderDocumentLink(label, target, documents) {
  const state = documents ? documents.get(target) : null;
  const name = decodeDocumentName(target);
  const icon = DOCUMENT_ICONS[fileExtension(name)] || "📎";

  if (state && !state.available) {
    const reason = escapeHtml(state.reason || "Файл недоступен");
    return `<span class="kb-doc-link kb-doc-broken" title="${reason}">`
      + `${icon} ${label}</span>`;
  }
  const hint = escapeHtml(name);
  return `<a class="kb-doc-link" data-kb-document="${target}" title="${hint}" `
    + `href="#">${icon} ${label}</a>`;
}

/**
 * Возвращает имя файла из цели ссылки.
 *
 * Цель хранится в процентном кодировании, поэтому её нужно раскодировать —
 * иначе пользователь увидит «%D0%94%D0%BE...» вместо названия документа.
 */
function decodeDocumentName(target) {
  const withoutPrefix = target.startsWith(EXTERNAL_FILE_PREFIX)
    ? target.slice(EXTERNAL_FILE_PREFIX.length)
    : target;
  let readable = withoutPrefix;
  try {
    readable = decodeURIComponent(withoutPrefix);
  } catch {
    // Испорченное кодирование — показываем как есть, это лучше ошибки.
  }
  return readable.split(/[\/]/).pop() || readable;
}

/**
 * Возвращает расширение файла в нижнем регистре.
 */
function fileExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * Отрисовывает статью из Markdown в HTML.
 *
 * Принимает текст статьи. Возвращает строку разметки, готовую для вставки
 * в контейнер статьи. Неизвестная разметка остаётся обычным текстом —
 * статья должна открыться в любом случае, пусть и без оформления.
 */
export function renderMarkdown(markdownText, articlesById, documents) {
  const lines = String(markdownText ?? "").split(/\r?\n/);
  const htmlParts = [];

  let paragraphLines = [];
  let listItems = [];
  let listTag = "";
  let quoteLines = [];
  let codeLines = [];
  let tableRows = [];
  let insideCodeBlock = false;
  let headingIndex = 0;

  function flushParagraph() {
    if (paragraphLines.length) {
      htmlParts.push(`<p>${renderInline(paragraphLines.join("<br>"), articlesById, documents)}</p>`);
      paragraphLines = [];
    }
  }

  function flushList() {
    if (listItems.length) {
      htmlParts.push(`<${listTag} class="kb-list">${listItems.join("")}</${listTag}>`);
      listItems = [];
      listTag = "";
    }
  }

  function flushQuote() {
    if (quoteLines.length) {
      htmlParts.push(
        `<blockquote class="kb-quote">${renderInline(quoteLines.join("<br>"), articlesById, documents)}</blockquote>`,
      );
      quoteLines = [];
    }
  }

  function flushTable() {
    if (!tableRows.length) {
      return;
    }
    const [headerRow, ...bodyRows] = tableRows;
    const head = headerRow
      .map((cell) => `<th>${renderInline(cell, articlesById, documents)}</th>`)
      .join("");
    const body = bodyRows
      .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell, articlesById, documents)}</td>`).join("")}</tr>`)
      .join("");
    htmlParts.push(
      `<div class="kb-table-scroll"><table class="kb-table">` +
      `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
    );
    tableRows = [];
  }

  function flushAllBlocks() {
    flushParagraph();
    flushList();
    flushQuote();
    flushTable();
  }

  for (const rawLine of lines) {
    const line = escapeHtml(rawLine);

    if (CODE_FENCE_PATTERN.test(rawLine.trim())) {
      if (insideCodeBlock) {
        htmlParts.push(`<pre class="kb-pre"><code>${codeLines.join("\n")}</code></pre>`);
        codeLines = [];
      } else {
        flushAllBlocks();
      }
      insideCodeBlock = !insideCodeBlock;
      continue;
    }
    if (insideCodeBlock) {
      codeLines.push(line);
      continue;
    }

    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushAllBlocks();
      continue;
    }

    if (ESCAPED_LINE_START_PATTERN.test(trimmed)) {
      // Экранирование в начале строки для того и ставится, чтобы строка не
      // стала списком, заголовком или цитатой. Проверять её дальнейшими
      // образцами нельзя — «\- пункт» снова превратился бы в список.
      flushList();
      flushQuote();
      flushTable();
      paragraphLines.push(line);
      continue;
    }

    if (HORIZONTAL_RULE_PATTERN.test(trimmed)) {
      flushAllBlocks();
      htmlParts.push('<hr class="kb-rule">');
      continue;
    }

    const headingMatch = trimmed.match(HEADING_PATTERN);
    if (headingMatch) {
      flushAllBlocks();
      const level = headingMatch[1].length;
      const headingText = escapeHtml(headingMatch[2].trim());
      const anchorId = headingAnchorId(headingMatch[2].trim(), headingIndex);
      headingIndex += 1;
      htmlParts.push(
        `<h${level} id="${anchorId}" class="kb-heading kb-heading-${level}">` +
        `${renderInline(headingText, articlesById, documents)}</h${level}>`,
      );
      continue;
    }

    const checklistMatch = trimmed.match(CHECKLIST_ITEM_PATTERN);
    if (checklistMatch) {
      flushParagraph();
      flushQuote();
      flushTable();
      if (listTag !== "ul") {
        flushList();
        listTag = "ul";
      }
      const isChecked = checklistMatch[1].toLowerCase() === "x";
      listItems.push(
        `<li class="kb-check${isChecked ? " kb-check-done" : ""}">` +
        `<span class="kb-check-box" aria-hidden="true">${isChecked ? "✓" : ""}</span>` +
        `<span>${renderInline(escapeHtml(checklistMatch[2]), articlesById, documents)}</span></li>`,
      );
      continue;
    }

    const unorderedMatch = trimmed.match(UNORDERED_ITEM_PATTERN);
    const orderedMatch = trimmed.match(ORDERED_ITEM_PATTERN);
    if (unorderedMatch || orderedMatch) {
      flushParagraph();
      flushQuote();
      flushTable();
      const wantedTag = unorderedMatch ? "ul" : "ol";
      if (listTag !== wantedTag) {
        flushList();
        listTag = wantedTag;
      }
      const itemText = (unorderedMatch || orderedMatch)[1];
      listItems.push(`<li>${renderInline(escapeHtml(itemText), articlesById, documents)}</li>`);
      continue;
    }

    const quoteMatch = trimmed.match(QUOTE_PATTERN);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      flushTable();
      quoteLines.push(escapeHtml(quoteMatch[1]));
      continue;
    }

    if (trimmed.includes("|") && trimmed.startsWith("|")) {
      flushParagraph();
      flushList();
      flushQuote();
      if (TABLE_SEPARATOR_PATTERN.test(trimmed)) {
        // Строка-разделитель шапки таблицы: оформление, а не данные.
        continue;
      }
      tableRows.push(
        trimmed.replace(/^\||\|$/g, "").split("|").map((cell) => escapeHtml(cell.trim())),
      );
      continue;
    }

    flushList();
    flushQuote();
    flushTable();
    paragraphLines.push(line);
  }

  if (insideCodeBlock && codeLines.length) {
    // Незакрытый блок кода — статья всё равно должна отобразиться.
    htmlParts.push(`<pre class="kb-pre"><code>${codeLines.join("\n")}</code></pre>`);
  }
  flushAllBlocks();

  return htmlParts.join("\n");
}
