// theme-store.js
// Персистентное хранение выбранной темы в settings.json (рядом с прочими
// пользовательскими настройками — ключом DaData и параметрами доступа).
//
// Обёртка над tauri-plugin-store; всё завёрнуто в try/catch, чтобы вне Tauri
// (например, при открытии страницы в обычном браузере во время отладки)
// приложение не падало, а просто не сохраняло тему.

const STORE_FILE_NAME = "settings.json";
const THEME_RECORD_KEY = "theme";

let storeInstance = null;

async function getStore() {
  if (!storeInstance) {
    const { load } = window.__TAURI__.store;
    storeInstance = await load(STORE_FILE_NAME);
  }
  return storeInstance;
}

/**
 * Читает сохранённую тему из settings.json.
 *
 * Возвращает "dark" | "light" или null, если тема ещё не сохранялась либо
 * хранилище недоступно.
 */
export async function loadThemeFromStore() {
  try {
    const store = await getStore();
    const value = await store.get(THEME_RECORD_KEY);
    return value === "dark" || value === "light" ? value : null;
  } catch (error) {
    return null;
  }
}

/**
 * Сохраняет тему в settings.json и сбрасывает изменения на диск.
 */
export async function saveThemeToStore(theme) {
  try {
    const store = await getStore();
    await store.set(THEME_RECORD_KEY, theme);
    await store.save();
  } catch (error) {
    // Нет Tauri-хранилища — тема останется только в localStorage-зеркале.
  }
}
