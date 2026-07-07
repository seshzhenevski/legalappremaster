// tab-sorter.js
// Вкладка «Сортировщик документов».
//
// Собирает пути к папкам и текст с описанием счетов, запускает сборку
// пакетов документов и показывает лог выполнения со статистикой.

import { requestDocumentSorting } from "./backend-api.js";
import { selectDirectory, selectTextFile } from "./file-dialogs.js";
import { withButtonBusy } from "./loading-button.js";
import { showResultModal } from "./result-modal.js";

/**
 * Читает текстовый файл через Tauri fs API.
 *
 * Обёртка вместо прямой деструктуризации на верхнем уровне модуля — если
 * API недоступен, ошибка проявится только при вызове этой функции, а не
 * сломает загрузку всего модуля (и, как следствие, всей инициализации
 * приложения).
 */
async function readTextFile(path) {
  return window.__TAURI__.fs.readTextFile(path);
}

/**
 * Открывает путь (папку/файл) в системном проводнике через Tauri shell API.
 *
 * Обёртка по той же причине, что и readTextFile выше.
 */
async function openPath(path) {
  return window.__TAURI__.shell.open(path);
}

/**
 * Инициализирует вкладку сортировщика документов.
 *
 * Вешает обработчики на кнопки выбора папок, запуска сортировки и очистки.
 */
export function initSorterTab() {
  document
    .getElementById("sorter-source-button")
    .addEventListener("click", handleSourceSelection);
  document
    .getElementById("sorter-output-button")
    .addEventListener("click", handleOutputSelection);
  document
    .getElementById("sorter-run-button")
    .addEventListener("click", handleSortingRun);
  document
    .getElementById("sorter-clear-button")
    .addEventListener("click", clearSorterForm);
  document
    .getElementById("sorter-load-file-button")
    .addEventListener("click", handleLoadInvoiceTextFromFile);
  document
    .getElementById("sorter-help-button")
    .addEventListener("click", () => {
      document.getElementById("sorter-help-modal").classList.remove("hidden");
    });
  document
    .getElementById("sorter-help-close-button")
    .addEventListener("click", () => {
      document.getElementById("sorter-help-modal").classList.add("hidden");
    });
  document
    .getElementById("sorter-clear-log-button")
    .addEventListener("click", clearSorterLog);
}

/**
 * Обрабатывает нажатие кнопки «Загрузить из файла».
 *
 * Открывает диалог выбора текстового файла и подставляет его содержимое
 * в поле описания счетов.
 */
async function handleLoadInvoiceTextFromFile() {
  const path = await selectTextFile();
  if (!path) {
    return;
  }
  const content = await readTextFile(path);
  document.getElementById("sorter-invoice-text").value = content;
}

/**
 * Обрабатывает выбор папки с исходными PDF-файлами.
 *
 * Открывает диалог выбора папки и записывает путь в поле формы.
 */
async function handleSourceSelection() {
  const path = await selectDirectory();
  if (path) {
    document.getElementById("sorter-source-path").value = path;
  }
}

/**
 * Обрабатывает выбор папки для сохранения пакетов.
 *
 * Открывает диалог выбора папки и записывает путь в поле формы.
 */
async function handleOutputSelection() {
  const path = await selectDirectory();
  if (path) {
    document.getElementById("sorter-output-path").value = path;
  }
}

/**
 * Собирает данные формы в объект запроса на сортировку.
 *
 * Читает пути к папкам и текст с описанием счетов, возвращает объект
 * в формате, который ожидает бэкенд-метод sort_documents.
 */
function collectSortingRequest() {
  return {
    source_folder: document.getElementById("sorter-source-path").value,
    output_folder: document.getElementById("sorter-output-path").value,
    invoice_text: document.getElementById("sorter-invoice-text").value,
    check_integrity: document.getElementById("sorter-check-integrity").checked,
  };
}

/**
 * Проверяет, что обязательные поля запроса сортировки заполнены.
 *
 * Принимает объект запроса и возвращает текст ошибки или пустую строку.
 */
function validateSortingRequest(request) {
  if (!request.source_folder) {
    return "Выберите папку с исходными документами.";
  }
  if (!request.output_folder) {
    return "Выберите папку для сохранения результата.";
  }
  if (!request.invoice_text.trim()) {
    return "Вставьте текст с описанием счетов.";
  }
  return "";
}

