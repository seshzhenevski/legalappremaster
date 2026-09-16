// tab-knowledge-base.js
// Вкладка «База знаний» — чтение статей юридического отдела.
//
// Отвечает только за свою вкладку: читает базу с сетевого диска через
// backend-api, держит её в памяти и показывает дерево разделов и статью.
//
// Вся база загружается одним обращением к бэкенду при первом открытии
// вкладки. Каждый вызов бэкенда — это запуск отдельного процесса примерно
// на три секунды, а чтение базы знаний по своей природе кликовое: открыл
// статью, перешёл по ссылке, вернулся, поискал. Поэтому платим один раз,
// а дальше открытие статьи и поиск идут из памяти, мгновенно.

import {
  requestKnowledgeBase,
  requestKnowledgeBaseCreate,
  requestKnowledgeBaseLock,
  requestKnowledgeBaseSave,
  requestKnowledgeBaseUnlock,
  requestKnowledgeBaseVersion,
  requestKnowledgeBaseVersionRestore,
  requestKnowledgeBaseVersions,
} from "./backend-api.js";
import { selectDirectory } from "./file-dialogs.js";
import { loadKnowledgeBaseRoot, saveKnowledgeBaseRoot } from "./kb-settings-store.js";
import { extractHeadings, renderMarkdown } from "./kb-markdown.js";
import { showToast } from "./toast.js";

// Сколько ждать снятия замка при закрытии приложения. Обращение к бэкенду —
// это запуск процесса, а запись на отключённый сетевой диск может встать
// надолго; закрытие окна ждать этого не должно.
const CLOSE_UNLOCK_TIMEOUT_MS = 4000;

// Подписи и оформление статусов статьи из семантической палитры приложения.
const STATUS_STYLES = {
  "актуально": "kb-status kb-status-current",
  "устарело": "kb-status kb-status-outdated",
  "черновик": "kb-status kb-status-draft",
};

/**
 * Приводит пойманную ошибку к тексту, пригодному для показа пользователю.
 *
 * Принимает что угодно из catch. Обычная ошибка JS несёт текст в поле
 * message, но команды Tauri отклоняют обещание простой строкой — у неё
 * такого поля нет, и обращение к нему дало бы пользователю «undefined»
 * вместо объяснения.
 */
