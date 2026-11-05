// tab-tasks.js
// Вкладка «Задачи»: личная канбан-доска.
//
// Один человек на одном компьютере ведёт свои задачи: колонки-статусы
// заводит сам, задачам ставит сроки, ведёт чеклисты и комментарии,
// прикрепляет документы. Правила работы с данными — в tasks-board.js,
// хранение — в tasks-store.js, перетаскивание — в tasks-drag.js; здесь
// только показ и отклик на действия.
//
// Разметка из текста задач не собирается: всё, что написал человек, ставится
// через textContent, поэтому об экранировании здесь думать не нужно.
//
// Правки сохраняются сразу, без кнопки «Сохранить»: поле записывается, как
// только из него ушли. Доска личная, спорить за неё некому, а забытое
// «Сохранить» стоило бы потерянной записи.

import {
  addAttachment,
  addChecklistItem,
  addColumn,
  addComment,
  addTask,
  checklistProgress,
  deadlineState,
  deadlineSummary,
  deleteChecklistItem,
  deleteColumn,
  deleteComment,
  deleteTask,
  describeDeadlineSummary,
  fileNameFromPath,
  findColumn,
  findTaskColumn,
  folderFromPath,
  formatDateTime,
  formatDeadline,
  formatIsoDate,
  moveColumn,
  moveTask,
  pluralize,
  removeAttachment,
  renameColumn,
  searchTasks,
  setColumnColor,
  todayIso,
  updateChecklistItem,
  updateComment,
  updateTask,
} from "./tasks-board.js";
import { loadBoard, saveBoard } from "./tasks-store.js";
import { enableCardDragging } from "./tasks-drag.js";
import { askChoice, askConfirm, askText } from "./kb-dialog.js";
import { closeMenu, isMenuOpenFor, openMenu } from "./kb-menu.js";
import { documentIconFor } from "./kb-markdown.js";
import { createDateField, setDateFieldValue } from "./date-picker.js";
import { selectDocumentFile } from "./file-dialogs.js";
import { showToast } from "./toast.js";

// Сколько висит напоминание о сроках при запуске: оно приходит, пока
// человек ещё смотрит на другую вкладку, и двух секунд обычного сообщения
// на него не хватит.
const REMINDER_DURATION_MS = 8000;

// Сообщения об ошибках держатся дольше обычных: их надо успеть прочитать.
const ERROR_TOAST_MS = 5000;

// Сколько после открытия окна задачи щелчок мимо него не закрывает окно.
// Карточку по привычке открывают двойным щелчком: окно появляется после
// первого, и второй, пришедшийся мимо окна, тут же закрыл бы его.
const MODAL_CLOSE_GUARD_MS = 400;

const state = {
  // Доска; null, пока не прочитана.
  board: null,
  query: "",
  // Найденные задачи или null, когда поиска нет.
  matches: null,
  // Колонка, в которой открыто поле новой задачи, и набранный в нём текст.
  addingToColumnId: null,
  addDraft: "",
  // Задача, открытая в окне, когда окно открыли и комментарий, который
  // сейчас правят.
  openTaskId: null,
  modalOpenedAt: 0,
  editingCommentId: null,
  // Нажата ли в открытом окне «Создать чек-лист». У задачи без пунктов
  // чек-лист спрятан за этой кнопкой: большинству задач он не нужен, и
  // пустой раздел только удлинял бы окно.
  checklistOpen: false,
};

// Палитра колонок: первые восемь — мягкие, вторые — насыщенные; в меню они
// встают двумя рядами. В доске хранится ключ, цвет берётся отсюда — палитру
// можно поправить, не трогая сохранённые доски. Цвет — три числа RGB, как в
// токенах темы: так его можно взять и целиком, и полупрозрачным.
const COLUMN_COLORS = [
  { value: "gray", label: "Серый", color: "148 163 184" },
  { value: "pink", label: "Розовый", color: "248 113 113" },
  { value: "peach", label: "Персиковый", color: "251 146 60" },
  { value: "yellow", label: "Жёлтый", color: "250 204 21" },
  { value: "lime", label: "Салатовый", color: "74 222 128" },
  { value: "turquoise", label: "Бирюзовый", color: "45 212 191" },
  { value: "sky", label: "Голубой", color: "96 165 250" },
  { value: "lilac", label: "Сиреневый", color: "167 139 250" },
  { value: "graphite", label: "Графитовый", color: "71 85 105" },
  { value: "red", label: "Красный", color: "220 38 38" },
  { value: "orange", label: "Оранжевый", color: "234 88 12" },
  { value: "mustard", label: "Горчичный", color: "202 138 4" },
  { value: "green", label: "Зелёный", color: "22 163 74" },
  { value: "teal", label: "Морской", color: "13 148 136" },
  { value: "blue", label: "Синий", color: "37 99 235" },
  { value: "purple", label: "Пурпурный", color: "192 38 211" },
];

// Недописанный комментарий и пункт чек-листа по задачам. Закрыть окно,
// не нажав «Добавить», — обычное дело, и набранный текст не должен при
// этом пропадать. Живут до закрытия приложения.
const drafts = { comment: new Map(), checklist: new Map() };

// Классы метки срока. Записаны целиком, а не собраны из кусков: Tailwind
// оставляет в сборке только те классы, что встречаются в исходниках
// буквально.
const DEADLINE_CHIP_CLASSES = {
  overdue: "tasks-chip tasks-chip-overdue",
  today: "tasks-chip tasks-chip-today",
};

/**
 * Собирает значок Lucide нужного размера.
 */
function icon(size, paths) {
  return `<svg class="lucide" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" `
    + `stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" `
    + `aria-hidden="true">${paths}</svg>`;
}

const ICONS = {
  done: icon(18, '<circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" />'),
  calendar: icon(12, '<path d="M8 2v4" /><path d="M16 2v4" /><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M3 10h18" />'),
  checklist: icon(12, '<rect width="18" height="18" x="3" y="3" rx="2" /><path d="m9 12 2 2 4-4" />'),
  comment: icon(12, '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />'),
  attachment: icon(12, '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />'),
  plus: icon(15, '<path d="M5 12h14" /><path d="M12 5v14" />'),
  close: icon(15, '<path d="M18 6 6 18" /><path d="m6 6 12 12" />'),
};