/**
 * Обрабатывает нажатие кнопки запуска сортировки.
 *
 * Собирает и проверяет данные формы, показывает индикатор выполнения,
 * вызывает бэкенд и показывает лог выполнения со статистикой.
 */
async function handleSortingRun() {
  const request = collectSortingRequest();

  const validationError = validateSortingRequest(request);
  if (validationError) {
    appendSorterLogLine(`❌ ${validationError}`, true);
    return;
  }

  appendSorterLogLine("Сборка пакетов...");
  const progressBar = document.getElementById("sorter-progress");
  const progressFill = document.getElementById("sorter-progress-fill");
  progressBar.classList.remove("hidden");
  progressFill.style.width = "0%";
  const button = document.getElementById("sorter-run-button");

  try {
    const result = await withButtonBusy(button, "Обработка…", async () => {
      const sortingResult = await requestDocumentSorting(request, (payload) => {
        if (payload.message) {
          appendSorterLogLine(payload.message, isWarningLine(payload.message));
        }
        if (typeof payload.percent === "number") {
          progressFill.style.width = `${payload.percent}%`;
        }
      });
      showSorterResult(sortingResult);
      if (document.getElementById("sorter-open-after").checked) {
        await openPath(request.output_folder);
      }
      return sortingResult;
    });
    const warningsCount = result.log.filter(isWarningLine).length;
    showResultModal({
      success: warningsCount === 0,
      title: warningsCount === 0 ? "Готово" : "Готово с предупреждениями",
      message:
        `Создано пакетов: ${result.packages_created} из ${result.invoices_total}.` +
        (warningsCount ? `\nПредупреждений: ${warningsCount}.` : ""),
    });
  } catch (error) {
    appendSorterLogLine(`❌ Ошибка: ${error.message}`, true);
    showResultModal({
      success: false,
      title: "Не удалось собрать пакеты",
      message: error.message,
      buttonText: "Закрыть",
    });
  } finally {
    progressBar.classList.add("hidden");
  }
}

/**
 * Определяет, является ли строка лога предупреждением/ошибкой.
 *
 * Принимает текст строки, возвращает true, если она содержит один из
 * маркеров предупреждения (❌, [!], ⚠).
 */
function isWarningLine(message) {
  return message.includes("❌") || message.includes("[!]") || message.includes("⚠");
}

/**
 * Показывает итоговую статистику сортировки.
 *
 * Сам лог обработки уже отображён построчно в реальном времени через
 * колбэк onProgress — здесь только обновляются три счётчика и итоговая
 * строка (лог из финального ответа не дублируется).
 */
function showSorterResult(result) {
  const warningsCount = result.log.filter(isWarningLine).length;

  document.getElementById("sorter-stat-total").textContent = result.invoices_total;
  document.getElementById("sorter-stat-success").textContent = result.packages_created;
  document.getElementById("sorter-stat-warnings").textContent = warningsCount;

  appendSorterLogLine(
    `✅ Создано пакетов: ${result.packages_created} из ${result.invoices_total}`,
  );
}

/**
 * Добавляет одну строку в лог процесса обработки сортировщика.
 *
 * Принимает текст строки и необязательный флаг предупреждения (выделяется
 * красным жирным). Прокручивает лог к последней строке.
 */
function appendSorterLogLine(message, isWarning = false) {
  const log = document.getElementById("sorter-log");
  const line = document.createElement("div");
  if (isWarning) {
    line.className = "text-red-600 font-medium";
  }
  line.textContent = message;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

/**
 * Очищает лог процесса обработки и сбрасывает статистику к нулю.
 */
function clearSorterLog() {
  document.getElementById("sorter-log").innerHTML = "";
  document.getElementById("sorter-stat-total").textContent = "0";
  document.getElementById("sorter-stat-success").textContent = "0";
  document.getElementById("sorter-stat-warnings").textContent = "0";
}

/**
 * Сбрасывает форму сортировщика к значениям по умолчанию.
 *
 * Очищает пути к папкам, текст описания счетов и чекбоксы. Лог и
 * статистика не трогаются — для них есть отдельная кнопка «Очистить лог».
 */
function clearSorterForm() {
  document.getElementById("sorter-source-path").value = "";
  document.getElementById("sorter-output-path").value = "";
  document.getElementById("sorter-invoice-text").value = "";
  document.getElementById("sorter-check-integrity").checked = true;
  document.getElementById("sorter-open-after").checked = false;
}
