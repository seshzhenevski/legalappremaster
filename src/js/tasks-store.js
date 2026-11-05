// tasks-store.js
// Хранение личной доски задач.
//
// Обёртка над tauri-plugin-store, по образцу kb-settings-store.js, —
// единственное место, где фронтенд знает, где лежит доска.
//
// Доска живёт только на этом компьютере, в папке данных приложения: так
// договорились — один человек, один компьютер, без сетевой папки. Файл
// свой, а не settings.json рядом с настройками: доска растёт с каждой
// задачей, и переписывать вместе с ней путь к базе знаний и ключ DaData на
// каждое движение карточки незачем.

import { normalizeBoard } from "./tasks-board.js";

const STORE_FILE_NAME = "tasks.json";
const BOARD_RECORD_KEY = "board";

let storeInstance = null;
let pendingSave = Promise.resolve();

/**
 * Возвращает (и при необходимости создаёт) экземпляр хранилища.
 */
async function getStore() {
  if (!storeInstance) {
    const { load } = window.__TAURI__.store;
    storeInstance = await load(STORE_FILE_NAME);
  }
  return storeInstance;
}

/**
 * Читает доску. При первом запуске возвращает новую доску с одной колонкой.
 *
 * Ошибку чтения не прячет: вкладка покажет её, а не начнёт с чистого листа —
 * пустая доска, сохранённая поверх нечитаемой, стёрла бы задачи насовсем.
 */
export async function loadBoard() {
  const store = await getStore();
  return normalizeBoard(await store.get(BOARD_RECORD_KEY));
}

/**
 * Записывает доску на диск.
 *
 * Принимает доску. Записи идут строго по очереди: правки следуют друг за
 * другом быстрее, чем завершается запись, и без очереди более старое
 * состояние доски могло бы лечь на диск последним. Записывается снимок, а не
 * сама доска: пока запись ждёт очереди, доска уже может измениться.
 *
 * Возвращает обещание этой записи. Неудача одной записи не останавливает
 * следующие.
 */
export function saveBoard(board) {
  const snapshot = JSON.parse(JSON.stringify(board));
  const save = pendingSave.catch(() => {}).then(async () => {
    const store = await getStore();
    await store.set(BOARD_RECORD_KEY, snapshot);
    await store.save();
  });
  pendingSave = save;
  return save;
}