/**
 * Инициализирует вкладку: обработчики доски и окна задачи, чтение доски.
 *
 * Доска читается при запуске приложения, а не при первом открытии
 * вкладки: по ней сразу же напоминается о сроках.
 */
export function initTasksTab() {
  const boardElement = document.getElementById("tasks-board");
  boardElement.addEventListener("click", handleBoardClick);
  boardElement.addEventListener("dblclick", handleBoardDoubleClick);
  boardElement.addEventListener("keydown", handleBoardKeydown);
  boardElement.addEventListener("input", handleBoardInput);
  enableCardDragging(boardElement, {
    canDrag: () => !state.matches,
    onDrop: handleCardDrop,
  });

  document.getElementById("tasks-search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderBoard();
  });

  initTaskModal();
  loadAndShowBoard();
}

/**
 * Читает доску и показывает её, а при ошибке — объяснение.
 */
async function loadAndShowBoard() {
  try {
    state.board = await loadBoard();
  } catch (error) {
    document.getElementById("tasks-error-text").textContent = describeError(error);
    showPane("tasks-error-pane");
    return;
  }
  showPane("tasks-content-pane");
  renderBoard();
  remindAboutDeadlines();
}

/**
 * Показывает одну из панелей вкладки и прячет остальные.
 */
function showPane(paneId) {
  ["tasks-loading-pane", "tasks-error-pane", "tasks-content-pane"].forEach((id) => {
    document.getElementById(id).classList.toggle("hidden", id !== paneId);
  });
}

/**
 * Напоминает о горящих сроках.
 *
 * Только при запуске приложения, а не при каждом открытии вкладки: так
 * договорились, и напоминание, которое всплывает на каждом переключении,
 * быстро перестают читать.
 */
function remindAboutDeadlines() {
  const text = describeDeadlineSummary(deadlineSummary(state.board, todayIso()));
  if (text) {
    showToast(text, REMINDER_DURATION_MS);
  }
}

/**
 * Записывает изменённую доску и показывает изменения.
 *
 * Принимает признак, перерисовывать ли списки в открытом окне задачи. После
 * правки текстового поля — не нужно и даже вредно: поле записывается, когда
 * из него уходят, то есть в тот момент, когда человек уже нажимает кнопку
 * рядом. Перерисованная кнопка была бы новой, и нажатие ушло бы в пустоту.
 */
function commit({ refreshModalLists = true } = {}) {
  renderBoard();
  if (state.openTaskId) {
    if (refreshModalLists) {
      renderTaskModal();
    } else {
      renderTaskModalDetails();
    }
  }
  saveBoard(state.board).catch((error) => {
    showToast(`Не удалось сохранить задачи: ${describeError(error)}`, ERROR_TOAST_MS);
  });
}

/**
 * Перерисовывает доску целиком.
 *
 * Прокрутка доски и колонок и фокус переживают перерисовку: иначе каждая
 * отметка «готово» отбрасывала бы длинную колонку к началу.
 */
function renderBoard() {
  const boardElement = document.getElementById("tasks-board");
  state.matches = searchTasks(state.board, state.query);

  const scrollLeft = boardElement.scrollLeft;
  const listScroll = new Map();
  boardElement.querySelectorAll("[data-column-list]").forEach((list) => {
    listScroll.set(list.dataset.columnId, list.scrollTop);
  });
  const focusKey = boardElement.contains(document.activeElement)
    ? document.activeElement.dataset.focusKey
    : "";

  boardElement.replaceChildren(
    ...state.board.columns.map(buildColumn),
    buildAddColumnButton(),
  );

  boardElement.scrollLeft = scrollLeft;
  boardElement.querySelectorAll("[data-column-list]").forEach((list) => {
    list.scrollTop = listScroll.get(list.dataset.columnId) || 0;
  });
  if (focusKey) {
    focusByKey(boardElement, focusKey);
  }

  document.getElementById("tasks-search-counter").textContent =
    state.matches ? `Найдено: ${state.matches.size}` : "";
}

/**
 * Ставит фокус на элемент с указанным ключом, если он есть.
 *
 * Ключи собраны из идентификаторов, в которых нет кавычек, поэтому
 * подставлять их в селектор можно без экранирования.
 */
function focusByKey(container, key) {
  const element = container.querySelector(`[data-focus-key="${key}"]`);
  if (element && element !== document.activeElement) {
    element.focus({ preventScroll: true });
  }
}

/**
 * Собирает колонку: шапку, поле новой задачи и карточки.
 */
function buildColumn(column) {
  const element = document.createElement("section");
  element.className = "tasks-column";
  element.dataset.column = "";
  element.setAttribute("aria-label", `Колонка «${column.title}»`);
  const color = COLUMN_COLORS.find((entry) => entry.value === column.color);
  if (color) {
    element.classList.add("tasks-column-colored");
    element.style.setProperty("--column-color", color.color);
  }

  const visibleIds = state.matches
    ? column.taskIds.filter((taskId) => state.matches.has(taskId))
    : column.taskIds;

  const header = document.createElement("div");
  header.className = "tasks-column-header";

  const title = document.createElement("h3");
  title.className = "tasks-column-title";
  title.textContent = column.title;
  title.title = `${column.title} — двойной щелчок, чтобы переименовать`;
  header.appendChild(title);

  const count = document.createElement("span");
  count.className = "tasks-column-count";
  count.textContent = state.matches
    ? `${visibleIds.length} из ${column.taskIds.length}`
    : String(column.taskIds.length);
  header.appendChild(count);

  header.appendChild(buildKebabButton({
    columnMenu: column.id,
    focusKey: `colmenu:${column.id}`,
  }, `Действия с колонкой «${column.title}»`));
  element.appendChild(header);

  element.appendChild(state.addingToColumnId === column.id
    ? buildAddForm(column)
    : buildAddTaskButton(column));

  const list = document.createElement("div");
  list.className = "tasks-column-list thin-scroll";
  list.dataset.columnList = "";
  list.dataset.columnId = column.id;
  visibleIds.forEach((taskId) => list.appendChild(buildCard(state.board.tasks[taskId])));
  element.appendChild(list);

  return element;
}