function describeError(error) {
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

const knowledgeBase = {
  rootPath: "",
  articles: [],
  articlesByPath: new Map(),
  tree: null,
  isLoaded: false,
};

let selectedRelativePath = "";
let collapsedFolders = new Set();

// Состояние правки. Отпечаток запоминается на момент открытия статьи: именно
// он позволяет при сохранении понять, что статью тем временем правил кто-то
// ещё, и не затереть чужую работу.
const editState = {
  isEditing: false,
  articleId: "",
  relativePath: "",
  fingerprint: "",
  properties: null,
};

/**
 * Инициализирует вкладку базы знаний.
 *
 * Вешает обработчики на поиск, кнопку обновления и выбор корневой папки.
 * Саму базу не читает: загрузка откладывается до первого открытия вкладки,
 * чтобы не задерживать запуск приложения тем, кто базой не пользуется.
 */
export function initKnowledgeBaseTab() {
  const searchInput = document.getElementById("kb-search");
  if (!searchInput) {
    return;
  }

  searchInput.addEventListener("input", renderTreePane);
  document.getElementById("kb-refresh-button")
    .addEventListener("click", () => reloadKnowledgeBase(true));

  // Выбрать папку можно из трёх мест: первичная настройка, экран недоступной
  // папки и кнопка на панели — обработчик у всех один.
  document.querySelectorAll("[data-kb-choose-root]").forEach((button) => {
    button.addEventListener("click", handleRootSelection);
  });

  document.getElementById("kb-tree").addEventListener("click", handleTreeClick);
  document.getElementById("kb-article-body")
    .addEventListener("click", handleArticleClick);

  const navigationButton = document.querySelector(
    '[data-tab-target="panel-knowledge-base"]',
  );
  if (navigationButton) {
    navigationButton.addEventListener("click", handleTabOpened);
  }

  initEditor();
}

/**
 * Подключает режим правки: кнопки, панель форматирования, живой предпросмотр.
 *
 * Отдельно вешается снятие замка при закрытии приложения — иначе статья
 * осталась бы занятой до тех пор, пока замок не признают брошенным.
 */
function initEditor() {
  document.getElementById("kb-edit-button")
    .addEventListener("click", handleEditClick);
  document.getElementById("kb-save-button")
    .addEventListener("click", handleSaveClick);
  document.getElementById("kb-cancel-button")
    .addEventListener("click", handleCancelClick);
  document.getElementById("kb-new-article-button")
    .addEventListener("click", handleNewArticleClick);
  document.getElementById("kb-versions-button")
    .addEventListener("click", handleVersionsClick);
  document.getElementById("kb-versions-close")
    .addEventListener("click", () => hideOverlay("kb-versions-overlay"));

  document.getElementById("kb-conflict-back")
    .addEventListener("click", () => hideOverlay("kb-conflict-overlay"));
  document.getElementById("kb-conflict-reload")
    .addEventListener("click", handleConflictReload);
  document.getElementById("kb-conflict-copy")
    .addEventListener("click", handleConflictSaveCopy);

  const editor = document.getElementById("kb-editor");
  editor.addEventListener("input", updatePreview);

  buildFormatToolbar();
  releaseLockOnApplicationClose();
}

/**
 * Снимает замок, когда пользователь закрывает приложение.
 *
 * Замок — файл на общем диске, сам он не исчезает. Без этого статья
 * оставалась бы занятой для коллег два часа, пока замок не сочтут брошенным.
 */
function releaseLockOnApplicationClose() {
  try {
    const { getCurrentWindow } = window.__TAURI__.window;
    getCurrentWindow().onCloseRequested(async () => {
      await releaseLockBeforeClosing();
    });
  } catch (error) {
    // Подписка недоступна — замок снимется по истечении срока давности.
    console.warn("Не удалось подписаться на закрытие окна:", error);
  }
}

/**
 * Пытается снять замок, но никогда не мешает приложению закрыться.
 *
 * Подписавшись на закрытие окна, Tauri перестаёт закрывать его само и ждёт,
 * пока обработчик договорит: исключение внутри или зависший вызов оставляют
 * окно висеть навсегда. Поэтому здесь и перехват любой ошибки, и предел
 * ожидания — снятие замка на сетевом диске может встать надолго, если диск
 * отключили. Не снятый замок — мелкая неприятность на два часа; окно,
 * которое не закрывается, — поломка приложения.
 */
async function releaseLockBeforeClosing() {
  if (!editState.isEditing || !editState.articleId) {
    return;
  }

  const unlock = requestKnowledgeBaseUnlock(
    knowledgeBase.rootPath, editState.articleId,
  ).catch((error) => {
    console.warn("Замок не снят при закрытии:", describeError(error));
  });
  const deadline = new Promise((resolve) => setTimeout(resolve, CLOSE_UNLOCK_TIMEOUT_MS));

  await Promise.race([unlock, deadline]);
}

/**
 * Загружает базу при первом открытии вкладки.
 *
 * Повторные переключения на вкладку ничего не перечитывают — для этого есть
 * кнопка «Обновить».
 */
async function handleTabOpened() {
  if (knowledgeBase.isLoaded) {
    return;
  }
  knowledgeBase.rootPath = await loadKnowledgeBaseRoot();
  if (!knowledgeBase.rootPath) {
    showPane("kb-setup-pane");
    return;
  }
  await reloadKnowledgeBase(false);
}

/**
 * Показывает выбор папки и перечитывает базу из неё.
 *
 * Отмена выбора оставляет всё как было.
 */
async function handleRootSelection() {
  const selectedPath = await selectDirectory();
  if (!selectedPath) {
    return;
  }
  await saveKnowledgeBaseRoot(selectedPath);
  knowledgeBase.rootPath = selectedPath;
  await reloadKnowledgeBase(true);
}

/**
 * Перечитывает базу знаний с сетевого диска.
 *
 * Принимает признак, показывать ли уведомление об успехе (при ручном
 * обновлении — да, при первом открытии вкладки — нет). Недоступная папка
 * не считается сбоем: показывается объяснение и предложение выбрать другую.
 */
async function reloadKnowledgeBase(announceResult) {
  showPane("kb-loading-pane");
  try {
    const loaded = await requestKnowledgeBase(knowledgeBase.rootPath);

    if (!loaded.available) {
      document.getElementById("kb-unavailable-path").textContent =
        knowledgeBase.rootPath;
      showPane("kb-unavailable-pane");
      return;
    }

    knowledgeBase.tree = loaded.tree;
    knowledgeBase.articles = loaded.articles;
    knowledgeBase.articlesByPath = new Map(
      loaded.articles.map((article) => [article.relative_path, article]),
    );
    knowledgeBase.isLoaded = true;

    showPane("kb-content-pane");
    renderTreePane();
    restoreSelection();

    if (announceResult) {
      showToast(`База знаний обновлена: статей — ${loaded.articles.length}`);
    }
  } catch (error) {
    document.getElementById("kb-error-text").textContent = describeError(error);
    showPane("kb-error-pane");
  }
}

/**
 * Показывает одну из панелей состояния вкладки, пряча остальные.
 *
 * Принимает идентификатор нужной панели: настройка пути, загрузка,
 * недоступная папка, ошибка или сама база.
 */
function showPane(visiblePaneId) {
  ["kb-setup-pane", "kb-loading-pane", "kb-unavailable-pane",
   "kb-error-pane", "kb-content-pane"].forEach((paneId) => {
    const pane = document.getElementById(paneId);
    if (pane) {
      pane.classList.toggle("hidden", paneId !== visiblePaneId);
    }
  });
}

/**
 * Восстанавливает выбранную статью после перечитывания базы.
 *
 * Если открытую статью тем временем удалили или переименовали, выбор
 * сбрасывается на приглашение выбрать статью, а не на пустой экран.
 */
function restoreSelection() {
  if (selectedRelativePath && knowledgeBase.articlesByPath.has(selectedRelativePath)) {
    showArticle(selectedRelativePath);
  } else {
    selectedRelativePath = "";
    showEmptyArticle();
  }
}

/**
 * Перерисовывает левую колонку: дерево разделов или результаты поиска.
 *
 * Поиск идёт по памяти, без обращения к бэкенду, поэтому реагирует на
 * каждое нажатие клавиши.
 */
function renderTreePane() {
  const container = document.getElementById("kb-tree");
  const query = document.getElementById("kb-search").value.trim().toLowerCase();
  container.innerHTML = "";

  if (query) {
    container.appendChild(buildSearchResults(query));
    return;
  }
  if (knowledgeBase.tree) {
    container.appendChild(buildFolderChildren(knowledgeBase.tree));
  }
}

/**
 * Собирает список статей, подходящих под поисковый запрос.
 *
 * Принимает запрос в нижнем регистре. Ищет по заголовку и по тексту статьи;
 * совпадение в заголовке ставится выше совпадения в тексте.
 */
function buildSearchResults(query) {
  const byTitle = [];
  const byBody = [];

  knowledgeBase.articles.forEach((article) => {
    if (article.title.toLowerCase().includes(query)) {
      byTitle.push(article);
    } else if (article.body.toLowerCase().includes(query)) {
      byBody.push(article);
    }
  });

  const results = byTitle.concat(byBody);
  const list = document.createElement("div");
  list.className = "kb-search-results";

  if (!results.length) {
    const empty = document.createElement("p");
    empty.className = "kb-empty-hint";
    empty.textContent = "Ничего не найдено.";
    list.appendChild(empty);
    return list;
  }

  const counter = document.createElement("p");
  counter.className = "kb-search-counter";
  counter.textContent = `Найдено статей: ${results.length}`;
  list.appendChild(counter);

  results.forEach((article) => list.appendChild(buildArticleButton(article, true)));
  return list;
}

/**
 * Собирает содержимое одного раздела: вложенные разделы и статьи.
 *
 * Принимает узел дерева. Возвращает элемент со списком, пригодный для
 * вставки в родительский раздел.
 */
function buildFolderChildren(folderNode) {
  const container = document.createElement("div");
  container.className = "kb-folder-children";

  folderNode.folders.forEach((childFolder) => {
    container.appendChild(buildFolderNode(childFolder));
  });
  folderNode.articles.forEach((article) => {
    container.appendChild(buildArticleButton(article, false));
  });

  if (!folderNode.folders.length && !folderNode.articles.length) {
    const empty = document.createElement("p");
    empty.className = "kb-empty-hint";
    empty.textContent = "Раздел пуст.";
    container.appendChild(empty);
  }
  return container;
}

/**
 * Собирает раздел с кнопкой раскрытия и вложенным содержимым.
 *
 * Принимает узел дерева. Состояние «свёрнут» хранится по относительному
 * пути раздела и переживает обновление базы.
 */
function buildFolderNode(folderNode) {
  const wrapper = document.createElement("div");
  wrapper.className = "kb-folder";

  const isCollapsed = collapsedFolders.has(folderNode.relative_path);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "kb-folder-toggle";
  toggle.dataset.kbFolder = folderNode.relative_path;
  toggle.setAttribute("aria-expanded", isCollapsed ? "false" : "true");

  const chevron = document.createElement("span");
  chevron.className = "kb-chevron";
  chevron.textContent = isCollapsed ? "▸" : "▾";
  toggle.appendChild(chevron);

  const name = document.createElement("span");
  name.className = "kb-folder-name";
  name.textContent = folderNode.name;
  toggle.appendChild(name);

  wrapper.appendChild(toggle);

  const children = buildFolderChildren(folderNode);
  children.classList.toggle("hidden", isCollapsed);
  wrapper.appendChild(children);

  return wrapper;
}

/**
 * Собирает строку статьи в дереве или в результатах поиска.
 *
 * Принимает карточку статьи и признак показа пути до неё (в результатах
 * поиска путь нужен, чтобы понимать, из какого раздела статья).
 */
function buildArticleButton(article, showPath) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "kb-article-item";
  button.dataset.kbArticle = article.relative_path;
  button.classList.toggle("kb-article-active",
    article.relative_path === selectedRelativePath);

  const icon = document.createElement("span");
  icon.className = "kb-article-icon";
  icon.textContent = article.icon || "📄";
  button.appendChild(icon);

  const labels = document.createElement("span");
  labels.className = "kb-article-labels";

  const title = document.createElement("span");
  title.className = "kb-article-title";
  title.textContent = article.title;
  labels.appendChild(title);

  if (showPath) {
    const path = document.createElement("span");
    path.className = "kb-article-path";
    path.textContent = article.relative_path;
    labels.appendChild(path);
  }
  button.appendChild(labels);

  if (article.status && article.status !== "актуально") {
    const status = document.createElement("span");
    status.className = STATUS_STYLES[article.status] || STATUS_STYLES["черновик"];
    status.textContent = article.status;
    button.appendChild(status);
  }
  return button;
}

