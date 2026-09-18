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
  requestKnowledgeBaseAttach,
  requestKnowledgeBaseCreate,
  requestKnowledgeBaseDocumentCheck,
  requestKnowledgeBaseDelete,
  requestKnowledgeBaseFolderCreate,
  requestKnowledgeBaseFolderDelete,
  requestKnowledgeBaseFolderRename,
  requestKnowledgeBaseLock,
  requestKnowledgeBaseMove,
  requestKnowledgeBaseSave,
  requestKnowledgeBaseTrash,
  requestKnowledgeBaseTrashPurge,
  requestKnowledgeBaseTrashRestore,
  requestKnowledgeBaseUnlock,
  requestKnowledgeBaseVersion,
  requestKnowledgeBaseVersionRestore,
  requestKnowledgeBaseVersions,
} from "./backend-api.js";
import { askChoice, askConfirm, askText } from "./kb-dialog.js";
import { selectDirectory, selectDocumentFile } from "./file-dialogs.js";
import { loadKnowledgeBaseRoot, saveKnowledgeBaseRoot } from "./kb-settings-store.js";
import {
  extractArticleLinks,
  extractHeadings,
  renderMarkdown,
} from "./kb-markdown.js";
import { createVisualEditor } from "./kb-wysiwyg.js";
import {
  expandToWord,
  findMatches,
  normalizeForSearch,
  searchArticles,
  searchStem,
} from "./kb-search.js";
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
  articlesById: new Map(),
  backlinks: new Map(),
  documents: new Map(),
  tree: null,
  isLoaded: false,
};