/**
 * Собирает кнопку «три точки» с меню.
 *
 * Принимает data-атрибуты кнопки и подпись — она же подсказка и название
 * для экранного диктора: «три точки» без названия ему ничего не говорят.
 */
function buildKebabButton(data, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "kb-kebab-button";
  Object.assign(button.dataset, data);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = "⋮";
  return button;
}

/**
 * Собирает кнопку «Добавить задачу» под шапкой колонки.
 */
function buildAddTaskButton(column) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tasks-add-task";
  button.dataset.addTask = column.id;
  button.dataset.focusKey = `add:${column.id}`;
  button.innerHTML = ICONS.plus;
  button.append("Добавить задачу");
  return button;
}

/**
 * Собирает поле новой задачи. Набранный текст переживает перерисовку доски.
 */
function buildAddForm(column) {
  const form = document.createElement("div");
  form.className = "tasks-add-form";

  const input = document.createElement("textarea");
  input.className = "tasks-add-input";
  input.rows = 2;
  input.setAttribute("aria-label", `Новая задача в колонке «${column.title}»`);
  input.dataset.addInput = column.id;
  input.dataset.focusKey = `addinput:${column.id}`;
  input.value = state.addDraft;
  form.appendChild(input);

  const actions = document.createElement("div");
  actions.className = "tasks-add-actions";
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "tasks-primary-button";
  submit.dataset.addSubmit = "";
  submit.textContent = "Добавить";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "tasks-secondary-button";
  cancel.dataset.addCancel = "";
  cancel.textContent = "Отмена";
  actions.append(submit, cancel);
  form.appendChild(actions);

  return form;
}

/**
 * Собирает карточку задачи: отметку «готово», название, меню и строку с
 * подробностями — сроком, чеклистом, комментариями и файлами.
 */
function buildCard(task) {
  const card = document.createElement("div");
  card.className = task.done ? "tasks-card tasks-card-done" : "tasks-card";
  card.dataset.taskId = task.id;
  card.dataset.focusKey = `task:${task.id}`;
  card.tabIndex = 0;
  card.setAttribute("aria-label", `Задача «${task.title}»${task.done ? ", выполнена" : ""}`);

  const row = document.createElement("div");
  row.className = "tasks-card-row";
  row.appendChild(buildDoneToggle(task, { toggleDone: task.id, focusKey: `done:${task.id}` }));

  const title = document.createElement("span");
  title.className = "tasks-card-title";
  title.textContent = task.title;
  row.appendChild(title);

  row.appendChild(buildKebabButton({
    cardMenu: task.id,
    focusKey: `menu:${task.id}`,
  }, `Действия с задачей «${task.title}»`));
  card.appendChild(row);

  const chips = buildCardChips(task);
  if (chips.length) {
    const meta = document.createElement("div");
    meta.className = "tasks-card-meta";
    meta.append(...chips);
    card.appendChild(meta);
  }

  const progress = checklistProgress(task);
  if (progress.total) {
    card.appendChild(buildProgressBar(progress));
  }
  return card;
}

/**
 * Собирает круглую отметку «готово» — на карточке и в окне задачи.
 */
function buildDoneToggle(task, data) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tasks-done-toggle";
  Object.assign(button.dataset, data);
  button.innerHTML = ICONS.done;
  setDoneToggleState(button, task.done);
  return button;
}

/**
 * Приводит отметку «готово» к состоянию задачи.
 */
function setDoneToggleState(button, isDone) {
  const label = isDone ? "Вернуть в работу" : "Отметить выполненной";
  button.setAttribute("aria-pressed", String(isDone));
  button.setAttribute("aria-label", label);
  button.title = label;
}

/**
 * Собирает метки карточки: срок, чеклист, комментарии, файлы.
 */
function buildCardChips(task) {
  const chips = [];
  const today = todayIso();

  if (task.deadline) {
    const status = deadlineState(task, today);
    const hint = status === "overdue"
      ? `Срок прошёл: ${formatIsoDate(task.deadline)}`
      : `Срок: ${formatIsoDate(task.deadline)}`;
    chips.push(buildChip(ICONS.calendar, formatDeadline(task.deadline, today),
      DEADLINE_CHIP_CLASSES[status] || "tasks-chip", hint));
  }

  const progress = checklistProgress(task);
  if (progress.total) {
    const complete = progress.done === progress.total;
    chips.push(buildChip(ICONS.checklist, `${progress.done}/${progress.total}`,
      complete ? "tasks-chip tasks-chip-complete" : "tasks-chip", "Чек-лист"));
  }
  if (task.comments.length) {
    chips.push(buildChip(ICONS.comment, String(task.comments.length), "tasks-chip",
      `${task.comments.length} ${pluralize(task.comments.length, ["комментарий", "комментария", "комментариев"])}`));
  }
  if (task.attachments.length) {
    chips.push(buildChip(ICONS.attachment, String(task.attachments.length), "tasks-chip",
      `${task.attachments.length} ${pluralize(task.attachments.length, ["файл", "файла", "файлов"])}`));
  }
  return chips;
}

/**
 * Собирает одну метку карточки: значок и короткий текст.
 */
function buildChip(iconMarkup, text, className, hint) {
  const chip = document.createElement("span");
  chip.className = className;
  chip.title = hint;
  chip.innerHTML = iconMarkup;
  const label = document.createElement("span");
  label.textContent = text;
  chip.appendChild(label);
  return chip;
}

/**
 * Собирает полоску выполнения чеклиста.
 */
function buildProgressBar(progress) {
  const track = document.createElement("div");
  track.className = "tasks-progress";
  track.setAttribute("aria-hidden", "true");
  const bar = document.createElement("div");
  bar.className = "tasks-progress-bar";
  bar.style.width = `${Math.round((progress.done / progress.total) * 100)}%`;
  track.appendChild(bar);
  return track;
}

/**
 * Собирает кнопку «Добавить колонку» в конце доски.
 */
function buildAddColumnButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tasks-add-column";
  button.dataset.addColumn = "";
  button.dataset.focusKey = "add-column";
  button.innerHTML = ICONS.plus;
  button.append("Добавить колонку");
  return button;
}