/**
 * Обрабатывает клик по дереву: раскрытие раздела или выбор статьи.
 *
 * Один обработчик на всё дерево вместо обработчика на каждой строке —
 * дерево перерисовывается целиком, и вешать их заново было бы лишней работой.
 */
function handleTreeClick(event) {
  const folderToggle = event.target.closest("[data-kb-folder]");
  if (folderToggle) {
    const folderPath = folderToggle.dataset.kbFolder;
    if (collapsedFolders.has(folderPath)) {
      collapsedFolders.delete(folderPath);
    } else {
      collapsedFolders.add(folderPath);
    }
    renderTreePane();
    return;
  }

  const articleButton = event.target.closest("[data-kb-article]");
  if (articleButton) {
    // Переключение статьи во время правки выбросило бы набранный текст:
    // он нигде больше не сохранён, пока не нажата кнопка сохранения.
    if (editState.isEditing) {
      showToast("Сначала сохраните или отмените правки открытой статьи");
      return;
    }
    showArticle(articleButton.dataset.kbArticle);
    renderTreePane();
  }
}

/**
 * Показывает статью в правой колонке.
 *
 * Принимает относительный путь статьи. Берёт её из памяти — обращения к
 * бэкенду здесь не происходит, поэтому переход мгновенный.
 */