let selectedRelativePath = "";
// Выбранный раздел — место, куда попадёт новая статья. Пустая строка
// означает корень базы.
let selectedFolderPath = "";
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
  document.getElementById("kb-delete-button")
    .addEventListener("click", handleDeleteClick);
  document.getElementById("kb-trash-button")
    .addEventListener("click", handleTrashClick);
  document.getElementById("kb-trash-close")
    .addEventListener("click", () => hideOverlay("kb-trash-overlay"));
  document.getElementById("kb-move-button")
    .addEventListener("click", handleMoveClick);
  document.getElementById("kb-new-folder-button")
    .addEventListener("click", handleNewFolderClick);
  document.getElementById("kb-rename-folder-button")
    .addEventListener("click", handleRenameFolderClick);
  document.getElementById("kb-delete-folder-button")
    .addEventListener("click", handleDeleteFolderClick);

  document.getElementById("kb-conflict-back")
    .addEventListener("click", () => hideOverlay("kb-conflict-overlay"));
  document.getElementById("kb-conflict-reload")
    .addEventListener("click", handleConflictReload);
  document.getElementById("kb-conflict-copy")
    .addEventListener("click", handleConflictSaveCopy);

  const editor = document.getElementById("kb-editor");
  editor.addEventListener("input", updatePreview);

  document.getElementById("kb-mode-visual")
    .addEventListener("click", () => applyEditorMode("visual"));
  document.getElementById("kb-mode-source")
    .addEventListener("click", () => applyEditorMode("source"));

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
    knowledgeBase.documents = new Map(
      (loaded.documents || []).map((item) => [item.target, item]),
    );
    knowledgeBase.isLoaded = true;
    rebuildLinkIndex();

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
  const query = currentSearchQuery();
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
  const results = searchArticles(knowledgeBase.articles, query);
  const list = document.createElement("div");
  list.className = "kb-search-results";

  if (!results.length) {
    const empty = document.createElement("p");
    empty.className = "kb-empty-hint";
    empty.textContent = "Ничего не найдено.";
    list.appendChild(empty);
    return list;
  }

  const totalMatches = results.reduce((sum, item) => sum + item.matchCount, 0);
  const counter = document.createElement("p");
  counter.className = "kb-search-counter";
  counter.textContent =
    `Статей: ${results.length} · совпадений: ${totalMatches}`;
  list.appendChild(counter);

  results.forEach((result) => list.appendChild(buildSearchResultItem(result)));
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

  const row = document.createElement("div");
  row.className = "kb-folder-row";

  // Стрелка и имя — разные кнопки: сворачивание и выбор раздела не должны
  // срабатывать одним кликом, иначе выбрать раздел, не схлопнув его, нельзя.
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "kb-chevron-button";
  toggle.dataset.kbFolderToggle = folderNode.relative_path;
  toggle.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
  toggle.setAttribute("aria-label", isCollapsed ? "Раскрыть раздел" : "Свернуть раздел");
  toggle.textContent = isCollapsed ? "▸" : "▾";
  row.appendChild(toggle);

  const name = document.createElement("button");
  name.type = "button";
  name.className = "kb-folder-toggle";
  name.dataset.kbFolder = folderNode.relative_path;
  name.classList.toggle("kb-folder-active",
    folderNode.relative_path === selectedFolderPath);
  name.textContent = folderNode.name;
  row.appendChild(name);

  wrapper.appendChild(row);

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
  const chevron = event.target.closest("[data-kb-folder-toggle]");
  if (chevron) {
    const folderPath = chevron.dataset.kbFolderToggle;
    if (collapsedFolders.has(folderPath)) {
      collapsedFolders.delete(folderPath);
    } else {
      collapsedFolders.add(folderPath);
    }
    renderTreePane();
    return;
  }

  const folderName = event.target.closest("[data-kb-folder]");
  if (folderName) {
    const folderPath = folderName.dataset.kbFolder;
    // Повторный клик снимает выбор — иначе от выбранного раздела было бы
    // не отвязаться, и новая статья всё время падала бы внутрь него.
    selectFolder(folderPath === selectedFolderPath ? "" : folderPath);
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
  document.getElementById("kb-article-body").innerHTML =
    renderMarkdown(article.body, knowledgeBase.articlesById, knowledgeBase.documents);

  renderArticleProperties(article);
  renderTableOfContents(article.body);
  renderBacklinks(article);
  highlightSearchInArticle(searchStem(currentSearchQuery()));
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
  const documentLink = event.target.closest("[data-kb-document]");
  if (documentLink) {
    event.preventDefault();
    await openDocument(documentLink.dataset.kbDocument);
    return;
  }

  const articleLink = event.target.closest("[data-kb-article-link]");
  if (articleLink) {
    event.preventDefault();
    openArticleById(articleLink.dataset.kbArticleLink);
    return;
  }

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

  const articleLinkButton = document.createElement("button");
  articleLinkButton.type = "button";
  articleLinkButton.className = "kb-format-button";
  articleLinkButton.textContent = "🔗";
  articleLinkButton.title = "Ссылка на сайт или статью базы знаний";
  articleLinkButton.addEventListener("click", handleInsertLink);
  toolbar.appendChild(articleLinkButton);

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
  document.getElementById("kb-preview").innerHTML = renderMarkdown(
    document.getElementById("kb-editor").value,
    knowledgeBase.articlesById, knowledgeBase.documents,
  );
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
      const takeOver = await askConfirm({
        title: "Статья занята, но замок выглядит брошенным",
        text: `Её держит ${lock.holder.user} (${lock.holder.computer}) с ${since}. `
          + "Приложение у него, судя по всему, закрылось аварийно. "
          + "Перехватить редактирование?",
        confirmLabel: "Перехватить",
      });
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
  updatePreview();
  applyEditorMode(loadEditorMode(), false);
  if (editorMode === "visual") {
    ensureVisualEditor(article.body);
  }
  document.getElementById("kb-edit-title").value = article.properties.title || "";
  document.getElementById("kb-edit-status").value =
    article.properties.status || "черновик";
  document.getElementById("kb-edit-icon").value = article.properties.icon || "";

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
  shown("kb-delete-button", !isEditing);
  shown("kb-move-button", !isEditing);
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
      body: getEditorContent(),
      expected_fingerprint: editState.fingerprint,
    });

    if (result.conflict) {
      showConflict(result);
      return;
    }

    await requestKnowledgeBaseUnlock(knowledgeBase.rootPath, editState.articleId);
    editState.isEditing = false;
    disposeVisualEditor();
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
  const article = knowledgeBase.articlesByPath.get(editState.relativePath);
  const hasChanges = article && getEditorContent().trim() !== (article.body || "").trim();

  if (hasChanges && !await askConfirm({
    title: "Отменить правки?",
    text: "Несохранённый текст будет потерян.",
    confirmLabel: "Отменить правки",
    danger: true,
  })) {
    return;
  }

  await requestKnowledgeBaseUnlock(knowledgeBase.rootPath, editState.articleId);
  editState.isEditing = false;
  disposeVisualEditor();
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
      folder_relative_path: selectedFolderPath,
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
    renderMarkdown(result.their_body, knowledgeBase.articlesById, knowledgeBase.documents);
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
      body: getEditorContent(),
    });

    hideOverlay("kb-conflict-overlay");
    await requestKnowledgeBaseUnlock(knowledgeBase.rootPath, editState.articleId);
    editState.isEditing = false;
    disposeVisualEditor();
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
    preview.innerHTML = renderMarkdown(snapshot.body, knowledgeBase.articlesById, knowledgeBase.documents);
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
  if (!await askConfirm({
    title: `Восстановить версию от ${when}?`,
    text: "Текущий текст не пропадёт: он попадёт в список версий, "
      + "и откат можно будет отменить.",
    confirmLabel: "Восстановить",
  })) {
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
   "kb-new-article-button", "kb-versions-button", "kb-refresh-button",
   "kb-delete-button", "kb-trash-button", "kb-move-button",
   "kb-new-folder-button", "kb-rename-folder-button", "kb-delete-folder-button"]
    .forEach((buttonId) => {
      const button = document.getElementById(buttonId);
      if (button) {
        button.disabled = isBusy;
      }
    });
  document.body.style.cursor = isBusy ? "progress" : "";
}