/**
 * Разбирает щелчки по доске. Один обработчик на всю доску: карточки
 * перерисовываются после каждой правки, и вешать обработчики на каждую
 * заново незачем.
 */
function handleBoardClick(event) {
  const target = event.target;

  const toggle = target.closest("[data-toggle-done]");
  if (toggle) {
    toggleTaskDone(toggle.dataset.toggleDone);
    return;
  }
  const cardMenu = target.closest("[data-card-menu]");
  if (cardMenu) {
    openCardMenu(cardMenu);
    return;
  }
  const columnMenu = target.closest("[data-column-menu]");
  if (columnMenu) {
    openColumnMenu(columnMenu);
    return;
  }
  const addButton = target.closest("[data-add-task]");
  if (addButton) {
    openAddForm(addButton.dataset.addTask);
    return;
  }
  if (target.closest("[data-add-submit]")) {
    submitAddForm();
    return;
  }
  if (target.closest("[data-add-cancel]")) {
    closeAddForm();
    return;
  }
  if (target.closest("[data-add-column]")) {
    promptNewColumn();
    return;
  }
  const card = target.closest("[data-task-id]");
  if (card) {
    openTaskModal(card.dataset.taskId);
  }
}

/**
 * Двойной щелчок по названию колонки — переименование.
 */
function handleBoardDoubleClick(event) {
  const title = event.target.closest(".tasks-column-title");
  if (title) {
    const list = title.closest("[data-column]").querySelector("[data-column-list]");
    promptRenameColumn(list.dataset.columnId);
  }
}

/**
 * Клавиши на доске: Enter и Esc в поле новой задачи, Enter и пробел на
 * карточке открывают её.
 */
function handleBoardKeydown(event) {
  if (event.target.matches("[data-add-input]")) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitAddForm();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeAddForm();
    }
    return;
  }
  if (event.target.matches("[data-task-id]") && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openTaskModal(event.target.dataset.taskId);
  }
}

/**
 * Запоминает текст, набранный в поле новой задачи.
 */
function handleBoardInput(event) {
  if (event.target.matches("[data-add-input]")) {
    state.addDraft = event.target.value;
  }
}

/**
 * Открывает поле новой задачи в колонке.
 *
 * Поиск при этом сбрасывается: новая задача может под него не подойти и
 * исчезнуть сразу после создания — выглядело бы так, будто она не
 * добавилась.
 */
function openAddForm(columnId) {
  state.query = "";
  document.getElementById("tasks-search").value = "";
  state.addingToColumnId = columnId;
  state.addDraft = "";
  renderBoard();
  focusAddInput();
}

/**
 * Ставит курсор в конец поля новой задачи.
 */