function showArticle(relativePath) {
  const article = knowledgeBase.articlesByPath.get(relativePath);
  if (!article) {
    return;
  }
  selectedRelativePath = relativePath;

  document.getElementById("kb-article-placeholder").classList.add("hidden");
  document.getElementById("kb-article").classList.remove("hidden");

  document.getElementById("kb-article-icon").textContent = article.icon || "📄";
  document.getElementById("kb-article-title").textContent = article.title;
  document.getElementById("kb-article-body").innerHTML = renderMarkdown(article.body);

  renderArticleProperties(article);
  renderTableOfContents(article.body);
}

/**
 * Заполняет строку свойств статьи: статус, категория, автор, дата.
 *
 * Принимает карточку статьи. Пустые свойства не показываются вовсе, чтобы
 * шапка не пестрела прочерками.
 */
function renderArticleProperties(article) {
  const container = document.getElementById("kb-article-properties");
  container.innerHTML = "";

  const status = document.createElement("span");
  status.className = STATUS_STYLES[article.status] || STATUS_STYLES["черновик"];
  status.textContent = article.status;
  container.appendChild(status);

  const properties = article.properties || {};
  const details = [
    properties.category,
    properties.author,
    properties.updated_at ? `обновлена ${formatDateTime(properties.updated_at)}` : "",
  ].filter(Boolean);

  details.forEach((text) => {
    const chip = document.createElement("span");
    chip.className = "kb-property";
    chip.textContent = text;
    container.appendChild(chip);
  });
}

/**
 * Приводит дату из свойств статьи к виду «12.09.2026 14:30».
 *
 * Принимает строку ISO. Неразобранное значение возвращает как есть —
 * свойство мог править человек руками.
 */
function formatDateTime(isoText) {
  const parsed = new Date(isoText);
  if (Number.isNaN(parsed.getTime())) {
    return isoText;
  }
  const date = parsed.toLocaleDateString("ru-RU");
  const time = parsed.toLocaleTimeString("ru-RU", {
    hour: "2-digit", minute: "2-digit",
  });
  return `${date} ${time}`;
}

