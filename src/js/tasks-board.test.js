// tasks-board.test.js
// Юнит-тесты данных личной доски задач.
// Запуск: node --test src/js/tasks-board.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_COLUMN_TITLE,
  addAttachment,
  addChecklistItem,
  addColumn,
  addComment,
  addTask,
  checklistProgress,
  createBoard,
  deadlineState,
  deadlineSummary,
  deleteChecklistItem,
  deleteColumn,
  deleteComment,
  deleteTask,
  describeDeadlineSummary,
  fileNameFromPath,
  findTaskColumn,
  folderFromPath,
  formatDeadline,
  moveColumn,
  moveTask,
  normalizeBoard,
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
import { insertionIndex } from "./tasks-drag.js";

const NOW = new Date(2026, 10, 5, 14, 5);

/** Доска с одной колонкой и задачами в ней — в том порядке, что передан. */
function boardWith(...titles) {
  const board = createBoard();
  const columnId = board.columns[0].id;
  // addTask ставит задачу в начало, поэтому добавляем с конца.
  [...titles].reverse().forEach((title) => addTask(board, columnId, title, NOW));
  return board;
}

/** Названия задач колонки по порядку. */
function titles(board, columnIndex = 0) {
  return board.columns[columnIndex].taskIds.map((id) => board.tasks[id].title);
}

test("новая доска начинается с одной пустой колонки", () => {
  const board = createBoard();
  assert.equal(board.columns.length, 1);
  assert.equal(board.columns[0].title, DEFAULT_COLUMN_TITLE);
  assert.equal(board.columns[0].color, "", "без цвета");
  assert.deepEqual(board.columns[0].taskIds, []);
  assert.deepEqual(board.tasks, {});
});

test("normalizeBoard: при первом запуске — новая доска", () => {
  for (const raw of [undefined, null, "мусор", 42]) {
    const board = normalizeBoard(raw);
    assert.equal(board.columns.length, 1, String(raw));
  }
});

test("normalizeBoard: доска переживает чтение без потерь", () => {
  const board = boardWith("Первая", "Вторая");
  const task = board.tasks[board.columns[0].taskIds[0]];
  updateTask(board, task.id, { deadline: "2026-11-12", description: "текст" }, NOW);
  addChecklistItem(board, task.id, "пункт", NOW);
  addComment(board, task.id, "комментарий", NOW);
  addAttachment(board, task.id, "C:\\Дела\\иск.docx", NOW);
  setColumnColor(board, board.columns[0].id, "green");

  const restored = normalizeBoard(JSON.parse(JSON.stringify(board)));
  assert.deepEqual(restored, board);
});

test("normalizeBoard: задача вне колонок возвращается в первую колонку", () => {
  const board = boardWith("Своя");
  board.tasks.lost = { id: "lost", title: "Потерянная" };
  const restored = normalizeBoard(board);
  assert.deepEqual(titles(restored), ["Своя", "Потерянная"]);
});

test("normalizeBoard: задача без колонок не теряется, пустая доска остаётся пустой", () => {
  const orphan = normalizeBoard({ columns: [], tasks: { a: { id: "a", title: "Задача" } } });
  assert.equal(orphan.columns.length, 1);
  assert.deepEqual(titles(orphan), ["Задача"]);

  // Пустая доска без колонок — значит, человек сам их удалил.
  assert.equal(normalizeBoard({ columns: [], tasks: {} }).columns.length, 0);
});

test("normalizeBoard: битые записи отбрасываются, задача в двух колонках остаётся в первой", () => {
  const board = normalizeBoard({
    columns: [
      { id: "c1", title: "Одна", taskIds: ["a", "нет-такой", "a"] },
      { id: "c1", title: "", taskIds: ["a"] },
      null,
    ],
    tasks: { a: { id: "a", title: "Задача", deadline: "12.11.2026", checklist: [null, { text: "п" }] } },
  });
  assert.equal(board.columns.length, 2);
  assert.deepEqual(board.columns[0].taskIds, ["a"]);
  assert.deepEqual(board.columns[1].taskIds, []);
  assert.notEqual(board.columns[1].id, "c1");
  assert.equal(board.columns[1].title, DEFAULT_COLUMN_TITLE);
  assert.equal(board.tasks.a.deadline, "", "дата не в виде ГГГГ-ММ-ДД не принимается");
  assert.equal(board.tasks.a.checklist.length, 1);
});