function focusAddInput() {
  const input = document.querySelector("#tasks-board [data-add-input]");
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

/**
 * Закрывает поле новой задачи и возвращает фокус на кнопку «Добавить».
 */
function closeAddForm() {
  const columnId = state.addingToColumnId;
  state.addingToColumnId = null;
  state.addDraft = "";
  renderBoard();
  focusByKey(document.getElementById("tasks-board"), `add:${columnId}`);
}

/**
 * Добавляет задачу из поля и оставляет поле открытым — задачи обычно
 * записывают по нескольку подряд.
 */
function submitAddForm() {
  const task = addTask(state.board, state.addingToColumnId, state.addDraft);
  if (task) {
    state.addDraft = "";
    commit();
  }
  focusAddInput();
}

/**
 * Переключает отметку «готово».
 */
function toggleTaskDone(taskId) {
  const task = state.board.tasks[taskId];
  if (task && updateTask(state.board, taskId, { done: !task.done })) {
    commit();
  }
}

/**
 * Кладёт перенесённую мышью карточку на новое место.
 */
function handleCardDrop(taskId, columnId, index) {
  if (moveTask(state.board, taskId, columnId, index)) {
    commit();
  }
}

/**
 * Открывает меню карточки. Повторное нажатие на те же три точки его
 * закрывает.
 *
 * «Переместить в колонку» дублирует перетаскивание намеренно: с клавиатуры
 * карточку не перетащить, а в дальнюю колонку на широкой доске тащить
 * неудобно и мышью.
 */
function openCardMenu(anchor) {
  if (isMenuOpenFor(anchor)) {
    closeMenu();
    return;
  }
  const taskId = anchor.dataset.cardMenu;
  const task = state.board.tasks[taskId];
  const items = [
    { label: "Открыть", onSelect: () => openTaskModal(taskId) },
    {
      label: task.done ? "Вернуть в работу" : "Отметить выполненной",
      onSelect: () => toggleTaskDone(taskId),
    },
  ];
  if (state.board.columns.length > 1) {
    items.push({ label: "Переместить в колонку…", onSelect: () => promptMoveTask(taskId) });
  }
  items.push({ label: "Удалить", danger: true, onSelect: () => confirmDeleteTask(taskId) });
  openMenu(anchor, items);
}

/**
 * Предлагает выбрать колонку и переносит туда задачу — в начало колонки,
 * где её сразу видно.
 */
async function promptMoveTask(taskId) {
  const current = findTaskColumn(state.board, taskId);
  const choices = state.board.columns
    .filter((column) => column !== current)
    .map((column) => ({ value: column.id, label: column.title }));
  const columnId = await askChoice("Переместить в колонку", choices);
  if (columnId && moveTask(state.board, taskId, columnId, 0)) {
    commit();
  }
}

/**
 * Спрашивает подтверждение и удаляет задачу.
 */
async function confirmDeleteTask(taskId) {
  const task = state.board.tasks[taskId];
  if (!task) {
    return;
  }
  const agreed = await askConfirm({
    title: "Удалить задачу?",
    text: `«${task.title}» удалится вместе с чеклистом, комментариями и ссылками на файлы. `
      + "Сами файлы останутся на месте. Отменить удаление нельзя.",
    confirmLabel: "Удалить",
    danger: true,
  });
  if (!agreed) {
    return;
  }
  if (state.openTaskId === taskId) {
    closeTaskModal({ save: false });
  }
  deleteTask(state.board, taskId);
  commit();
}

/**
 * Открывает меню колонки: действия, выбор цвета и удаление — последним и
 * за чертой, чтобы не задеть его, целясь в цвет.
 */
function openColumnMenu(anchor) {
  if (isMenuOpenFor(anchor)) {
    closeMenu();
    return;
  }
  const columnId = anchor.dataset.columnMenu;
  const column = findColumn(state.board, columnId);
  const index = state.board.columns.indexOf(column);
  const shift = (offset) => () => {
    if (moveColumn(state.board, columnId, offset)) {
      commit();
    }
  };
  const paint = (color) => {
    if (setColumnColor(state.board, columnId, color)) {
      commit();
    }
  };

  const items = [
    { label: "Добавить задачу", onSelect: () => openAddForm(columnId) },
    { label: "Переименовать", onSelect: () => promptRenameColumn(columnId) },
  ];
  if (index > 0) {
    items.push({ label: "Сдвинуть влево", onSelect: shift(-1) });
  }
  if (index < state.board.columns.length - 1) {
    items.push({ label: "Сдвинуть вправо", onSelect: shift(1) });
  }
  items.push(
    { separator: true },
    { heading: "Цвет колонки" },
    { swatches: COLUMN_COLORS, selected: column.color, onPick: paint },
  );
  if (column.color) {
    items.push({ label: "Без цвета", onSelect: () => paint("") });
  }
  items.push(
    { separator: true },
    { label: "Удалить колонку", danger: true, onSelect: () => confirmDeleteColumn(columnId) },
  );
  openMenu(anchor, items);
}

/**
 * Спрашивает название новой колонки и добавляет её в конец доски.
 */
async function promptNewColumn() {
  const title = await askText({
    title: "Новая колонка",
    text: "Например: «В работе», «На контроле», «Ждёт ответа».",
    confirmLabel: "Добавить",
  });
  if (!title || !addColumn(state.board, title)) {
    return;
  }
  commit();
  const boardElement = document.getElementById("tasks-board");
  boardElement.scrollLeft = boardElement.scrollWidth;
}

/**
 * Спрашивает новое название колонки.
 */
async function promptRenameColumn(columnId) {
  const column = findColumn(state.board, columnId);
  if (!column) {
    return;
  }
  const title = await askText({
    title: "Название колонки",
    initialValue: column.title,
    confirmLabel: "Сохранить",
  });
  if (title && renameColumn(state.board, columnId, title)) {
    commit();
  }
}

/**
 * Спрашивает подтверждение и удаляет колонку вместе с её задачами.
 *
 * Число задач называется прямо в вопросе: «Удалить колонку?» звучит
 * безобидно, а удаляются вместе с ней и задачи.
 */
async function confirmDeleteColumn(columnId) {
  const column = findColumn(state.board, columnId);
  if (!column) {
    return;
  }
  const count = column.taskIds.length;
  let text = "Колонка пустая.";
  if (count === 1) {
    text = "В колонке есть задача — она удалится вместе с колонкой. Отменить удаление нельзя.";
  } else if (count > 1) {
    text = `В колонке ${count} ${pluralize(count, ["задача", "задачи", "задач"])} — `
      + "они удалятся вместе с колонкой. Отменить удаление нельзя.";
  }
  const agreed = await askConfirm({
    title: `Удалить колонку «${column.title}»?`,
    text: text,
    confirmLabel: "Удалить",
    danger: true,
  });
  if (agreed && deleteColumn(state.board, columnId)) {
    commit();
  }
}

/**
 * Вешает обработчики окна задачи. Окно одно, меняется только задача в нём.
 */
function initTaskModal() {
  const overlay = document.getElementById("task-modal");

  document.getElementById("task-modal-deadline-slot")
    .appendChild(createDateField({ id: "task-modal-deadline", compact: true }));
  document.getElementById("task-modal-deadline").addEventListener("change", (event) => {
    updateOpenTask({ deadline: event.target.value });
  });
  document.getElementById("task-modal-deadline-clear").addEventListener("click", () => {
    setDateFieldValue("task-modal-deadline", "");
    updateOpenTask({ deadline: "" });
  });

  const title = document.getElementById("task-modal-title");
  title.addEventListener("input", () => fitTextarea(title));
  title.addEventListener("keydown", (event) => {
    // Название однострочное: Enter заканчивает правку, а не переносит строку.
    if (event.key === "Enter") {
      event.preventDefault();
      title.blur();
    }
  });
  title.addEventListener("change", commitModalTitle);
  document.getElementById("task-modal-description").addEventListener("change", commitModalDescription);

  document.getElementById("task-modal-done").addEventListener("click", () => {
    toggleTaskDone(state.openTaskId);
  });
  document.getElementById("task-modal-column").addEventListener("change", (event) => {
    if (moveTask(state.board, state.openTaskId, event.target.value, 0)) {
      commit();
    }
  });

  initModalChecklist();
  initModalAttachments();
  initModalComments();

  document.getElementById("task-modal-save").addEventListener("click", saveAndCloseTaskModal);
  document.getElementById("task-modal-delete").addEventListener("click", () => {
    confirmDeleteTask(state.openTaskId);
  });
  document.getElementById("task-modal-close").addEventListener("click", () => closeTaskModal());

  // Щелчок мимо окна закрывает его — как и диалоги базы знаний. Ловится
  // нажатие, а не щелчок: выделяя текст в поле, легко отпустить кнопку за
  // краем окна, и окно закрылось бы посреди правки.
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay
      && performance.now() - state.modalOpenedAt > MODAL_CLOSE_GUARD_MS) {
      closeTaskModal();
    }
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    // Открытый календарь Esc закрывает сам — вместе с ним закрылось бы и
    // окно задачи, а человек хотел убрать только календарь.
    const datePopup = document.getElementById("date-picker-popup");
    if (datePopup && !datePopup.classList.contains("hidden")) {
      return;
    }
    event.preventDefault();
    closeTaskModal();
  });
}

/**
 * Обработчики чек-листа в окне задачи.
 */
