// dadata-key-store.js
// Персистентное хранение API-ключа DaData между запусками приложения.
//
// Обёртка над tauri-plugin-store — единственное место, где фронтенд знает
// о деталях хранения ключа (имя файла хранилища, ключ записи).

const STORE_FILE_NAME = "settings.json";
const API_KEY_RECORD_KEY = "dadata_api_key";

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
 * Читает сохранённый ключ DaData.
 *
 * Возвращает сохранённую строку ключа или пустую строку, если ключ ещё
 * не сохранялся.
 */
export async function loadDadataApiKey() {
  const store = await getStore();
  const value = await store.get(API_KEY_RECORD_KEY);
  return value || "";
}

/**
 * Сохраняет ключ DaData на диск.
 *
 * Принимает строку ключа, записывает её в хранилище и сразу сбрасывает
 * изменения на диск, чтобы ключ пережил перезапуск приложения.
 */
export async function saveDadataApiKey(apiKey) {
  const store = await getStore();
  await store.set(API_KEY_RECORD_KEY, apiKey);
  await store.save();
}