// ── Удаление и корзина ───────────────────────────────────────────────────────

/**
 * Удаляет открытую статью в корзину.
 *
 * Спрашивает подтверждение и сразу говорит, что удаление обратимо: на общем
 * диске человек должен понимать, безвозвратно ли действие, до того как
 * нажмёт кнопку, а не после.
 */
async function handleDeleteClick() {
  const article = knowledgeBase.articlesByPath.get(selectedRelativePath);
  if (!article) {
    return;
  }
  if (!await askConfirm({
    title: `Удалить статью «${article.title}»?`,
    text: "Она попадёт в корзину, откуда её можно вернуть на прежнее место.",
    confirmLabel: "Удалить",
    danger: true,
  })) {
    return;
  }

  setBusy(true);
  try {
    await requestKnowledgeBaseDelete(knowledgeBase.rootPath, selectedRelativePath);
    selectedRelativePath = "";
    await reloadKnowledgeBase(false);
    showToast(`Статья «${article.title}» перенесена в корзину`);
  } catch (error) {
    showToast(`Не удалось удалить: ${describeError(error)}`);
  } finally {
    setBusy(false);
  }
}

/**
 * Показывает содержимое корзины.
 */
async function handleTrashClick() {
  setBusy(true);
  try {
    const entries = await requestKnowledgeBaseTrash(knowledgeBase.rootPath);
    renderTrashList(entries);
    showOverlay("kb-trash-overlay");
  } catch (error) {
    showToast(`Не удалось открыть корзину: ${describeError(error)}`);
  } finally {
    setBusy(false);
  }
}

/**
 * Заполняет список корзины кнопками восстановления и окончательного удаления.
 *
 * Принимает записи корзины. У каждой видно исходный путь — по одному
 * заголовку не всегда понятно, какая из похожих статей удалена.
 */
function renderTrashList(entries) {
  const list = document.getElementById("kb-trash-list");
  list.innerHTML = "";

  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "kb-empty-hint";
    empty.textContent = "Корзина пуста.";
    list.appendChild(empty);
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "kb-version-row";

    const labels = document.createElement("span");
    labels.className = "kb-article-labels";

    const title = document.createElement("span");
    title.className = "kb-article-title";
    title.textContent = entry.title;
    labels.appendChild(title);

    const where = document.createElement("span");
    where.className = "kb-article-path";
    where.textContent =
      `${entry.original_relative_path} · удалена ${formatDateTime(entry.deleted_at)}`;
    labels.appendChild(where);
    row.appendChild(labels);

    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.className = "kb-version-action";
    restoreButton.textContent = "Восстановить";
    restoreButton.addEventListener("click", () => restoreFromTrash(entry));
    row.appendChild(restoreButton);

    const purgeButton = document.createElement("button");
    purgeButton.type = "button";
    purgeButton.className = "kb-version-action";
    purgeButton.textContent = "Удалить навсегда";
    purgeButton.addEventListener("click", () => purgeFromTrash(entry));
    row.appendChild(purgeButton);

    list.appendChild(row);
  });
}

/**
 * Возвращает статью из корзины на исходное место.
 *
 * Если на прежнем пути успела появиться другая статья, восстановленная
 * кладётся рядом под именем с пометкой — об этом пользователю сообщается,
 * а не умалчивается.
 */
async function restoreFromTrash(entry) {
  setBusy(true);
  try {
    const result = await requestKnowledgeBaseTrashRestore(
      knowledgeBase.rootPath, entry.entry_id,
    );
    hideOverlay("kb-trash-overlay");
    await reloadKnowledgeBase(false);
    showArticle(result.restored_relative_path);
    renderTreePane();

    showToast(result.renamed
      ? "На прежнем месте уже есть статья — восстановленная положена рядом"
      : `Статья «${entry.title}» восстановлена`);
  } catch (error) {
    showToast(`Не удалось восстановить: ${describeError(error)}`);
  } finally {
    setBusy(false);
  }
}

/**
 * Удаляет запись корзины окончательно.
 *
 * Единственное необратимое действие во вкладке, поэтому подтверждение
 * говорит об этом прямо.
 */
async function purgeFromTrash(entry) {
  if (!await askConfirm({
    title: `Удалить «${entry.title}» окончательно?`,
    text: "Это единственное необратимое действие: вернуть статью будет нельзя.",
    confirmLabel: "Удалить навсегда",
    danger: true,
  })) {
    return;
  }

  setBusy(true);
  try {
    await requestKnowledgeBaseTrashPurge(knowledgeBase.rootPath, entry.entry_id);
    const entries = await requestKnowledgeBaseTrash(knowledgeBase.rootPath);
    renderTrashList(entries);
    showToast("Статья удалена окончательно");
  } catch (error) {
    showToast(`Не удалось удалить: ${describeError(error)}`);
  } finally {
    setBusy(false);
  }
}

// ── Разделы: выбор, создание, переименование, удаление ───────────────────────