test("addTask ставит задачу в начало колонки и сводит название в строку", () => {
  const board = boardWith("Старая");
  const task = addTask(board, board.columns[0].id, "  Новая\nзадача  ", NOW);
  assert.equal(task.title, "Новая задача");
  assert.deepEqual(titles(board), ["Новая задача", "Старая"]);
  assert.equal(task.createdAt, NOW.toISOString());
});

test("addTask не создаёт задачу без названия", () => {
  const board = createBoard();
  assert.equal(addTask(board, board.columns[0].id, "   "), null);
  assert.equal(addTask(board, "нет-колонки", "Задача"), null);
  assert.deepEqual(board.tasks, {});
});

test("updateTask меняет поля и сообщает, было ли изменение", () => {
  const board = boardWith("Задача");
  const id = board.columns[0].taskIds[0];
  const later = new Date(2026, 10, 6, 9, 0);

  assert.equal(updateTask(board, id, { title: "Задача" }, later), false, "то же название");
  assert.equal(updateTask(board, id, { title: "   " }, later), false, "пустое название");
  assert.equal(board.tasks[id].updatedAt, NOW.toISOString());

  assert.equal(updateTask(board, id, { done: true, deadline: "2026-11-12" }, later), true);
  assert.equal(board.tasks[id].done, true);
  assert.equal(board.tasks[id].deadline, "2026-11-12");
  assert.equal(board.tasks[id].updatedAt, later.toISOString());

  assert.equal(updateTask(board, id, { deadline: "" }, later), true, "срок убирается");
  assert.equal(board.tasks[id].deadline, "");
  assert.equal(updateTask(board, id, { description: "строка\n\n  " }, later), true);
  assert.equal(board.tasks[id].description, "строка", "хвостовые пробелы не сохраняются");
});

test("moveTask внутри колонки и между колонками", () => {
  const board = boardWith("А", "Б", "В");
  const second = addColumn(board, "На контроле");
  const [a, b, c] = board.columns[0].taskIds;

  assert.equal(moveTask(board, a, board.columns[0].id, 2), true);
  assert.deepEqual(titles(board), ["Б", "В", "А"]);
  assert.equal(moveTask(board, a, board.columns[0].id, 2), false, "на то же место");

  assert.equal(moveTask(board, b, second.id, 0), true);
  assert.deepEqual(titles(board), ["В", "А"]);
  assert.deepEqual(titles(board, 1), ["Б"]);
  assert.equal(findTaskColumn(board, b), second);

  moveTask(board, c, second.id, 99);
  assert.deepEqual(titles(board, 1), ["Б", "В"], "номер за концом — в конец");
});

test("колонки: добавить, переименовать, сдвинуть, удалить вместе с задачами", () => {
  const board = boardWith("А", "Б");
  const first = board.columns[0];
  const second = addColumn(board, " В работе ");
  assert.equal(second.title, "В работе");
  assert.equal(addColumn(board, "  "), null);

  assert.equal(renameColumn(board, second.id, "На контроле"), true);
  assert.equal(renameColumn(board, second.id, ""), false);
  assert.equal(second.title, "На контроле");

  assert.equal(moveColumn(board, second.id, 1), false, "правее некуда");
  assert.equal(moveColumn(board, second.id, -1), true);
  assert.deepEqual(board.columns.map((column) => column.id), [second.id, first.id]);

  const removedIds = [...first.taskIds];
  assert.equal(deleteColumn(board, first.id), true);
  assert.deepEqual(board.columns.map((column) => column.id), [second.id]);
  removedIds.forEach((id) => assert.equal(board.tasks[id], undefined));
});

test("цвет колонки: ставится, снимается, мусор не принимается", () => {
  const board = createBoard();
  const id = board.columns[0].id;
  assert.equal(setColumnColor(board, id, "green"), true);
  assert.equal(setColumnColor(board, id, "green"), false, "тот же цвет");
  assert.equal(board.columns[0].color, "green");
  assert.equal(setColumnColor(board, id, ""), true, "цвет снят");
  assert.equal(board.columns[0].color, "");
  assert.equal(setColumnColor(board, id, "url(javascript:1)"), false, "не похоже на ключ — как без цвета");
  assert.equal(board.columns[0].color, "");

  const broken = normalizeBoard({ columns: [{ id: "c", title: "К", color: "<b>", taskIds: [] }], tasks: {} });
  assert.equal(broken.columns[0].color, "");
  const old = normalizeBoard({ columns: [{ id: "c", title: "К", taskIds: [] }], tasks: {} });
  assert.equal(old.columns[0].color, "", "доска, сохранённая до появления цветов, читается без цвета");
});

