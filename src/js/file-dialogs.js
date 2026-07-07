// file-dialogs.js
// Обёртки над диалогами выбора файлов и папок Tauri.
//
// Единственное место, где фронтенд обращается к файловой системе через
// Tauri. Вкладки вызывают эти функции, не зная деталей плагина dialog.

/**
 * Открывает диалог выбора одного Excel-файла.
 *
 * Показывает системный диалог с фильтром по расширениям xlsx/xlsm/xls.
 * Возвращает путь к выбранному файлу или null, если пользователь отменил.
 */
export async function selectExcelFile() {
  const { open } = window.__TAURI__.dialog;
  const selectedPath = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Excel", extensions: ["xlsx", "xlsm", "xls"] }],
  });
  return selectedPath;
}

/**
 * Открывает диалог выбора одного текстового файла.
 *
 * Показывает системный диалог с фильтром по расширению txt. Возвращает
 * путь к выбранному файлу или null, если пользователь отменил.
 */
export async function selectTextFile() {
  const { open } = window.__TAURI__.dialog;
  const selectedPath = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Текстовый файл", extensions: ["txt"] }],
  });
  return selectedPath;
}

/**
 * Открывает диалог выбора папки.
 *
 * Показывает системный диалог выбора директории. Возвращает путь к
 * выбранной папке или null, если пользователь отменил выбор.
 */
export async function selectDirectory() {
  const { open } = window.__TAURI__.dialog;
  const selectedPath = await open({
    multiple: false,
    directory: true,
  });
  return selectedPath;
}

/**
 * Открывает диалог сохранения одного файла.
 *
 * Показывает системный диалог выбора пути сохранения с именем файла
 * по умолчанию. Возвращает выбранный путь или null, если пользователь
 * отменил выбор.
 */
export async function selectSaveFile(defaultFileName, extensionName, extensions) {
  const { save } = window.__TAURI__.dialog;
  const selectedPath = await save({
    defaultPath: defaultFileName,
    filters: [{ name: extensionName, extensions }],
  });
  return selectedPath;
}
