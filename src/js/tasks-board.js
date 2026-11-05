// tasks-board.js
// Данные личной доски задач: колонки, задачи и всё, что в них лежит.
//
// Здесь только вычисления над данными — ни одна функция не трогает разметку
// и не знает, где доска хранится. Поэтому правила доски покрыты тестами, а
// вкладка занимается лишь показом.
//
// Колонки идут по порядку и хранят порядок своих задач списком
// идентификаторов, а сами задачи лежат отдельно, по идентификатору. Перенос
// задачи — перестановка идентификатора из списка в список; данные задачи
// при этом не трогаются.
//
// Функции, которые что-то меняют, меняют доску на месте и сообщают, было ли
// изменение: вкладке это нужно, чтобы не записывать на диск то же самое.

import { findMatches, normalizeForSearch, searchStem } from "./kb-search.js";

// Версия формата записи. Пригодится, если формат когда-нибудь поменяется:
// старую запись тогда можно будет узнать и перевести, а не гадать.
export const BOARD_FORMAT_VERSION = 1;

// Название колонки новой доски. Доска начинается с одной колонки — остальные
// человек заводит сам, под свой порядок работы.
export const DEFAULT_COLUMN_TITLE = "Задачи";

const MONTHS_SHORT = [
  "янв.", "февр.", "марта", "апр.", "мая", "июня",
  "июля", "авг.", "сент.", "окт.", "нояб.", "дек.",
];

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Цвет колонки хранится ключом из палитры вкладки, а не самим цветом:
// палитру тогда можно поправить, не переписывая сохранённые доски.
const COLOR_KEY_PATTERN = /^[a-z0-9-]{1,32}$/;

/**
 * Придумывает идентификатор для новой записи.
 *
 * Принимает приставку — по ней в сохранённых данных видно, что это за
 * запись. Время плюс случайный хвост: две задачи, созданные в одну
 * миллисекунду, всё равно получат разные идентификаторы.
 */
