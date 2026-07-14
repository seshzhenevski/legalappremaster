// sheets-settings-store.js
// Персистентное хранение настроек доступа к Google-таблице дашборда.
//
// Обёртка над tauri-plugin-store — тот же файл настроек, что и у ключа DaData
// (см. dadata-key-store.js). Хранится только путь к JSON-ключу сервисного
// аккаунта и идентификатор таблицы; сам ключ остаётся файлом на диске
// пользователя и в приложение не копируется.

const STORE_FILE_NAME = "settings.json";
const CREDENTIALS_PATH_RECORD_KEY = "sheets_credentials_path";
const SPREADSHEET_ID_RECORD_KEY = "sheets_spreadsheet_id";

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
 * Читает сохранённые настройки доступа к таблице.
 *
 * Возвращает объект с путём к ключу и идентификатором таблицы; ненастроенные
 * поля приходят пустыми строками.
 */
export async function loadSheetsSettings() {
  const store = await getStore();
  return {
    credentialsPath: (await store.get(CREDENTIALS_PATH_RECORD_KEY)) || "",
    spreadsheetId: (await store.get(SPREADSHEET_ID_RECORD_KEY)) || "",
  };
}

/**
 * Сохраняет настройки доступа к таблице на диск.
 *
 * Принимает путь к JSON-ключу и идентификатор таблицы, сразу сбрасывая
 * изменения на диск, чтобы настройки пережили перезапуск приложения.
 */
export async function saveSheetsSettings({ credentialsPath, spreadsheetId }) {
  const store = await getStore();
  await store.set(CREDENTIALS_PATH_RECORD_KEY, credentialsPath);
  await store.set(SPREADSHEET_ID_RECORD_KEY, spreadsheetId);
  await store.save();
}