function initModalChecklist() {
  const newItem = document.getElementById("task-modal-checklist-new");
  document.getElementById("task-modal-checklist-create").addEventListener("click", () => {
    state.checklistOpen = true;
    renderChecklist(state.board.tasks[state.openTaskId]);
    newItem.focus();
  });
  newItem.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    if (addChecklistItem(state.board, state.openTaskId, newItem.value)) {
      newItem.value = "";
      commit();
    }
  });

  const list = document.getElementById("task-modal-checklist");
  list.addEventListener("change", (event) => {
    const toggle = event.target.closest("[data-check-toggle]");
    if (toggle) {
      if (updateChecklistItem(state.board, state.openTaskId, toggle.dataset.checkToggle,
        { done: toggle.checked })) {
        commit();
      }
      return;
    }
    const text = event.target.closest("[data-check-text]");
    if (text) {
      commitChecklistText(text);
    }
  });
  list.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches("[data-check-text]")) {
      event.preventDefault();
      event.target.blur();
    }
  });
  list.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-check-delete]");
    if (remove && deleteChecklistItem(state.board, state.openTaskId, remove.dataset.checkDelete)) {
      commit();
    }
  });
}

/**
 * Записывает правку текста пункта чеклиста. Пустой текст не принимается:
 * поле возвращается к прежнему тексту, а для удаления есть крестик.
 */
function commitChecklistText(input) {
  const task = state.board.tasks[state.openTaskId];
  const item = task ? task.checklist.find((entry) => entry.id === input.dataset.checkText) : null;
  if (!item) {
    return;
  }
  if (updateChecklistItem(state.board, task.id, item.id, { text: input.value })) {
    commit({ refreshModalLists: false });
  }
  input.value = item.text;
}

/**
 * Обработчики прикреплённых файлов в окне задачи.
 */
function initModalAttachments() {
  document.getElementById("task-modal-attach").addEventListener("click", attachFile);
  document.getElementById("task-modal-attachments").addEventListener("click", (event) => {
    const task = state.board.tasks[state.openTaskId];
    const open = event.target.closest("[data-attachment-open]");
    if (open && task) {
      const attachment = task.attachments.find((entry) => entry.id === open.dataset.attachmentOpen);
      if (attachment) {
        openAttachment(attachment.path);
      }
      return;
    }
    const remove = event.target.closest("[data-attachment-remove]");
    if (remove && removeAttachment(state.board, state.openTaskId, remove.dataset.attachmentRemove)) {
      commit();
    }
  });
}

/**
 * Предлагает выбрать файл и прикрепляет его к открытой задаче.
 */
async function attachFile() {
  const taskId = state.openTaskId;
  let path = null;
  try {
    path = await selectDocumentFile();
  } catch (error) {
    showToast(`Не удалось открыть выбор файла: ${describeError(error)}`, ERROR_TOAST_MS);
    return;
  }
  // Пока был открыт выбор файла, окно задачи могли закрыть.
  if (!path || state.openTaskId !== taskId) {
    return;
  }
  if (!addAttachment(state.board, taskId, path)) {
    showToast("Этот файл уже прикреплён");
    return;
  }
  commit();
}

/**
 * Открывает прикреплённый файл в приложении по умолчанию.
 *
 * Сначала проверяется, на месте ли файл: ссылка живёт в задаче месяцами, и
 * документ за это время могли переложить. Без проверки Windows молча
 * ничего бы не открыла.
 */
async function openAttachment(path) {
  const name = fileNameFromPath(path);
  try {
    if (!(await window.__TAURI__.fs.exists(path))) {
      showToast(`Файл не найден: ${name}. Его могли переместить или удалить.`, ERROR_TOAST_MS);
      return;
    }
    await window.__TAURI__.shell.open(path);
  } catch (error) {
    showToast(`Не удалось открыть «${name}»: ${describeError(error)}`, ERROR_TOAST_MS);
  }
}

/**
 * Обработчики комментариев в окне задачи.
 */
function initModalComments() {
  const input = document.getElementById("task-modal-comment-new");
  const add = () => {
    if (addComment(state.board, state.openTaskId, input.value)) {
      input.value = "";
      drafts.comment.delete(state.openTaskId);
      commit();
    }
  };
  document.getElementById("task-modal-comment-add").addEventListener("click", add);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      add();
    }
  });

  const list = document.getElementById("task-modal-comments");
  list.addEventListener("click", async (event) => {
    const edit = event.target.closest("[data-comment-edit]");
    if (edit) {
      state.editingCommentId = edit.dataset.commentEdit;
      renderComments(state.board.tasks[state.openTaskId]);
      const editor = list.querySelector("[data-comment-editor]");
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
      return;
    }
    if (event.target.closest("[data-comment-save]")) {
      saveEditedComment();
      return;
    }
    if (event.target.closest("[data-comment-cancel]")) {
      state.editingCommentId = null;
      renderComments(state.board.tasks[state.openTaskId]);
      return;
    }
    const remove = event.target.closest("[data-comment-delete]");
    if (remove) {
      const taskId = state.openTaskId;
      const agreed = await askConfirm({
        title: "Удалить комментарий?",
        text: "Отменить удаление нельзя.",
        confirmLabel: "Удалить",
        danger: true,
      });
      if (agreed && deleteComment(state.board, taskId, remove.dataset.commentDelete)) {
        commit();
      }
    }
  });
  list.addEventListener("keydown", (event) => {
    if (!event.target.matches("[data-comment-editor]")) {
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      saveEditedComment();
    } else if (event.key === "Escape") {
      // Esc отменяет правку комментария, а окно задачи остаётся открытым.
      event.preventDefault();
      event.stopPropagation();
      state.editingCommentId = null;
      renderComments(state.board.tasks[state.openTaskId]);
    }
  });
}

/**
 * Записывает правку комментария, если она идёт.
 */
function saveEditedComment() {
  const editor = document.querySelector("#task-modal-comments [data-comment-editor]");
  const commentId = state.editingCommentId;
  if (!editor || !commentId) {
    return;
  }
  state.editingCommentId = null;
  if (updateComment(state.board, state.openTaskId, commentId, editor.value)) {
    commit();
  } else {
    renderComments(state.board.tasks[state.openTaskId]);
  }
}

/**
 * Открывает окно задачи.
 */