/**
 * Отмечает раздел выбранным и показывает действия над ним.
 *
 * Принимает относительный путь раздела. Выбранный раздел — это то место,
 * куда попадёт новая статья: без него «Создать» всегда клало бы статью в
 * корень базы, а разложить её потом было бы нечем.
 */
function selectFolder(relativePath) {
  selectedFolderPath = relativePath;
  renderFolderActions();
  renderTreePane();
}

/**
 * Показывает или прячет панель действий над выбранным разделом.
 */
function renderFolderActions() {
  const panel = document.getElementById("kb-folder-actions");
  const label = document.getElementById("kb-selected-folder");

  if (!selectedFolderPath) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  label.textContent = selectedFolderPath;
}

/**
 * Собирает плоский список всех разделов базы для выбора в диалоге.
 *
 * Принимает узел дерева. Возвращает записи с относительным путём и подписью,
 * включая корень базы: перенести статью в корень — обычное действие.
 */
function collectFolders(folderNode, collected = []) {
  if (!folderNode) {
    return collected;
  }
  if (!collected.length) {
    collected.push({ value: "", label: "Корень базы знаний" });
  }
  folderNode.folders.forEach((child) => {
    collected.push({ value: child.relative_path, label: child.relative_path });
    collectFolders(child, collected);
  });
  return collected;
}

/**
 * Создаёт подраздел внутри выбранного раздела.
 */
async function handleNewFolderClick() {
  const name = await askText({
    title: "Новый раздел",
    text: `Будет создан внутри «${selectedFolderPath || "корня базы"}».`,
    confirmLabel: "Создать",
  });
  if (!name) {
    return;
  }

  setBusy(true);
  try {
    const result = await requestKnowledgeBaseFolderCreate(
      knowledgeBase.rootPath, selectedFolderPath, name,
    );
    if (!result.created) {
      showToast(`Раздел «${name}» уже существует`);
      return;
    }
    await reloadKnowledgeBase(false);
    selectFolder(result.relative_path);
    showToast(`Раздел «${name}» создан`);
  } catch (error) {
    showToast(`Не удалось создать раздел: ${describeError(error)}`);
  } finally {
    setBusy(false);
  }
}

/**
 * Переименовывает выбранный раздел.
 *
 * Статьи внутри не затрагиваются: ссылки на них держатся на постоянных
 * идентификаторах, а не на пути.
 */
async function handleRenameFolderClick() {
  if (!selectedFolderPath) {
    return;
  }
  const currentName = selectedFolderPath.split("/").pop();
  const newName = await askText({
    title: "Переименовать раздел",
    text: "Статьи внутри раздела и ссылки на них не пострадают.",
    initialValue: currentName,
    confirmLabel: "Переименовать",
  });
  if (!newName || newName === currentName) {
    return;
  }

  setBusy(true);
  try {
    const result = await requestKnowledgeBaseFolderRename(
      knowledgeBase.rootPath, selectedFolderPath, newName,
    );
    await reloadKnowledgeBase(false);
    selectFolder(result.relative_path);
    showToast("Раздел переименован");
  } catch (error) {
    showToast(`Не удалось переименовать: ${describeError(error)}`);
  } finally {
    setBusy(false);
  }
}

/**
 * Удаляет выбранный раздел, если он пуст.
 *
 * Раздел со статьями не удаляется: удаление одним кликом унесло бы чужую
 * работу, а восстанавливать пришлось бы по одной статье. Вместо отказа без
 * объяснений интерфейс говорит, сколько статей мешает.
 */
async function handleDeleteFolderClick() {
  if (!selectedFolderPath) {
    return;
  }
  const confirmed = await askConfirm({
    title: `Удалить раздел «${selectedFolderPath}»?`,
    text: "Удаляются только пустые разделы. Если внутри есть статьи, "
      + "сначала перенесите или удалите их.",
    confirmLabel: "Удалить",
    danger: true,
  });
  if (!confirmed) {
    return;
  }

  setBusy(true);
  try {
    const result = await requestKnowledgeBaseFolderDelete(
      knowledgeBase.rootPath, selectedFolderPath,
    );
    if (!result.deleted) {
      showToast(
        `В разделе ещё ${result.article_count} ст. — сначала разберитесь с ними`,
      );
      return;
    }
    selectedFolderPath = "";
    renderFolderActions();
    await reloadKnowledgeBase(false);
    showToast("Раздел удалён");
  } catch (error) {
    showToast(`Не удалось удалить раздел: ${describeError(error)}`);
  } finally {
    setBusy(false);
  }
}

/**
 * Переносит открытую статью в другой раздел.
 *
 * Раздел выбирается из списка, а не вводится путём: печатать путь руками —
 * верный способ ошибиться. Содержимое статьи при переносе не меняется.
 */