export function createId(prefix) {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}${random}`;
}

/**
 * Создаёт пустую доску с одной колонкой.
 */
export function createBoard() {
  return {
    version: BOARD_FORMAT_VERSION,
    columns: [{ id: createId("col"), title: DEFAULT_COLUMN_TITLE, color: "", taskIds: [] }],
    tasks: {},
  };
}

/**
 * Приводит прочитанную доску к рабочему виду.
 *
 * Принимает то, что лежало в хранилище: доску, пустоту при первом запуске
 * или данные, испорченные чем угодно. Возвращает исправную доску.
 *
 * Задачи молча не теряются: задача, которой нет ни в одной колонке,
 * возвращается в первую, а если колонок не осталось — в новую. Пустая доска
 * без колонок остаётся пустой: значит, человек сам удалил все колонки.
 */
export function normalizeBoard(raw) {
  if (!raw || typeof raw !== "object") {
    return createBoard();
  }

  const tasks = {};
  const rawTasks = raw.tasks && typeof raw.tasks === "object" ? raw.tasks : {};
  Object.values(rawTasks).forEach((rawTask) => {
    const task = normalizeTask(rawTask);
    if (task && !tasks[task.id]) {
      tasks[task.id] = task;
    }
  });

  const placed = new Set();
  const columnIds = new Set();
  const columns = [];
  (Array.isArray(raw.columns) ? raw.columns : []).forEach((rawColumn) => {
    if (!rawColumn || typeof rawColumn !== "object") {
      return;
    }
    let id = String(rawColumn.id || "");
    if (!id || columnIds.has(id)) {
      id = createId("col");
    }
    columnIds.add(id);
    const taskIds = (Array.isArray(rawColumn.taskIds) ? rawColumn.taskIds : [])
      .map(String)
      .filter((taskId) => {
        // Одна задача в двух колонках — остаётся в первой, где встретилась.
        if (!tasks[taskId] || placed.has(taskId)) {
          return false;
        }
        placed.add(taskId);
        return true;
      });
    columns.push({
      id: id,
      title: cleanLine(rawColumn.title) || DEFAULT_COLUMN_TITLE,
      color: colorKey(rawColumn.color),
      taskIds: taskIds,
    });
  });

  const orphans = Object.keys(tasks).filter((taskId) => !placed.has(taskId));
  if (orphans.length) {
    if (!columns.length) {
      columns.push({ id: createId("col"), title: DEFAULT_COLUMN_TITLE, color: "", taskIds: [] });
    }
    columns[0].taskIds.push(...orphans);
  }

  return { version: BOARD_FORMAT_VERSION, columns: columns, tasks: tasks };
}

/**
 * Приводит к рабочему виду одну задачу. Возвращает null, если запись
 * задачей не является вовсе.
 */
function normalizeTask(raw) {
  if (!raw || typeof raw !== "object" || !raw.id) {
    return null;
  }
  const list = (value) => (Array.isArray(value) ? value : [])
    .filter((item) => item && typeof item === "object");

  return {
    id: String(raw.id),
    title: cleanLine(raw.title),
    description: String(raw.description ?? ""),
    deadline: isIsoDate(raw.deadline) ? raw.deadline : "",
    done: Boolean(raw.done),
    checklist: list(raw.checklist).map((item) => ({
      id: String(item.id || createId("chk")),
      text: cleanLine(item.text),
      done: Boolean(item.done),
    })),
    comments: list(raw.comments).map((comment) => ({
      id: String(comment.id || createId("cmt")),
      text: String(comment.text ?? ""),
      createdAt: String(comment.createdAt || ""),
      editedAt: String(comment.editedAt || ""),
    })),
    attachments: list(raw.attachments)
      .filter((attachment) => attachment.path)
      .map((attachment) => ({
        id: String(attachment.id || createId("file")),
        path: String(attachment.path),
      })),
    createdAt: String(raw.createdAt || ""),
    updatedAt: String(raw.updatedAt || ""),
  };
}

/**
 * Сводит текст в одну строку без лишних пробелов.
 *
 * Названия задач, колонок и пунктов чеклиста — однострочные: перевод строки,
 * вставленный из письма или документа, растянул бы карточку на пол-экрана.
 */
function cleanLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Возвращает ключ цвета, если он похож на ключ, иначе пустую строку.
 */
function colorKey(value) {
  return typeof value === "string" && COLOR_KEY_PATTERN.test(value) ? value : "";
}

/**
 * Отвечает, похоже ли значение на дату вида ГГГГ-ММ-ДД.
 */
function isIsoDate(value) {
  return typeof value === "string" && ISO_DATE_PATTERN.test(value);
}

/**
 * Находит колонку по идентификатору.
 */
export function findColumn(board, columnId) {
  return board.columns.find((column) => column.id === columnId) || null;
}

/**
 * Находит колонку, в которой лежит задача.
 */
export function findTaskColumn(board, taskId) {
  return board.columns.find((column) => column.taskIds.includes(taskId)) || null;
}

/**
 * Добавляет колонку в конец доски.
 *
 * Принимает доску и название. Возвращает новую колонку либо null, если
 * название пустое.
 */
export function addColumn(board, title) {
  const cleanTitle = cleanLine(title);
  if (!cleanTitle) {
    return null;
  }
  const column = { id: createId("col"), title: cleanTitle, color: "", taskIds: [] };
  board.columns.push(column);
  return column;
}

/**
 * Переименовывает колонку. Пустое название не принимается.
 */
export function renameColumn(board, columnId, title) {
  const column = findColumn(board, columnId);
  const cleanTitle = cleanLine(title);
  if (!column || !cleanTitle || column.title === cleanTitle) {
    return false;
  }
  column.title = cleanTitle;
  return true;
}

/**
 * Красит колонку. Принимает ключ цвета из палитры; пустая строка снимает
 * цвет.
 */
export function setColumnColor(board, columnId, color) {
  const column = findColumn(board, columnId);
  const key = colorKey(color);
  if (!column || column.color === key) {
    return false;
  }
  column.color = key;
  return true;
}

/**
 * Сдвигает колонку влево (−1) или вправо (+1).
 */
export function moveColumn(board, columnId, offset) {
  const index = board.columns.findIndex((column) => column.id === columnId);
  const target = index + offset;
  if (index === -1 || target < 0 || target >= board.columns.length) {
    return false;
  }
  const [column] = board.columns.splice(index, 1);
  board.columns.splice(target, 0, column);
  return true;
}

/**
 * Удаляет колонку вместе с её задачами.
 *
 * Задачи удаляются, а не переезжают в соседнюю колонку: человек, удаляющий
 * колонку «Отменённые», не ждёт, что они всплывут среди рабочих. Вкладка
 * предупреждает об этом и называет число задач до удаления.
 */
export function deleteColumn(board, columnId) {
  const index = board.columns.findIndex((column) => column.id === columnId);
  if (index === -1) {
    return false;
  }
  board.columns[index].taskIds.forEach((taskId) => {
    delete board.tasks[taskId];
  });
  board.columns.splice(index, 1);
  return true;
}

/**
 * Добавляет задачу в колонку.
 *
 * Принимает доску, колонку, название и текущее время. Возвращает задачу либо
 * null, если название пустое. Новая задача встаёт в начало колонки — туда
 * же, где поле «Добавить задачу»: в длинной колонке задача, ушедшая в
 * конец, пропала бы из виду сразу после создания.
 */
export function addTask(board, columnId, title, now = new Date()) {
  const column = findColumn(board, columnId);
  const cleanTitle = cleanLine(title);
  if (!column || !cleanTitle) {
    return null;
  }
  const stamp = now.toISOString();
  const task = {
    id: createId("task"),
    title: cleanTitle,
    description: "",
    deadline: "",
    done: false,
    checklist: [],
    comments: [],
    attachments: [],
    createdAt: stamp,
    updatedAt: stamp,
  };
  board.tasks[task.id] = task;
  column.taskIds.unshift(task.id);
  return task;
}

/**
 * Меняет поля задачи.
 *
 * Принимает доску, задачу, изменения ({ title, description, deadline, done }
 * в любом сочетании) и текущее время. Пустое название не принимается:
 * задача без названия на доске выглядела бы пустой карточкой.
 */
export function updateTask(board, taskId, changes, now = new Date()) {
  const task = board.tasks[taskId];
  if (!task) {
    return false;
  }
  let changed = false;

  if ("title" in changes) {
    const title = cleanLine(changes.title);
    if (title && title !== task.title) {
      task.title = title;
      changed = true;
    }
  }
  if ("description" in changes) {
    const description = String(changes.description ?? "").replace(/\s+$/, "");
    if (description !== task.description) {
      task.description = description;
      changed = true;
    }
  }
  if ("deadline" in changes) {
    const deadline = isIsoDate(changes.deadline) ? changes.deadline : "";
    if (deadline !== task.deadline) {
      task.deadline = deadline;
      changed = true;
    }
  }
  if ("done" in changes && Boolean(changes.done) !== task.done) {
    task.done = Boolean(changes.done);
    changed = true;
  }

  if (changed) {
    task.updatedAt = now.toISOString();
  }
  return changed;
}

/**
 * Переносит задачу в колонку на указанное место.
 *
 * Принимает доску, задачу, колонку и номер места среди задач этой колонки
 * без переносимой. Номер за пределами списка ставит задачу в конец.
 */
export function moveTask(board, taskId, columnId, index) {
  const source = findTaskColumn(board, taskId);
  const target = findColumn(board, columnId);
  if (!source || !target) {
    return false;
  }
  const sourceIndex = source.taskIds.indexOf(taskId);
  source.taskIds.splice(sourceIndex, 1);
  const place = Math.max(0, Math.min(index, target.taskIds.length));
  target.taskIds.splice(place, 0, taskId);
  return source !== target || sourceIndex !== place;
}

/**
 * Удаляет задачу.
 */
export function deleteTask(board, taskId) {
  const column = findTaskColumn(board, taskId);
  if (!board.tasks[taskId]) {
    return false;
  }
  if (column) {
    column.taskIds.splice(column.taskIds.indexOf(taskId), 1);
  }
  delete board.tasks[taskId];
  return true;
}

/**
 * Отмечает, что задача изменилась.
 */
function touch(task, now) {
  task.updatedAt = now.toISOString();
}

/**
 * Добавляет пункт в чеклист задачи. Возвращает пункт либо null.
 */
export function addChecklistItem(board, taskId, text, now = new Date()) {
  const task = board.tasks[taskId];
  const cleanText = cleanLine(text);
  if (!task || !cleanText) {
    return null;
  }
  const item = { id: createId("chk"), text: cleanText, done: false };
  task.checklist.push(item);
  touch(task, now);
  return item;
}

/**
 * Меняет пункт чеклиста: текст и/или отметку о выполнении. Пустой текст не
 * принимается — для этого есть удаление пункта.
 */
export function updateChecklistItem(board, taskId, itemId, changes, now = new Date()) {
  const task = board.tasks[taskId];
  const item = task ? task.checklist.find((entry) => entry.id === itemId) : null;
  if (!item) {
    return false;
  }
  let changed = false;
  if ("text" in changes) {
    const text = cleanLine(changes.text);
    if (text && text !== item.text) {
      item.text = text;
      changed = true;
    }
  }
  if ("done" in changes && Boolean(changes.done) !== item.done) {
    item.done = Boolean(changes.done);
    changed = true;
  }
  if (changed) {
    touch(task, now);
  }
  return changed;
}

/**
 * Удаляет пункт чеклиста.
 */
export function deleteChecklistItem(board, taskId, itemId, now = new Date()) {
  const task = board.tasks[taskId];
  const index = task ? task.checklist.findIndex((entry) => entry.id === itemId) : -1;
  if (index === -1) {
    return false;
  }
  task.checklist.splice(index, 1);
  touch(task, now);
  return true;
}

/**
 * Считает выполненные пункты чеклиста.
 */
export function checklistProgress(task) {
  return {
    done: task.checklist.filter((item) => item.done).length,
    total: task.checklist.length,
  };
}

/**
 * Добавляет комментарий к задаче. Возвращает комментарий либо null, если
 * текст пустой.
 *
 * Переводы строк в комментарии сохраняются: в нём пишут по пунктам, с кем
 * говорил и о чём договорились.
 */
export function addComment(board, taskId, text, now = new Date()) {
  const task = board.tasks[taskId];
  const cleanText = String(text ?? "").trim();
  if (!task || !cleanText) {
    return null;
  }
  const comment = {
    id: createId("cmt"),
    text: cleanText,
    createdAt: now.toISOString(),
    editedAt: "",
  };
  task.comments.push(comment);
  touch(task, now);
  return comment;
}

/**
 * Меняет текст комментария и помечает время правки. Пустой текст не
 * принимается — для этого есть удаление.
 */
export function updateComment(board, taskId, commentId, text, now = new Date()) {
  const task = board.tasks[taskId];
  const comment = task ? task.comments.find((entry) => entry.id === commentId) : null;
  const cleanText = String(text ?? "").trim();
  if (!comment || !cleanText || cleanText === comment.text) {
    return false;
  }
  comment.text = cleanText;
  comment.editedAt = now.toISOString();
  touch(task, now);
  return true;
}

/**
 * Удаляет комментарий.
 */
export function deleteComment(board, taskId, commentId, now = new Date()) {
  const task = board.tasks[taskId];
  const index = task ? task.comments.findIndex((entry) => entry.id === commentId) : -1;
  if (index === -1) {
    return false;
  }
  task.comments.splice(index, 1);
  touch(task, now);
  return true;
}

/**
 * Прикрепляет к задаче файл.
 *
 * Принимает доску, задачу и полный путь к файлу. Хранится только путь: сам
 * документ остаётся там, где лежал, и открывается оттуда же. Возвращает
 * запись о файле либо null, если этот файл уже прикреплён — в Windows
 * регистр букв в пути не различается.
 */
export function addAttachment(board, taskId, path, now = new Date()) {
  const task = board.tasks[taskId];
  const cleanPath = String(path ?? "").trim();
  if (!task || !cleanPath) {
    return null;
  }
  const samePath = (entry) => entry.path.toLowerCase() === cleanPath.toLowerCase();
  if (task.attachments.some(samePath)) {
    return null;
  }
  const attachment = { id: createId("file"), path: cleanPath };
  task.attachments.push(attachment);
  touch(task, now);
  return attachment;
}

/**
 * Открепляет файл от задачи. Сам файл не трогается.
 */
export function removeAttachment(board, taskId, attachmentId, now = new Date()) {
  const task = board.tasks[taskId];
  const index = task ? task.attachments.findIndex((entry) => entry.id === attachmentId) : -1;
  if (index === -1) {
    return false;
  }
  task.attachments.splice(index, 1);
  touch(task, now);
  return true;
}

/**
 * Возвращает имя файла из полного пути.
 */
export function fileNameFromPath(path) {
  return String(path ?? "").split(/[\\/]/).pop() || String(path ?? "");
}

/**
 * Возвращает папку файла из полного пути.
 */
export function folderFromPath(path) {
  const text = String(path ?? "");
  const cut = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"));
  return cut === -1 ? "" : text.slice(0, cut);
}

/**
 * Возвращает дату дня в виде ГГГГ-ММ-ДД по местному времени.
 *
 * Местному, а не по Гринвичу: toISOString() до трёх часов ночи по Москве
 * выдал бы вчерашнюю дату, и задача со сроком «сегодня» числилась бы
 * завтрашней.
 */
export function todayIso(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Сдвигает дату вида ГГГГ-ММ-ДД на указанное число дней.
 */
function shiftIsoDate(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  return todayIso(new Date(year, month - 1, day + days));
}

/**
 * Отвечает, что со сроком задачи: "overdue" — просрочен, "today" — сегодня,
 * пустая строка — срока нет, он впереди или задача уже выполнена.
 *
 * Выполненная задача сроком не помечается: красная метка на сделанном деле
 * только отвлекает от того, что действительно горит.
 */
export function deadlineState(task, today) {
  if (!task.deadline || task.done) {
    return "";
  }
  if (task.deadline < today) {
    return "overdue";
  }
  return task.deadline === today ? "today" : "";
}

/**
 * Записывает срок так, как его удобно читать на карточке.
 *
 * Принимает дату ГГГГ-ММ-ДД и сегодняшнюю дату. Ближайшие дни — словами
 * («Сегодня», «Завтра», «Вчера»), остальные — «12 нояб.», с годом, если он
 * не текущий.
 */
export function formatDeadline(iso, today) {
  if (!isIsoDate(iso)) {
    return "";
  }
  if (iso === today) {
    return "Сегодня";
  }
  if (iso === shiftIsoDate(today, 1)) {
    return "Завтра";
  }
  if (iso === shiftIsoDate(today, -1)) {
    return "Вчера";
  }
  const [year, month, day] = iso.split("-").map(Number);
  const text = `${day} ${MONTHS_SHORT[month - 1]}`;
  return String(year) === today.slice(0, 4) ? text : `${text} ${year}`;
}

/**
 * Записывает дату ГГГГ-ММ-ДД как ДД.ММ.ГГГГ.
 */
export function formatIsoDate(iso) {
  if (!isIsoDate(iso)) {
    return "";
  }
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}

/**
 * Записывает момент времени как «05.11.2026 14:05» по местному времени.
 */
export function formatDateTime(stamp) {
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${formatIsoDate(todayIso(date))} ${hours}:${minutes}`;
}