function openTaskModal(taskId) {
  const task = state.board.tasks[taskId];
  if (!task) {
    return;
  }
  state.openTaskId = taskId;
  state.modalOpenedAt = performance.now();
  state.editingCommentId = null;
  state.checklistOpen = false;

  const title = document.getElementById("task-modal-title");
  title.value = task.title;
  document.getElementById("task-modal-description").value = task.description;
  document.getElementById("task-modal-checklist-new").value = drafts.checklist.get(taskId) || "";
  document.getElementById("task-modal-comment-new").value = drafts.comment.get(taskId) || "";
  renderTaskModal();

  document.getElementById("task-modal").classList.remove("hidden");
  fitTextarea(title);
  document.getElementById("task-modal-body").scrollTop = 0;
  // Фокус на само окно, а не на поле: иначе первая же нажатая клавиша
  // начала бы переписывать название.
  document.getElementById("task-modal-dialog").focus();
}

/**
 * Закрывает окно задачи.
 *
 * Принимает признак, записать ли то, что набрано в полях. Поле
 * записывается, когда из него уходят, а Esc закрывает окно, не уводя фокус
 * из поля, — поэтому набранное записывается здесь явно.
 */
function closeTaskModal({ save = true } = {}) {
  const taskId = state.openTaskId;
  if (!taskId) {
    return;
  }
  if (save) {
    // Уход из поля записывает его — в том числе поле даты, набранной
    // вручную. Явные записи ниже подстраховывают на случай, если поле
    // уже потеряло фокус иначе.
    const modal = document.getElementById("task-modal");
    const active = document.activeElement;
    if (modal.contains(active)) {
      active.blur();
    }
    commitModalTitle();
    commitModalDescription();
    if (active && active.matches("[data-check-text]")) {
      commitChecklistText(active);
    }
    saveEditedComment();
  }
  drafts.comment.set(taskId, document.getElementById("task-modal-comment-new").value);
  drafts.checklist.set(taskId, document.getElementById("task-modal-checklist-new").value);

  state.openTaskId = null;
  state.editingCommentId = null;
  document.getElementById("task-modal").classList.add("hidden");
  focusByKey(document.getElementById("tasks-board"), `task:${taskId}`);
}

/**
 * «Сохранить»: записывает всё набранное в окне и закрывает его.
 *
 * Правки и так записываются сразу, но выйти из окна через «Сохранить»
 * привычнее, чем через крестик. Раз человек нажал «Сохранить», текст,
 * оставленный в поле нового пункта или комментария, он считает
 * сохранённым — поэтому он добавляется, а не откладывается в черновик,
 * как при закрытии крестиком или Esc.
 */
function saveAndCloseTaskModal() {
  const taskId = state.openTaskId;
  const newItem = document.getElementById("task-modal-checklist-new");
  const comment = document.getElementById("task-modal-comment-new");
  let added = false;
  if (addChecklistItem(state.board, taskId, newItem.value)) {
    newItem.value = "";
    added = true;
  }
  if (addComment(state.board, taskId, comment.value)) {
    comment.value = "";
    added = true;
  }
  if (added) {
    commit();
  }
  closeTaskModal();
}

/**
 * Записывает название из окна задачи. Пустое название не принимается —
 * поле возвращается к прежнему.
 */
function commitModalTitle() {
  const input = document.getElementById("task-modal-title");
  const task = state.board.tasks[state.openTaskId];
  if (!task) {
    return;
  }
  if (updateTask(state.board, task.id, { title: input.value })) {
    commit({ refreshModalLists: false });
  }
  input.value = task.title;
  fitTextarea(input);
}

/**
 * Записывает описание из окна задачи.
 */
function commitModalDescription() {
  const input = document.getElementById("task-modal-description");
  if (state.board.tasks[state.openTaskId]
    && updateTask(state.board, state.openTaskId, { description: input.value })) {
    commit({ refreshModalLists: false });
  }
}

/**
 * Меняет поля открытой задачи и записывает доску.
 */
function updateOpenTask(changes) {
  if (state.openTaskId && updateTask(state.board, state.openTaskId, changes)) {
    commit({ refreshModalLists: false });
  }
}

/**
 * Перерисовывает окно задачи целиком, кроме текстовых полей: их правит
 * человек, и перерисовка сбила бы курсор.
 *
 * Фокус переживает перерисовку: отмеченный пункт чеклиста перерисовывается
 * новым элементом, и без этого фокус терялся бы после каждой галочки.
 */
function renderTaskModal() {
  const task = state.board.tasks[state.openTaskId];
  if (!task) {
    closeTaskModal({ save: false });
    return;
  }
  const modal = document.getElementById("task-modal");
  const focusKey = modal.contains(document.activeElement)
    ? document.activeElement.dataset.focusKey
    : "";

  const select = document.getElementById("task-modal-column");
  const column = findTaskColumn(state.board, task.id);
  select.replaceChildren(...state.board.columns.map((entry) => {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.title;
    option.selected = entry === column;
    return option;
  }));

  renderTaskModalDetails();
  renderChecklist(task);
  renderAttachments(task);
  renderComments(task);

  if (focusKey) {
    focusByKey(modal, focusKey);
  }
}

/**
 * Обновляет в окне задачи то, что не перестраивается заново: отметку
 * «готово», срок и строку о создании и правке.
 */
function renderTaskModalDetails() {
  const task = state.board.tasks[state.openTaskId];
  if (!task) {
    return;
  }
  setDoneToggleState(document.getElementById("task-modal-done"), task.done);
  document.getElementById("task-modal-dialog").classList.toggle("tasks-modal-done", task.done);

  setDateFieldValue("task-modal-deadline", task.deadline);
  document.getElementById("task-modal-deadline-clear").classList.toggle("hidden", !task.deadline);
  const status = deadlineState(task, todayIso());
  const statusElement = document.getElementById("task-modal-deadline-state");
  statusElement.textContent = { overdue: "Срок прошёл", today: "Срок сегодня" }[status] || "";
  statusElement.classList.toggle("tasks-deadline-overdue", status === "overdue");

  const created = formatDateTime(task.createdAt);
  const updated = formatDateTime(task.updatedAt);
  document.getElementById("task-modal-created").textContent = created
    ? `Создана ${created}${updated && updated !== created ? ` · изменена ${updated}` : ""}`
    : "";
}