/**
 * Строит оглавление статьи из её заголовков.
 *
 * Принимает текст статьи. Оглавление появляется только у длинных статей —
 * у документа с одним заголовком оно лишь занимает место.
 */
function renderTableOfContents(markdownText) {
  const container = document.getElementById("kb-article-toc");
  container.innerHTML = "";

  const headings = extractHeadings(markdownText);
  if (headings.length < 2) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");

  const caption = document.createElement("p");
  caption.className = "kb-toc-caption";
  caption.textContent = "Содержание";
  container.appendChild(caption);

  headings.forEach((heading) => {
    const link = document.createElement("button");
    link.type = "button";
    link.className = `kb-toc-item kb-toc-level-${heading.level}`;
    link.textContent = heading.text;
    link.addEventListener("click", () => {
      const target = document.getElementById(heading.anchorId);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    container.appendChild(link);
  });
}

/**
 * Показывает приглашение выбрать статью вместо пустой правой колонки.
 */
function showEmptyArticle() {
  document.getElementById("kb-article").classList.add("hidden");
  document.getElementById("kb-article-placeholder").classList.remove("hidden");
}

/**
 * Открывает внешнюю ссылку из текста статьи в браузере.
 *
 * Внутри окна приложения доступны API Tauri, поэтому сторонние сайты
 * открываются снаружи — во внешнем браузере, как того требует ТЗ.
 */
async function handleArticleClick(event) {
  const link = event.target.closest("[data-kb-external]");
  if (!link) {
    return;
  }
  event.preventDefault();
  try {
    const { open } = window.__TAURI__.shell;
    await open(link.dataset.kbExternal);
  } catch (error) {
    showToast(`Не удалось открыть ссылку: ${describeError(error)}`);
  }
}

// ── Режим правки ─────────────────────────────────────────────────────────────

// Кнопки панели форматирования: подпись, подсказка и что вставляется вокруг
// выделения. Набор ровно тот, что перечислен в ТЗ.
const FORMAT_BUTTONS = [
  { label: "Ж", title: "Жирный", before: "**", after: "**" },
  { label: "К", title: "Курсив", before: "*", after: "*" },
  { label: "H1", title: "Заголовок", before: "# ", after: "", line: true },
  { label: "H2", title: "Подзаголовок", before: "## ", after: "", line: true },
  { label: "H3", title: "Заголовок третьего уровня", before: "### ", after: "", line: true },
  { label: "•", title: "Маркированный список", before: "- ", after: "", line: true },
  { label: "1.", title: "Нумерованный список", before: "1. ", after: "", line: true },
  { label: "☑", title: "Пункт чек-листа", before: "- [ ] ", after: "", line: true },
  { label: "❝", title: "Цитата", before: "> ", after: "", line: true },
  { label: "</>", title: "Моноширинный текст", before: "`", after: "`" },
  { label: "—", title: "Разделитель", before: "\n---\n", after: "" },
  { label: "🔗", title: "Ссылка на сайт", before: "[", after: "](https://)" },
  { label: "▦", title: "Таблица", before: "\n| Столбец | Столбец |\n| --- | --- |\n| | |\n", after: "" },
];

/**
 * Собирает панель кнопок форматирования над редактором.
 *
 * Кнопки вставляют разметку вокруг выделенного текста. Разметка остаётся
 * видимой: статьи хранятся файлами Markdown, и то, что человек печатает,
 * ровно то и лежит на диске.
 */
function buildFormatToolbar() {
  const toolbar = document.getElementById("kb-format-toolbar");
  toolbar.innerHTML = "";

  FORMAT_BUTTONS.forEach((format) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "kb-format-button";
    button.textContent = format.label;
    button.title = format.title;
    button.addEventListener("click", () => applyFormat(format));
    toolbar.appendChild(button);
  });
}

/**
 * Применяет форматирование к выделенному тексту в редакторе.
 *
 * Принимает описание кнопки. Построчные форматы (заголовки, списки, цитаты)
 * приписываются в начало каждой выделенной строки, остальные обрамляют
 * выделение. После вставки фокус возвращается в поле — иначе после каждой
 * кнопки пришлось бы кликать в текст заново.
 */
function applyFormat(format) {
  const editor = document.getElementById("kb-editor");
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selected = editor.value.slice(start, end);

  let replacement;
  if (format.line) {
    const lines = (selected || "").split("\n");
    replacement = lines.map((line) => `${format.before}${line}`).join("\n");
  } else {
    replacement = `${format.before}${selected}${format.after}`;
  }

  editor.setRangeText(replacement, start, end, "end");
  editor.focus();
  updatePreview();
}

/**
 * Перерисовывает предпросмотр статьи по текущему тексту редактора.
 */
function updatePreview() {
  document.getElementById("kb-preview").innerHTML =
    renderMarkdown(document.getElementById("kb-editor").value);
}

/**
 * Переводит открытую статью в режим правки, заняв её замком.
 *
 * Если статью уже правит коллега, режим не включается: показывается, кто и
 * с какого времени её держит. Брошенный замок (старше двух часов) можно
 * перехватить, но только подтвердив это явно.
 */
async function handleEditClick() {
  const article = knowledgeBase.articlesByPath.get(selectedRelativePath);
  if (!article) {
    return;
  }

  setBusy(true);
  try {
    let lock = await requestKnowledgeBaseLock(knowledgeBase.rootPath, article.id);

    if (!lock.acquired && lock.holder && lock.holder.stale) {
      const since = formatDateTime(lock.holder.acquired_at);
      const takeOver = window.confirm(
        `Статью держит ${lock.holder.user} (${lock.holder.computer}) с ${since}, ` +
        "но приложение у него, судя по всему, закрылось аварийно.\n\n" +
        "Перехватить редактирование?",
      );
      if (!takeOver) {
        showLockBanner(lock.holder);
        return;
      }
      lock = await requestKnowledgeBaseLock(knowledgeBase.rootPath, article.id, true);
    }

    if (!lock.acquired) {
      showLockBanner(lock.holder);
      return;
    }
    enterEditMode(article);
  } catch (error) {
    showToast(`Не удалось занять статью: ${describeError(error)}`);
  } finally {
    setBusy(false);
  }
}

/**
 * Показывает, кто занял статью, вместо включения режима правки.
 *
 * Принимает сведения о владельце замка. Статья остаётся доступной для
 * чтения — занят только режим правки.
 */
function showLockBanner(holder) {
  const banner = document.getElementById("kb-lock-banner");
  if (!holder) {
    banner.classList.add("hidden");
    return;
  }
  banner.textContent =
    `Редактирует ${holder.user} (${holder.computer}) с ${formatDateTime(holder.acquired_at)}`;
  banner.classList.remove("hidden");
}

/**
 * Включает режим правки для статьи.
 *
 * Принимает карточку статьи. Запоминает отпечаток содержимого на момент
 * открытия — по нему при сохранении определяется, менял ли статью кто-то ещё.
 */
function enterEditMode(article) {
  editState.isEditing = true;
  editState.articleId = article.id;
  editState.relativePath = article.relative_path;
  editState.fingerprint = article.fingerprint;
  editState.properties = { ...article.properties };

  document.getElementById("kb-editor").value = article.body;
  document.getElementById("kb-edit-title").value = article.properties.title || "";
  document.getElementById("kb-edit-status").value =
    article.properties.status || "черновик";
  document.getElementById("kb-edit-icon").value = article.properties.icon || "";
  updatePreview();

  toggleEditChrome(true);
  showLockBanner(null);
}

/**
 * Переключает интерфейс между чтением и правкой.
 *
 * Принимает признак режима правки. Кнопки «Изменить» и «Версии» в правке
 * скрыты: править и откатывать одновременно — верный способ потерять текст.
 */
function toggleEditChrome(isEditing) {
  const shown = (id, visible) =>
    document.getElementById(id).classList.toggle("hidden", !visible);

  shown("kb-edit-mode", isEditing);
  shown("kb-view-mode", !isEditing);
  shown("kb-edit-properties", isEditing);
  shown("kb-article-properties", !isEditing);
  shown("kb-article-title", !isEditing);
  shown("kb-edit-button", !isEditing);
  shown("kb-versions-button", !isEditing);
  shown("kb-save-button", isEditing);
  shown("kb-cancel-button", isEditing);
}

/**
 * Сохраняет правки статьи.
 *
 * Если статью тем временем изменил кто-то ещё, файл не перезаписывается:
 * показывается окно выбора, а набранный текст остаётся в редакторе.
 */
async function handleSaveClick() {
  setBusy(true);
  try {
    const properties = {
      ...editState.properties,
      title: document.getElementById("kb-edit-title").value.trim() || "Без названия",
      status: document.getElementById("kb-edit-status").value,
      icon: document.getElementById("kb-edit-icon").value.trim(),
    };

    const result = await requestKnowledgeBaseSave({
      root_path: knowledgeBase.rootPath,
      relative_path: editState.relativePath,
      properties: properties,
      body: document.getElementById("kb-editor").value,
      expected_fingerprint: editState.fingerprint,
    });

    if (result.conflict) {
      showConflict(result);
      return;
    }

    await requestKnowledgeBaseUnlock(knowledgeBase.rootPath, editState.articleId);
    editState.isEditing = false;
    toggleEditChrome(false);
    await reloadKnowledgeBase(false);
    showToast("Статья сохранена");
  } catch (error) {
    showToast(`Не удалось сохранить: ${describeError(error)}`);
  } finally {
    setBusy(false);
  }
}

/**
 * Выходит из режима правки, отказавшись от изменений.
 *
 * Спрашивает подтверждение: набранный текст нигде больше не сохранён.
 */
async function handleCancelClick() {
  const editor = document.getElementById("kb-editor");
  const article = knowledgeBase.articlesByPath.get(editState.relativePath);
  const hasChanges = article && editor.value !== article.body;

  if (hasChanges &&
      !window.confirm("Отменить правки? Несохранённый текст будет потерян.")) {
    return;
  }

  await requestKnowledgeBaseUnlock(knowledgeBase.rootPath, editState.articleId);
  editState.isEditing = false;
  toggleEditChrome(false);
  showArticle(editState.relativePath);
}

/**
 * Создаёт статью в корне базы и сразу открывает её на правку.
 *
 * Заголовок не спрашивается отдельным окном: статья заводится с рабочим
 * названием, и его тут же можно заменить в поле заголовка — на одно окно
 * меньше на пути к тексту.
 */
async function handleNewArticleClick() {
  setBusy(true);
  try {
    const created = await requestKnowledgeBaseCreate({
      root_path: knowledgeBase.rootPath,
      folder_relative_path: "",
      title: "Новая статья",
    });

    await reloadKnowledgeBase(false);
    const article = knowledgeBase.articlesByPath.get(created.relative_path);
    if (!article) {
      return;
    }
    showArticle(created.relative_path);
    renderTreePane();

    const lock = await requestKnowledgeBaseLock(knowledgeBase.rootPath, article.id);
    if (lock.acquired) {
      enterEditMode(article);
      document.getElementById("kb-edit-title").select();
    }
  } catch (error) {
    showToast(`Не удалось создать статью: ${describeError(error)}`);
  } finally {
    setBusy(false);
  }
}

// ── Конфликт правок ──────────────────────────────────────────────────────────

/**
 * Показывает окно выбора, когда статью успел изменить другой пользователь.
 *
 * Принимает ответ бэкенда с чужой версией. Свой текст остаётся в редакторе
 * нетронутым: пока пользователь не выбрал, ничего не пропадает.
 */
function showConflict(result) {
  document.getElementById("kb-conflict-their-body").innerHTML =
    renderMarkdown(result.their_body);
  showOverlay("kb-conflict-overlay");
}

/**
 * Открывает чужую версию, отказавшись от своих правок.
 */
async function handleConflictReload() {
  hideOverlay("kb-conflict-overlay");
  await requestKnowledgeBaseUnlock(knowledgeBase.rootPath, editState.articleId);
  editState.isEditing = false;
  toggleEditChrome(false);
  await reloadKnowledgeBase(false);
  showArticle(editState.relativePath);
  showToast("Открыта версия коллеги");
}

/**
 * Сохраняет свой текст отдельной статьёй рядом.
 *
 * Чужая версия остаётся на месте, своя не пропадает — дальше их сравнивают
 * и сводят вручную. Автоматическое слияние здесь было бы опаснее: в
 * юридическом тексте важна каждая формулировка.
 */
async function handleConflictSaveCopy() {
  setBusy(true);
  try {
    const title =
      document.getElementById("kb-edit-title").value.trim() || "Без названия";
    const folder = editState.relativePath.split("/").slice(0, -1).join("/");

    const created = await requestKnowledgeBaseCreate({
      root_path: knowledgeBase.rootPath,
      folder_relative_path: folder,
      title: `${title} (моя версия)`,
      body: document.getElementById("kb-editor").value,
    });

    hideOverlay("kb-conflict-overlay");
    await requestKnowledgeBaseUnlock(knowledgeBase.rootPath, editState.articleId);
    editState.isEditing = false;
    toggleEditChrome(false);
    await reloadKnowledgeBase(false);
    showArticle(created.relative_path);
    showToast("Ваша версия сохранена отдельной статьёй");
  } catch (error) {
    showToast(`Не удалось сохранить копию: ${describeError(error)}`);
  } finally {
    setBusy(false);
  }
}

// ── Предыдущие версии ────────────────────────────────────────────────────────

/**
 * Показывает список снимков предыдущих версий открытой статьи.
 */
async function handleVersionsClick() {
  const article = knowledgeBase.articlesByPath.get(selectedRelativePath);
  if (!article) {
    return;
  }

  setBusy(true);
  try {
    const versions = await requestKnowledgeBaseVersions(
      knowledgeBase.rootPath, article.id,
    );
    renderVersionsList(article, versions);
    showOverlay("kb-versions-overlay");
  } catch (error) {
    showToast(`Не удалось получить версии: ${describeError(error)}`);
  } finally {
    setBusy(false);
  }
}

/**
 * Заполняет список версий кнопками просмотра и восстановления.
 *
 * Принимает карточку статьи и список снимков. У статьи, которую сохраняли
 * один раз, снимков нет — об этом говорится прямо, а не пустым списком.
 */
function renderVersionsList(article, versions) {
  const list = document.getElementById("kb-versions-list");
  const preview = document.getElementById("kb-version-preview");
  list.innerHTML = "";
  preview.classList.add("hidden");

  if (!versions.length) {
    const empty = document.createElement("p");
    empty.className = "kb-empty-hint";
    empty.textContent =
      "Предыдущих версий пока нет: статью сохраняли только один раз.";
    list.appendChild(empty);
    return;
  }

  versions.forEach((version) => {
    const row = document.createElement("div");
    row.className = "kb-version-row";

    const when = document.createElement("span");
    when.className = "kb-version-when";
    when.textContent = formatDateTime(version.saved_at);
    row.appendChild(when);

    const showButton = document.createElement("button");
    showButton.type = "button";
    showButton.className = "kb-version-action";
    showButton.textContent = "Посмотреть";
    showButton.addEventListener("click", () => showVersion(article, version));
    row.appendChild(showButton);

    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.className = "kb-version-action";
    restoreButton.textContent = "Восстановить";
    restoreButton.addEventListener("click", () => restoreVersion(article, version));
    row.appendChild(restoreButton);

    list.appendChild(row);
  });
}

/**
 * Показывает содержимое выбранного снимка версии.
 */
async function showVersion(article, version) {
  try {
    const snapshot = await requestKnowledgeBaseVersion(
      knowledgeBase.rootPath, article.id, version.name,
    );
    const preview = document.getElementById("kb-version-preview");
    preview.innerHTML = renderMarkdown(snapshot.body);
    preview.classList.remove("hidden");
  } catch (error) {
    showToast(`Не удалось прочитать версию: ${describeError(error)}`);
  }
}

/**
 * Восстанавливает статью из выбранного снимка.
 *
 * Текущее содержимое при этом само попадает в снимки, поэтому откат
 * обратим — об этом сказано и в подтверждении.
 */
async function restoreVersion(article, version) {
  const when = formatDateTime(version.saved_at);
  if (!window.confirm(
    `Восстановить версию от ${when}?\n\n` +
    "Текущий текст не пропадёт: он попадёт в список версий, " +
    "и откат можно будет отменить.",
  )) {
    return;
  }

  setBusy(true);
  try {
    const result = await requestKnowledgeBaseVersionRestore({
      root_path: knowledgeBase.rootPath,
      relative_path: article.relative_path,
      version_name: version.name,
      expected_fingerprint: article.fingerprint,
    });

    if (result.conflict) {
      showToast("Статью изменил другой пользователь — обновите базу и повторите");
      return;
    }
    hideOverlay("kb-versions-overlay");
    await reloadKnowledgeBase(false);
    showArticle(article.relative_path);
    showToast(`Восстановлена версия от ${when}`);
  } catch (error) {
    showToast(`Не удалось восстановить: ${describeError(error)}`);
  } finally {
    setBusy(false);
  }
}

// ── Мелкие помощники интерфейса ──────────────────────────────────────────────

/**
 * Показывает модальное окно вкладки.
 */
function showOverlay(overlayId) {
  document.getElementById(overlayId).classList.remove("hidden");
}

/**
 * Прячет модальное окно вкладки.
 */
function hideOverlay(overlayId) {
  document.getElementById(overlayId).classList.add("hidden");
}

/**
 * Помечает вкладку занятой на время обращения к бэкенду.
 *
 * Каждый вызов бэкенда — это запуск процесса на несколько секунд, поэтому
 * без явной отметки пользователь успевает нажать кнопку второй раз.
 */
function setBusy(isBusy) {
  ["kb-edit-button", "kb-save-button", "kb-cancel-button",
   "kb-new-article-button", "kb-versions-button", "kb-refresh-button"]
    .forEach((buttonId) => {
      const button = document.getElementById(buttonId);
      if (button) {
        button.disabled = isBusy;
      }
    });
  document.body.style.cursor = isBusy ? "progress" : "";
}