async function handleMoveClick() {
  const article = knowledgeBase.articlesByPath.get(selectedRelativePath);
  if (!article) {
    return;
  }

  const folders = collectFolders(knowledgeBase.tree);
  const targetPath = await askChoice(
    `Перенести «${article.title}» в раздел:`, folders,
  );
  if (targetPath === null) {
    return;
  }

  setBusy(true);
  try {
    const moved = await requestKnowledgeBaseMove(
      knowledgeBase.rootPath, selectedRelativePath, targetPath,
    );
    selectedRelativePath = moved.relative_path;
    await reloadKnowledgeBase(false);
    showArticle(moved.relative_path);
    renderTreePane();
    showToast(`Статья перенесена в «${targetPath || "корень базы"}»`);
  } catch (error) {
    showToast(`Не удалось перенести: ${describeError(error)}`);
  } finally {
    setBusy(false);
  }
}

// ── Два способа правки ───────────────────────────────────────────────────────
// Оба пишут в файл один и тот же Markdown; различается только то, что видит
// человек. Выбор запоминается — переключать его при каждой правке не нужно.

const EDITOR_MODE_STORAGE_KEY = "kb-editor-mode";

let visualEditor = null;
let editorMode = "visual";
let themeObserver = null;

/**
 * Читает запомненный способ правки.
 *
 * Хранилище может быть недоступно (приватный режим, запрет на запись) —
 * тогда просто берём режим по умолчанию.
 */
function loadEditorMode() {
  try {
    const stored = localStorage.getItem(EDITOR_MODE_STORAGE_KEY);
    return stored === "source" ? "source" : "visual";
  } catch {
    return "visual";
  }
}

/**
 * Запоминает выбранный способ правки.
 */
function storeEditorMode(mode) {
  try {
    localStorage.setItem(EDITOR_MODE_STORAGE_KEY, mode);
  } catch {
    // Не сохранилось — на текущий сеанс режим всё равно применён.
  }
}

/**
 * Отвечает, включена ли сейчас тёмная тема приложения.
 *
 * Редактор оформляется отдельным классом, а тему приложение переключает
 * классом на корневом элементе (см. theme.js).
 */
function isDarkTheme() {
  return document.documentElement.classList.contains("dark");
}

/**
 * Возвращает текущий текст статьи из того редактора, который сейчас открыт.
 */
function getEditorContent() {
  if (editorMode === "visual" && visualEditor) {
    return visualEditor.getMarkdown();
  }
  return document.getElementById("kb-editor").value;
}

/**
 * Кладёт текст статьи в оба редактора.
 *
 * Держать их синхронными проще, чем помнить, какой из них «главный»:
 * переключение режима тогда не требует переноса текста.
 */
function setEditorContent(markdown) {
  document.getElementById("kb-editor").value = markdown;
  updatePreview();
  if (visualEditor) {
    visualEditor.setMarkdown(markdown);
  }
}

/**
 * Включает выбранный способ правки.
 *
 * Принимает режим и признак того, что текст нужно перенести из прежнего
 * редактора. Редактор «как в документе» создаётся лениво — при первом
 * обращении: он весит полмегабайта, и тем, кто правит разметкой, он не нужен.
 */
function applyEditorMode(mode, carryContentOver = true) {
  const markdown = carryContentOver ? getEditorContent() : null;
  editorMode = mode;
  storeEditorMode(mode);

  document.getElementById("kb-source-mode").classList.toggle("hidden", mode !== "source");
  document.getElementById("kb-visual-mode").classList.toggle("hidden", mode !== "visual");
  document.getElementById("kb-mode-visual")
    .classList.toggle("kb-mode-active", mode === "visual");
  document.getElementById("kb-mode-source")
    .classList.toggle("kb-mode-active", mode === "source");

  if (mode === "visual") {
    ensureVisualEditor(markdown);
  } else if (markdown !== null) {
    document.getElementById("kb-editor").value = markdown;
    updatePreview();
  }
}

/**
 * Создаёт редактор «как в документе», если он ещё не создан.
 *
 * Принимает текст, с которым его открыть. Ошибка загрузки библиотеки не
 * оставляет пользователя без редактора вовсе — вкладка возвращается к
 * правке разметкой и объясняет, что произошло.
 */
function ensureVisualEditor(markdown) {
  const container = document.getElementById("kb-visual-editor");
  const startingText = markdown !== null && markdown !== undefined
    ? markdown
    : document.getElementById("kb-editor").value;

  if (visualEditor) {
    visualEditor.setMarkdown(startingText);
    visualEditor.setDark(isDarkTheme());
    return;
  }

  try {
    visualEditor = createVisualEditor({
      container: container,
      markdown: startingText,
      isDark: isDarkTheme(),
      onChange: syncSourceFromVisual,
      onInsertLink: handleInsertLink,
    });
    watchThemeForEditor();
  } catch (error) {
    showToast(`Редактор не загрузился: ${describeError(error)}`);
    applyEditorMode("source", false);
  }
}

/**
 * Следит за сменой темы приложения, пока открыт визуальный редактор.
 *
 * Тема переключается классом на корневом элементе страницы (см. theme.js),
 * события об этом приложение не рассылает. Наблюдатель проще: он не требует
 * менять общий код темы ради одной вкладки. Без него редактор, открытый до
 * переключения, оставался бы в прежнем оформлении.
 */
