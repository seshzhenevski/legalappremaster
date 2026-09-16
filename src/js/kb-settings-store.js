// kb-settings-store.js
// Персистентное хранение пути к корневой папке базы знаний.
//
// Обёртка над tauri-plugin-store, по образцу dadata-key-store.js —
// единственное место, где фронтенд знает о деталях хранения этой настройки.
//
// Путь хранится в настройках приложения, а не в конфиге сборки, намеренно:
// одна и та же сетевая папка подключена у сотрудников под разными буквами
// диска, а значение в конфиге одно на всех и меняется только пересборкой.

const STORE_FILE_NAME = "settings.json";
const ROOT_PATH_RECORD_KEY = "knowledge_base_root";

let storeInstance = null;

/**
 * Возвращает (и при необходимости создаёт) экземпляр хранилища.
 *
 * Хранилище открывается один раз и переиспользуется при последующих
 * обращениях в рамках сессии приложения.
 */
async function getStore() {
  if (!storeInstance) {
    const { load } = window.__TAURI__.store;
    storeInstance = await load(STORE_FILE_NAME);
  }
  return storeInstance;
}

/**
 * Читает сохранённый путь к корневой папке базы знаний.
 *
 * Возвращает строку пути или пустую строку, если папка ещё не выбрана.
 */
export async function loadKnowledgeBaseRoot() {
  const store = await getStore();
  const value = await store.get(ROOT_PATH_RECORD_KEY);
  return value || "";
}

/**
 * Сохраняет путь к корневой папке базы знаний на диск.
 *
 * Принимает строку пути, записывает её в хранилище и сразу сбрасывает
 * изменения, чтобы настройка пережила перезапуск приложения.
 */
export async function saveKnowledgeBaseRoot(rootPath) {
  const store = await getStore();
  await store.set(ROOT_PATH_RECORD_KEY, rootPath);
  await store.save();
}