test("deleteTask убирает задачу из колонки и из доски", () => {
  const board = boardWith("А", "Б");
  const [a] = board.columns[0].taskIds;
  assert.equal(deleteTask(board, a), true);
  assert.deepEqual(titles(board), ["Б"]);
  assert.equal(board.tasks[a], undefined);
  assert.equal(deleteTask(board, a), false);
});

test("чеклист: добавить, отметить, переименовать, удалить, посчитать", () => {
  const board = boardWith("Задача");
  const id = board.columns[0].taskIds[0];
  const first = addChecklistItem(board, id, "Запросить выписку", NOW);
  const second = addChecklistItem(board, id, "Подготовить иск", NOW);
  assert.equal(addChecklistItem(board, id, "  "), null);
  assert.deepEqual(checklistProgress(board.tasks[id]), { done: 0, total: 2 });

  assert.equal(updateChecklistItem(board, id, first.id, { done: true }, NOW), true);
  assert.equal(updateChecklistItem(board, id, first.id, { done: true }, NOW), false);
  assert.equal(updateChecklistItem(board, id, second.id, { text: "" }, NOW), false, "пустой текст");
  assert.equal(updateChecklistItem(board, id, second.id, { text: "Подать иск" }, NOW), true);
  assert.deepEqual(checklistProgress(board.tasks[id]), { done: 1, total: 2 });

  assert.equal(deleteChecklistItem(board, id, first.id, NOW), true);
  assert.deepEqual(board.tasks[id].checklist.map((item) => item.text), ["Подать иск"]);
});

test("комментарии: переводы строк сохраняются, правка помечается временем", () => {
  const board = boardWith("Задача");
  const id = board.columns[0].taskIds[0];
  const comment = addComment(board, id, "  Позвонил приставу.\nОбещали до пятницы.  ", NOW);
  assert.equal(comment.text, "Позвонил приставу.\nОбещали до пятницы.");
  assert.equal(addComment(board, id, "\n  \n"), null);

  const later = new Date(2026, 10, 7, 10, 0);
  assert.equal(updateComment(board, id, comment.id, comment.text, later), false, "без изменений");
  assert.equal(updateComment(board, id, comment.id, "Перезвонить", later), true);
  assert.equal(comment.editedAt, later.toISOString());
  assert.equal(comment.createdAt, NOW.toISOString(), "время создания не меняется");

  assert.equal(deleteComment(board, id, comment.id, later), true);
  assert.deepEqual(board.tasks[id].comments, []);
});

test("файлы: один и тот же файл дважды не прикрепляется, регистр не важен", () => {
  const board = boardWith("Задача");
  const id = board.columns[0].taskIds[0];
  const file = addAttachment(board, id, "C:\\Дела\\Иск.docx", NOW);
  assert.ok(file);
  assert.equal(addAttachment(board, id, "c:\\дела\\иск.DOCX", NOW), null);
  assert.equal(board.tasks[id].attachments.length, 1);

  assert.equal(removeAttachment(board, id, file.id, NOW), true);
  assert.deepEqual(board.tasks[id].attachments, []);
});

test("имя и папка файла из пути", () => {
  assert.equal(fileNameFromPath("\\\\srv\\Юристы\\Дело 15\\иск.pdf"), "иск.pdf");
  assert.equal(folderFromPath("\\\\srv\\Юристы\\Дело 15\\иск.pdf"), "\\\\srv\\Юристы\\Дело 15");
  assert.equal(fileNameFromPath("C:/Дела/акт.xlsx"), "акт.xlsx");
  assert.equal(folderFromPath("акт.xlsx"), "");
});

test("todayIso берёт местную дату, а не по Гринвичу", () => {
  // 00:30 местного времени: по Гринвичу в Москве это ещё вчера.
  assert.equal(todayIso(new Date(2026, 10, 5, 0, 30)), "2026-11-05");
  assert.equal(todayIso(new Date(2026, 0, 9)), "2026-01-09");
});