function watchThemeForEditor() {
  if (themeObserver) {
    return;
  }
  themeObserver = new MutationObserver(() => {
    if (visualEditor) {
      visualEditor.setDark(isDarkTheme());
    }
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

/**
 * Прекращает следить за темой, когда визуальный редактор закрыт.
 */
function unwatchThemeForEditor() {
  if (themeObserver) {
    themeObserver.disconnect();
    themeObserver = null;
  }
}

/**
 * Переносит правки из редактора «как в документе» в поле разметки.
 *
 * Нужно, чтобы отмена правок сравнивала текст с исходным одинаково в обоих
 * режимах, и чтобы переключение туда-обратно ничего не теряло.
 */
function syncSourceFromVisual() {
  if (visualEditor) {
    document.getElementById("kb-editor").value = visualEditor.getMarkdown();
  }
}

/**
 * Закрывает редактор «как в документе» при выходе из правки.
 */
function disposeVisualEditor() {
  unwatchThemeForEditor();
  if (visualEditor) {
    visualEditor.destroy();
    visualEditor = null;
  }
}

// ── Ссылки между статьями ────────────────────────────────────────────────────
// Ссылка хранит постоянный идентификатор статьи, а не имя файла и не
// заголовок: статью переименовывают и переносят, ссылка должна пережить это.
// Заголовок подставляется при отображении — из справочника, собранного при
// загрузке базы.

/**
 * Собирает справочник статей по идентификаторам и указатель обратных ссылок.
 *
 * Обе таблицы строятся из той же памяти, что и дерево, без обращения к
 * бэкенду: вся база уже прочитана, и отдельный поисковый индекс ради этого
 * не нужен.
 */
function rebuildLinkIndex() {
  knowledgeBase.articlesById = new Map();
  knowledgeBase.backlinks = new Map();

  knowledgeBase.articles.forEach((article) => {
    if (article.id) {
      knowledgeBase.articlesById.set(article.id.toLowerCase(), article);
    }
  });

  knowledgeBase.articles.forEach((article) => {
    extractArticleLinks(article.body).forEach((targetId) => {
      if (!knowledgeBase.backlinks.has(targetId)) {
        knowledgeBase.backlinks.set(targetId, []);
      }
      knowledgeBase.backlinks.get(targetId).push(article);
    });
  });
}

/**
 * Заполняет блок «Ссылки на эту статью».
 *
 * Принимает карточку статьи. Блок показывается только когда ссылки есть —
 * пустой заголовок внизу каждой статьи лишь занимал бы место.
 */
function renderBacklinks(article) {
  const container = document.getElementById("kb-backlinks");
  container.innerHTML = "";

  const sources = knowledgeBase.backlinks.get((article.id || "").toLowerCase()) || [];
  if (!sources.length) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");

  const caption = document.createElement("p");
  caption.className = "kb-backlinks-caption";
  caption.textContent = `Ссылки на эту статью: ${sources.length}`;
  container.appendChild(caption);

  sources.forEach((source) => {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "kb-backlink";
    link.textContent = `${source.icon || "📄"} ${source.title}`;
    link.addEventListener("click", () => openArticleById(source.id));
    container.appendChild(link);
  });
}

/**
 * Открывает статью по её идентификатору.
 *
 * Принимает идентификатор. Если статья не найдена (удалена, а ссылка
 * осталась), сообщает об этом вместо молчаливого бездействия.
 */
function openArticleById(articleId) {
  if (editState.isEditing) {
    showToast("Сначала сохраните или отмените правки открытой статьи");
    return;
  }
  const article = knowledgeBase.articlesById.get((articleId || "").toLowerCase());
  if (!article) {
    showToast("Статья не найдена — возможно, её удалили");
    return;
  }
  showArticle(article.relative_path);
  renderTreePane();
}

/**
 * Вставляет ссылку, сохраняя выделенный пользователем текст.
 *
 * Порядок как у обычных редакторов: выделил текст — нажал «Ссылка» — выбрал,
 * куда она ведёт. Сам текст не подменяется, он лишь становится ссылкой.
 * Если ничего не выделено, подписью становится заголовок статьи либо адрес.
 */
async function handleInsertLink() {
  // Выделение читается до диалогов: пока человек выбирает, оно сбрасывается.
  const selection = readEditorSelection();

  const kind = await askChoice("Куда ведёт ссылка?", [
    { value: "article", label: "На статью базы знаний",
      hint: "Переживёт переименование и перенос статьи" },
    { value: "url", label: "На сайт",
      hint: "Откроется во внешнем браузере" },
    { value: "attachment", label: "Вложить документ в статью",
      hint: "Файл скопируется в базу и будет доступен всем" },
    { value: "external-file", label: "На файл в сетевой папке",
      hint: "Файл останется там, где лежит" },
  ]);
  if (!kind) {
    return;
  }

  const chooseByKind = {
    article: chooseArticleLink,
    url: chooseExternalLink,
    attachment: chooseAttachment,
    "external-file": chooseExternalDocument,
  };
  const link = await chooseByKind[kind](selection.text);
  if (!link) {
    return;
  }
  insertLinkIntoEditor(selection, link.url, link.label);
}

/**
 * Читает выделение в том редакторе, который сейчас открыт.
 *
 * Для поля разметки запоминаются и границы выделения: после диалога фокус
 * уходит, и вставлять придётся по сохранённым позициям.
 */
function readEditorSelection() {
  if (editorMode === "visual" && visualEditor) {
    return { text: visualEditor.getSelectedText().trim() };
  }
  const editor = document.getElementById("kb-editor");
  return {
    text: editor.value.slice(editor.selectionStart, editor.selectionEnd).trim(),
    start: editor.selectionStart,
    end: editor.selectionEnd,
  };
}

/**
 * Предлагает выбрать статью базы и возвращает адрес и подпись ссылки.
 *
 * Принимает выделенный текст. Подписью остаётся он, а если ничего не
 * выделено — заголовок выбранной статьи.
 */
async function chooseArticleLink(selectedText) {
  const items = knowledgeBase.articles
    .filter((article) => article.id && article.relative_path !== editState.relativePath)
    .map((article) => ({
      value: article.id,
      label: article.title,
      hint: article.relative_path,
    }));

  if (!items.length) {
    showToast("В базе пока нет других статей, на которые можно сослаться");
    return null;
  }

  const chosenId = await askChoice("Ссылка на статью", items);
  if (!chosenId) {
    return null;
  }
  const target = knowledgeBase.articlesById.get(chosenId.toLowerCase());
  return { url: chosenId, label: selectedText || target.title };
}

/**
 * Спрашивает адрес сайта и возвращает адрес и подпись ссылки.
 *
 * Принимает выделенный текст. Адреса не http и не https отклоняются: такие
 * ссылки при показе статьи остаются обычным текстом, и человек решил бы,
 * что ссылка просто не сработала.
 */
async function chooseExternalLink(selectedText) {
  const url = await askText({
    title: "Ссылка на сайт",
    text: "Откроется во внешнем браузере.",
    initialValue: "https://",
    confirmLabel: "Вставить",
  });
  if (!url) {
    return null;
  }
  if (!/^https?:\/\/.+/i.test(url)) {
    showToast("Адрес должен начинаться с http:// или https://");
    return null;
  }
  return { url: url, label: selectedText || url };
}

/**
 * Вставляет ссылку в активный редактор.
 *
 * Принимает сохранённое выделение, адрес и подпись. В поле разметки вставка
 * идёт по запомненным границам: фокус после диалога уже не там.
 */
function insertLinkIntoEditor(selection, url, label) {
  if (editorMode === "visual" && visualEditor) {
    visualEditor.insertLink(url, label);
    syncSourceFromVisual();
    return;
  }

  const editor = document.getElementById("kb-editor");
  const markup = `[${label}](${url})`;
  editor.setRangeText(markup, selection.start, selection.end, "end");
  editor.focus();
  updatePreview();
}

// ── Документы ────────────────────────────────────────────────────────────────

/**
 * Вкладывает документ в статью и возвращает данные ссылки.
 *
 * Принимает выделенный текст. Файл копируется в служебную папку рядом с
 * базой: там он доступен всем пользователям и не зависит от того, что лежит
 * на диске конкретного человека.
 */
async function chooseAttachment(selectedText) {
  if (!editState.articleId) {
    showToast("Сначала сохраните статью — вложению нужен её идентификатор");
    return null;
  }

  const sourcePath = await selectDocumentFile();
  if (!sourcePath) {
    return null;
  }

  setBusy(true);
  try {
    const attached = await requestKnowledgeBaseAttach(
      knowledgeBase.rootPath, editState.articleId, sourcePath,
    );
    return { url: attached.target, label: selectedText || attached.name };
  } catch (error) {
    showToast(`Не удалось вложить документ: ${describeError(error)}`);
    return null;
  } finally {
    setBusy(false);
  }
}

/**
 * Возвращает ссылку на файл, оставленный в сетевой папке.
 *
 * Принимает выделенный текст. Файл не копируется: он ведётся в другом месте
 * и должен там остаться. Путь кодируется, потому что пробел в адресе
 * разрывает разметку ссылки, а имена документов почти всегда с пробелами.
 */
async function chooseExternalDocument(selectedText) {
  const sourcePath = await selectDocumentFile();
  if (!sourcePath) {
    return null;
  }
  const name = sourcePath.split(/[\\/]/).pop();
  return {
    url: `file:${encodeURI(sourcePath.replace(/\\/g, "/"))}`,
    label: selectedText || name,
  };
}

/**
 * Открывает документ в приложении по умолчанию.
 *
 * Принимает цель ссылки. Перед открытием файл проверяется заново: база была
 * прочитана раньше, и с тех пор документ могли удалить или отключить диск.
 * Само приложение документы не показывает — этим занимаются Word и Acrobat.
 */
async function openDocument(target) {
  setBusy(true);
  try {
    const checked = await requestKnowledgeBaseDocumentCheck(
      knowledgeBase.rootPath, target,
    );
    if (!checked.available) {
      showToast(`${checked.name}: ${checked.reason}`);
      markDocumentUnavailable(target, checked);
      return;
    }

    const { open } = window.__TAURI__.shell;
    await open(absoluteDocumentPath(target));
  } catch (error) {
    showToast(`Не удалось открыть документ: ${describeError(error)}`);
  } finally {
    setBusy(false);
  }
}

/**
 * Собирает полный путь к документу для открытия системой.
 *
 * Принимает цель ссылки. Вложение хранится относительно корня базы, поэтому
 * путь достраивается: у каждого пользователя сетевая папка подключена под
 * своей буквой диска.
 */
function absoluteDocumentPath(target) {
  if (target.startsWith("file:")) {
    return decodeURIComponent(target.slice("file:".length));
  }
  const relative = decodeURIComponent(target);
  const root = knowledgeBase.rootPath.replace(/[\\/]+$/, "");
  return `${root}\\${relative.replace(/\//g, "\\")}`;
}

/**
 * Помечает документ недоступным и перерисовывает статью.
 *
 * Вызывается, когда файл пропал уже после загрузки базы: пометка появляется
 * сразу, не дожидаясь следующего обновления.
 */
function markDocumentUnavailable(target, checked) {
  knowledgeBase.documents.set(target, checked);
  if (selectedRelativePath) {
    showArticle(selectedRelativePath);
  }
}

// ── Показ результатов поиска и подсветка в статье ────────────────────────────

/**
 * Возвращает текущий поисковый запрос.
 */
function currentSearchQuery() {
  return document.getElementById("kb-search").value.trim();
}

/**
 * Собирает строку результата: заголовок, путь, счётчик и фрагменты текста.
 *
 * Принимает запись результата поиска. Фрагменты собираются из отдельных
 * узлов, а не вставкой разметки: текст статьи пишут пользователи, и
 * собирать из него HTML-строку означало бы каждый раз думать об
 * экранировании.
 */
function buildSearchResultItem(result) {
  const article = result.article;

  const row = document.createElement("div");
  row.className = "kb-search-item";

  const button = buildArticleButton(article, true);
  row.appendChild(button);

  const count = document.createElement("span");
  count.className = "kb-search-count";
  count.textContent = result.inTitle && !result.snippets.length
    ? "в заголовке"
    : `совпадений: ${result.matchCount}`;
  button.appendChild(count);

  result.snippets.forEach((snippet) => {
    const line = document.createElement("button");
    line.type = "button";
    line.className = "kb-search-snippet";
    line.appendChild(document.createTextNode(snippet.before));

    const mark = document.createElement("mark");
    mark.className = "kb-mark";
    mark.textContent = snippet.match;
    line.appendChild(mark);

    line.appendChild(document.createTextNode(snippet.after));
    line.addEventListener("click", () => openArticleFromSearch(article));
    row.appendChild(line);
  });

  return row;
}

/**
 * Открывает статью из результатов поиска и ведёт к найденному месту.
 */
function openArticleFromSearch(article) {
  if (editState.isEditing) {
    showToast("Сначала сохраните или отмените правки открытой статьи");
    return;
  }
  showArticle(article.relative_path);
  renderTreePane();
}

/**
 * Подсвечивает найденное в открытой статье и прокручивает к первому месту.
 *
 * Принимает основу запроса. Подсветка ставится обходом текстовых узлов, а не
 * заменой в разметке: замена по строке испортила бы теги и атрибуты — слово
 * из запроса может встретиться внутри имени класса или адреса ссылки.
 */
function highlightSearchInArticle(stem) {
  const container = document.getElementById("kb-article-body");
  if (!stem) {
    return;
  }

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  let firstMark = null;
  textNodes.forEach((node) => {
    const positions = findMatches(normalizeForSearch(node.nodeValue), stem);
    if (!positions.length) {
      return;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    positions.forEach((position) => {
      // Подсвечивается слово целиком: по запросу «устав» выделять «уста»
      // и оставлять «в» снаружи — выглядит как поломка.
      const word = expandToWord(node.nodeValue, position, stem.length);
      if (word.start < cursor) {
        return;
      }
      fragment.appendChild(
        document.createTextNode(node.nodeValue.slice(cursor, word.start)),
      );
      const mark = document.createElement("mark");
      mark.className = "kb-mark";
      mark.textContent = node.nodeValue.slice(word.start, word.end);
      fragment.appendChild(mark);
      firstMark = firstMark || mark;
      cursor = word.end;
    });
    fragment.appendChild(document.createTextNode(node.nodeValue.slice(cursor)));
    node.parentNode.replaceChild(fragment, node);
  });

  if (firstMark) {
    firstMark.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}
