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

import { requestKnowledgeBase } from "./backend-api.js";
import { selectDirectory } from "./file-dialogs.js";
import { loadKnowledgeBaseRoot, saveKnowledgeBaseRoot } from "./kb-settings-store.js";
import { extractHeadings, renderMarkdown } from "./kb-markdown.js";
import { showToast } from "./toast.js";

// Подписи и оформление статусов статьи из семантической палитры приложения.
const STATUS_STYLES = {
  "актуально": "kb-status kb-status-current",
  "устарело": "kb-status kb-status-outdated",
  "черновик": "kb-status kb-status-draft",
};

const knowledgeBase = {
  rootPath: "",
  articles: [],
  articlesByPath: new Map(),
  tree: null,
  isLoaded: false,
};

let selectedRelativePath = "";
let collapsedFolders = new Set();

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
    document.getElementById("kb-error-text").textContent = error.message;
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
    showToast(`Не удалось открыть ссылку: ${error.message}`);
  }
}