/**
 * Перерисовывает чек-лист в окне задачи.
 *
 * Раздел виден, только если в чек-листе есть пункты, его только что
 * создали кнопкой или в поле нового пункта остался недописанный текст;
 * иначе на его месте кнопка «Создать чек-лист».
 */
function renderChecklist(task) {
  const draft = document.getElementById("task-modal-checklist-new").value.trim();
  const isShown = task.checklist.length > 0 || state.checklistOpen || Boolean(draft);
  document.getElementById("task-modal-checklist-section").classList.toggle("hidden", !isShown);
  document.getElementById("task-modal-checklist-create").classList.toggle("hidden", isShown);

  const progress = checklistProgress(task);
  document.getElementById("task-modal-checklist-progress").textContent =
    progress.total ? `${progress.done} из ${progress.total}` : "";
  const bar = document.getElementById("task-modal-checklist-bar");
  bar.classList.toggle("hidden", !progress.total);
  bar.firstElementChild.style.width = progress.total
    ? `${Math.round((progress.done / progress.total) * 100)}%`
    : "0";

  document.getElementById("task-modal-checklist").replaceChildren(...task.checklist.map((item) => {
    const row = document.createElement("li");
    row.className = item.done ? "tasks-checklist-item tasks-checklist-item-done" : "tasks-checklist-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "tasks-checklist-checkbox";
    checkbox.checked = item.done;
    checkbox.dataset.checkToggle = item.id;
    checkbox.dataset.focusKey = `check:${item.id}`;
    checkbox.setAttribute("aria-label", `Выполнено: ${item.text}`);

    const text = document.createElement("input");
    text.type = "text";
    text.className = "tasks-checklist-text";
    text.value = item.text;
    text.dataset.checkText = item.id;
    text.dataset.focusKey = `checktext:${item.id}`;
    text.setAttribute("aria-label", "Текст пункта");

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tasks-icon-button";
    remove.dataset.checkDelete = item.id;
    remove.setAttribute("aria-label", `Удалить пункт «${item.text}»`);
    remove.title = "Удалить пункт";
    remove.innerHTML = ICONS.close;

    row.append(checkbox, text, remove);
    return row;
  }));
}

/**
 * Перерисовывает список прикреплённых файлов в окне задачи.
 */
function renderAttachments(task) {
  document.getElementById("task-modal-attachments").replaceChildren(...task.attachments.map((attachment) => {
    const name = fileNameFromPath(attachment.path);
    const row = document.createElement("li");
    row.className = "tasks-attachment";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "tasks-attachment-open";
    open.dataset.attachmentOpen = attachment.id;
    open.title = `Открыть: ${attachment.path}`;

    const fileIcon = document.createElement("span");
    fileIcon.setAttribute("aria-hidden", "true");
    fileIcon.textContent = documentIconFor(name);
    const label = document.createElement("span");
    label.className = "tasks-attachment-name";
    label.textContent = name;
    const folder = document.createElement("span");
    folder.className = "tasks-attachment-folder";
    folder.textContent = folderFromPath(attachment.path);
    open.append(fileIcon, label, folder);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tasks-icon-button";
    remove.dataset.attachmentRemove = attachment.id;
    remove.setAttribute("aria-label", `Открепить «${name}»`);
    remove.title = "Открепить. Сам файл останется на месте";
    remove.innerHTML = ICONS.close;

    row.append(open, remove);
    return row;
  }));
}

/**
 * Перерисовывает комментарии в окне задачи: новые сверху — они нужнее.
 */
function renderComments(task) {
  if (!task) {
    return;
  }
  const newestFirst = [...task.comments].reverse();
  document.getElementById("task-modal-comments").replaceChildren(...newestFirst.map((comment) => {
    const row = document.createElement("li");
    row.className = "tasks-comment";

    const head = document.createElement("div");
    head.className = "tasks-comment-head";
    const time = document.createElement("span");
    time.textContent = formatDateTime(comment.createdAt)
      + (comment.editedAt ? " · изменён" : "");
    if (comment.editedAt) {
      time.title = `Изменён ${formatDateTime(comment.editedAt)}`;
    }
    head.appendChild(time);

    const isEditing = state.editingCommentId === comment.id;
    if (!isEditing) {
      const actions = document.createElement("span");
      actions.className = "tasks-comment-actions";
      actions.append(
        buildCommentAction("Изменить", { commentEdit: comment.id }),
        buildCommentAction("Удалить", { commentDelete: comment.id }),
      );
      head.appendChild(actions);
    }
    row.appendChild(head);

    if (isEditing) {
      const editor = document.createElement("textarea");
      editor.className = "tasks-textarea";
      editor.rows = 3;
      editor.value = comment.text;
      editor.dataset.commentEditor = "";
      editor.setAttribute("aria-label", "Текст комментария");
      const buttons = document.createElement("div");
      buttons.className = "tasks-comment-buttons";
      const save = document.createElement("button");
      save.type = "button";
      save.className = "tasks-primary-button";
      save.dataset.commentSave = "";
      save.textContent = "Сохранить";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "tasks-secondary-button";
      cancel.dataset.commentCancel = "";
      cancel.textContent = "Отмена";
      buttons.append(save, cancel);
      row.append(editor, buttons);
    } else {
      const text = document.createElement("p");
      text.className = "tasks-comment-text";
      text.textContent = comment.text;
      row.appendChild(text);
    }
    return row;
  }));
}

/**
 * Собирает кнопку действия с комментарием.
 */
function buildCommentAction(label, data) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tasks-comment-action";
  Object.assign(button.dataset, data);
  button.textContent = label;
  return button;
}

/**
 * Подгоняет высоту поля под текст — для названия задачи, которое может
 * не уместиться в строку.
 */
function fitTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

/**
 * Достаёт из ошибки текст для человека. Tauri отдаёт ошибки строкой,
 * а браузер — объектом.
 */
function describeError(error) {
  if (!error) {
    return "неизвестная ошибка";
  }
  return String(error.message || error);
}