/**
 * Считает невыполненные задачи с просроченным и сегодняшним сроком.
 */
export function deadlineSummary(board, today) {
  const summary = { overdue: 0, dueToday: 0 };
  Object.values(board.tasks).forEach((task) => {
    const state = deadlineState(task, today);
    if (state === "overdue") {
      summary.overdue += 1;
    } else if (state === "today") {
      summary.dueToday += 1;
    }
  });
  return summary;
}

/**
 * Собирает текст напоминания о сроках при запуске приложения. Пустая
 * строка, если напоминать не о чем.
 */
export function describeDeadlineSummary(summary) {
  const parts = [];
  if (summary.overdue) {
    parts.push(`просрочено — ${summary.overdue}`);
  }
  if (summary.dueToday) {
    parts.push(`срок сегодня — ${summary.dueToday}`);
  }
  return parts.length ? `Задачи: ${parts.join(", ")}` : "";
}

/**
 * Выбирает форму слова для числа: 1 задача, 2 задачи, 5 задач.
 *
 * Принимает число и три формы — для одного, для двух-четырёх и для пяти.
 */
export function pluralize(count, forms) {
  const lastTwo = Math.abs(count) % 100;
  const last = lastTwo % 10;
  if (lastTwo > 10 && lastTwo < 20) {
    return forms[2];
  }
  if (last === 1) {
    return forms[0];
  }
  return last >= 2 && last <= 4 ? forms[1] : forms[2];
}

/**
 * Собирает весь текст задачи, по которому её можно найти: название,
 * описание, пункты чеклиста, комментарии и имена прикреплённых файлов.
 */
function searchableText(task) {
  return [
    task.title,
    task.description,
    ...task.checklist.map((item) => item.text),
    ...task.comments.map((comment) => comment.text),
    ...task.attachments.map((attachment) => fileNameFromPath(attachment.path)),
  ].join("\n");
}

/**
 * Ищет задачи по запросу.
 *
 * Принимает доску и строку запроса. Возвращает набор идентификаторов
 * найденных задач либо null, если запрос пустой. Сравнение — то же, что в
 * поиске по базе знаний: без учёта регистра и «ё», с начала слова и по
 * основе, так что «неустойка» находит и «неустойки», и «неустойкой».
 */
export function searchTasks(board, query) {
  const stem = searchStem(query);
  if (!stem) {
    return null;
  }
  const found = new Set();
  Object.values(board.tasks).forEach((task) => {
    if (findMatches(normalizeForSearch(searchableText(task)), stem).length) {
      found.add(task.id);
    }
  });
  return found;
}