test("deadlineState: просрочено, сегодня, впереди, без срока, выполнено", () => {
  const today = "2026-11-05";
  const task = (deadline, done = false) => ({ deadline, done });
  assert.equal(deadlineState(task("2026-11-04"), today), "overdue");
  assert.equal(deadlineState(task("2025-12-31"), today), "overdue");
  assert.equal(deadlineState(task("2026-11-05"), today), "today");
  assert.equal(deadlineState(task("2026-11-06"), today), "");
  assert.equal(deadlineState(task(""), today), "");
  assert.equal(deadlineState(task("2026-11-01", true), today), "", "выполненная не горит");
});

test("formatDeadline: ближние дни словами, год только чужой", () => {
  const today = "2026-11-05";
  assert.equal(formatDeadline("2026-11-05", today), "Сегодня");
  assert.equal(formatDeadline("2026-11-06", today), "Завтра");
  assert.equal(formatDeadline("2026-11-04", today), "Вчера");
  assert.equal(formatDeadline("2026-11-12", today), "12 нояб.");
  assert.equal(formatDeadline("2026-05-01", today), "1 мая");
  assert.equal(formatDeadline("2027-01-15", today), "15 янв. 2027");
  // Переход через конец месяца и года.
  assert.equal(formatDeadline("2027-01-01", "2026-12-31"), "Завтра");
  assert.equal(formatDeadline("", today), "");
});

test("напоминание при запуске считает только невыполненные", () => {
  const board = boardWith("Просрочена", "Сегодня", "Сделана", "Потом");
  const [overdue, dueToday, done, later] = board.columns[0].taskIds;
  updateTask(board, overdue, { deadline: "2026-11-01" });
  updateTask(board, dueToday, { deadline: "2026-11-05" });
  updateTask(board, done, { deadline: "2026-11-01", done: true });
  updateTask(board, later, { deadline: "2026-12-01" });

  const summary = deadlineSummary(board, "2026-11-05");
  assert.deepEqual(summary, { overdue: 1, dueToday: 1 });
  assert.equal(describeDeadlineSummary(summary), "Задачи: просрочено — 1, срок сегодня — 1");
  assert.equal(describeDeadlineSummary({ overdue: 0, dueToday: 3 }), "Задачи: срок сегодня — 3");
  assert.equal(describeDeadlineSummary({ overdue: 0, dueToday: 0 }), "");
});

test("pluralize: 1 задача, 2 задачи, 5 задач, 11 задач, 21 задача", () => {
  const forms = ["задача", "задачи", "задач"];
  const cases = { 1: "задача", 2: "задачи", 4: "задачи", 5: "задач", 11: "задач", 12: "задач", 21: "задача", 22: "задачи", 111: "задач" };
  for (const [count, expected] of Object.entries(cases)) {
    assert.equal(pluralize(Number(count), forms), expected, count);
  }
});

test("поиск: по названию, описанию, чеклисту, комментариям и именам файлов", () => {
  const board = boardWith("Взыскать неустойку", "Ответ приставу", "Банкротство", "Акт сверки", "Прочее");
  const [penalty, bailiff, bankruptcy, act, other] = board.columns[0].taskIds;
  updateTask(board, bailiff, { description: "Уточнить про неустойки по делу" });
  addChecklistItem(board, bankruptcy, "Посчитать неустойкой проценты");
  addComment(board, act, "Обсудили\nНЕУСТОЙКУ с клиентом");
  addAttachment(board, other, "C:\\Дела\\Расчёт неустойки.xlsx");

  assert.deepEqual(searchTasks(board, "неустойка"), new Set([penalty, bailiff, bankruptcy, act, other]));
  assert.deepEqual(searchTasks(board, "пристав"), new Set([bailiff]));
  assert.deepEqual(searchTasks(board, "сверк"), new Set([act]));
  assert.equal(searchTasks(board, "   "), null, "пустой запрос — поиска нет");
  assert.deepEqual(searchTasks(board, "иск"), new Set(), "«иск» не находится внутри «приставу»");
});

test("insertionIndex: место по серединам карточек", () => {
  const centers = [100, 200, 300];
  assert.equal(insertionIndex(centers, 50), 0);
  assert.equal(insertionIndex(centers, 150), 1);
  assert.equal(insertionIndex(centers, 299), 2);
  assert.equal(insertionIndex(centers, 301), 3);
  assert.equal(insertionIndex([], 10), 0, "пустая колонка");
});
