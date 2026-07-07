// tab-lawsuit.js
// Вкладка «Генератор искового заявления».
//
// Собирает реквизиты ответчика, параметры расчёта и пути к файлам,
// поддерживает поиск по ИНН и запускает генерацию пакета документов.

import {
  requestLawsuitGeneration,
  requestCompanyLookup,
} from "./backend-api.js";
import { selectExcelFile, selectDirectory } from "./file-dialogs.js";
import { isValidInn } from "./formatting.js";
import { registerExcelDropZone } from "./drag-drop.js";
import { loadDadataApiKey, saveDadataApiKey } from "./dadata-key-store.js";
import { createDateField, setDateFieldValue } from "./date-picker.js";
import { withButtonBusy } from "./loading-button.js";
import { showResultModal } from "./result-modal.js";

// Ключ DaData кешируется в памяти на время сессии после первой загрузки
// из персистентного хранилища (tauri-plugin-store), чтобы не читать диск
// при каждом поиске по ИНН.
let dadataApiKey = null;

/**
 * Инициализирует вкладку генератора иска.
 *
 * Вешает обработчики на кнопки поиска по ИНН, выбора файлов и генерации.
 */
export function initLawsuitTab() {
  document
    .getElementById("lawsuit-inn-search-button")
    .addEventListener("click", handleInnSearch);
  document
    .getElementById("lawsuit-excel-button")
    .addEventListener("click", handleExcelSelection);
  document
    .getElementById("lawsuit-output-button")
    .addEventListener("click", handleOutputSelection);
  document
    .getElementById("lawsuit-closing-docs-button")
    .addEventListener("click", handleClosingDocsSelection);
  document
    .getElementById("lawsuit-generate-button")
    .addEventListener("click", handleLawsuitGeneration);
  document
    .getElementById("lawsuit-clear-button")
    .addEventListener("click", clearLawsuitForm);
  document
    .getElementById("lawsuit-clear-log-button")
    .addEventListener("click", clearLawsuitLog);

  registerExcelDropZone("lawsuit-excel-drop-zone", (path) => {
    document.getElementById("lawsuit-excel-path").value = path;
  });

  document
    .getElementById("lawsuit-pretenzia-date-slot")
    .appendChild(createDateField({ id: "lawsuit-pretenzia-date" }));
  document
    .getElementById("lawsuit-claim-date-slot")
    .appendChild(createDateField({ id: "lawsuit-claim-date", compact: true }));
}

/**
 * Сбрасывает форму генератора иска к значениям по умолчанию.
 *
 * Очищает все текстовые поля, пути и текстовые области, снимает статус
 * и результат предыдущей генерации. Чекбокс «документы подписаны»
 * возвращается во включённое состояние (значение по умолчанию).
 */
function clearLawsuitForm() {
  const textFieldIds = [
    "lawsuit-defendant-inn",
    "lawsuit-defendant-name",
    "lawsuit-defendant-ogrn",
    "lawsuit-defendant-address",
    "lawsuit-pretenzia-number",
    "lawsuit-cap",
    "lawsuit-postal",
    "lawsuit-invoice-text",
    "lawsuit-excel-path",
    "lawsuit-closing-docs-path",
    "lawsuit-output-path",
  ];
  textFieldIds.forEach((id) => {
    document.getElementById(id).value = "";
  });
  setDateFieldValue("lawsuit-pretenzia-date", "");
  setDateFieldValue("lawsuit-claim-date", "");
  document.getElementById("lawsuit-rate").value = "0.1";
  document.getElementById("lawsuit-docs-signed").checked = true;
}

/**
 * Очищает лог процесса формирования иска.
 */
function clearLawsuitLog() {
  document.getElementById("lawsuit-log").innerHTML = "";
}

/**
 * Обрабатывает поиск реквизитов ответчика по ИНН.
 *
 * Проверяет ИНН, запрашивает ключ DaData при необходимости, вызывает
 * бэкенд и заполняет поля наименования, ОГРН и адреса.
 */
async function handleInnSearch() {
  const innInput = document.getElementById("lawsuit-defendant-inn");
  const inn = innInput.value.trim();

  if (!isValidInn(inn)) {
    appendLawsuitLogLine("❌ Введите корректный ИНН (10 или 12 цифр).", true);
    return;
  }

  if (dadataApiKey === null) {
    dadataApiKey = await loadDadataApiKey();
  }

  if (!dadataApiKey) {
    openDadataKeyModal(inn);
    return;
  }

  const button = document.getElementById("lawsuit-inn-search-button");
  await withButtonBusy(button, "Поиск…", () => performCompanyLookup(inn, dadataApiKey));
}

/**
 * Выполняет поиск компании по ИНН и обновляет форму результатом.
 *
 * Принимает ИНН и ключ DaData. Заполняет поля реквизитов при успехе или
 * показывает статус ошибки/отсутствия результата.
 */
async function performCompanyLookup(inn, apiKey) {
  try {
    const company = await requestCompanyLookup(inn, apiKey);
    if (company) {
      fillDefendantFields(company);
      appendLawsuitLogLine("✅ Реквизиты заполнены из ЕГРЮЛ.");
    } else {
      appendLawsuitLogLine("❌ Компания с таким ИНН не найдена.", true);
    }
  } catch (error) {
    appendLawsuitLogLine(`❌ Ошибка поиска: ${error.message}`, true);
  }
}

/**
 * Открывает модальное окно настройки ключа DaData.
 *
 * Принимает ИНН, по которому нужно повторить поиск после сохранения ключа.
 * Вешает одноразовые обработчики на кнопки «Сохранить и найти»/«Отмена».
 */
function openDadataKeyModal(inn) {
  const modal = document.getElementById("dadata-key-modal");
  const input = document.getElementById("dadata-key-input");
  const errorContainer = document.getElementById("dadata-key-error");
  const saveButton = document.getElementById("dadata-key-save-button");
  const cancelButton = document.getElementById("dadata-key-cancel-button");

  input.value = "";
  errorContainer.textContent = "";
  modal.classList.remove("hidden");

  const closeModal = () => {
    modal.classList.add("hidden");
    saveButton.removeEventListener("click", onSave);
    cancelButton.removeEventListener("click", onCancel);
  };

  const onSave = async () => {
    const key = input.value.trim();
    if (!key) {
      errorContainer.textContent = "Введите ключ.";
      return;
    }
    try {
      await saveDadataApiKey(key);
      dadataApiKey = key;
      closeModal();
      await performCompanyLookup(inn, key);
    } catch (error) {
      errorContainer.textContent = `Не удалось сохранить ключ: ${error.message}`;
    }
  };

  const onCancel = () => closeModal();

  saveButton.addEventListener("click", onSave);
  cancelButton.addEventListener("click", onCancel);
}

/**
 * Заполняет поля формы реквизитами найденной компании.
 *
 * Принимает объект с полями name, ogrn, address и записывает их
 * в соответствующие поля ввода.
 */
function fillDefendantFields(company) {
  document.getElementById("lawsuit-defendant-name").value = company.name;
  document.getElementById("lawsuit-defendant-ogrn").value = company.ogrn;
  document.getElementById("lawsuit-defendant-address").value = company.address;
}

/**
 * Обрабатывает выбор Excel-файла с реестром счетов.
 *
 * Открывает диалог выбора файла и записывает путь в поле формы.
 */
async function handleExcelSelection() {
  const path = await selectExcelFile();
  if (path) {
    document.getElementById("lawsuit-excel-path").value = path;
  }
}

/**
 * Обрабатывает выбор папки для сохранения результата.
 *
 * Открывает диалог выбора папки и записывает путь в поле формы.
 */
async function handleOutputSelection() {
  const path = await selectDirectory();
  if (path) {
    document.getElementById("lawsuit-output-path").value = path;
  }
}

/**
 * Обрабатывает выбор папки с закрывающими документами.
 *
 * Открывает диалог выбора папки и записывает путь в поле формы. Эта папка
 * используется для поиска подтверждающих PDF-документов по описанию счетов.
 */
async function handleClosingDocsSelection() {
  const path = await selectDirectory();
  if (path) {
    document.getElementById("lawsuit-closing-docs-path").value = path;
  }
}

/**
 * Собирает данные формы в объект запроса на генерацию иска.
 *
 * Читает все поля вкладки и возвращает объект в формате, который
 * ожидает бэкенд-метод generate_lawsuit.
 */
function collectLawsuitRequest() {
  return {
    defendant: {
      name: document.getElementById("lawsuit-defendant-name").value.trim(),
      inn: document.getElementById("lawsuit-defendant-inn").value.trim(),
      ogrn: document.getElementById("lawsuit-defendant-ogrn").value.trim(),
      address: document.getElementById("lawsuit-defendant-address").value.trim(),
    },
    excel_path: document.getElementById("lawsuit-excel-path").value,
    output_dir: document.getElementById("lawsuit-output-path").value,
    invoice_description_text: document
      .getElementById("lawsuit-invoice-text")
      .value.trim(),
    closing_documents_folder: document.getElementById(
      "lawsuit-closing-docs-path",
    ).value,
    claim_date: document.getElementById("lawsuit-claim-date").value,
    daily_rate_percent: document.getElementById("lawsuit-rate").value || "0.1",
    cap_percent: document.getElementById("lawsuit-cap").value,
    pretenzia_number: document.getElementById("lawsuit-pretenzia-number").value,
    pretenzia_date: document.getElementById("lawsuit-pretenzia-date").value,
    postal_costs: document.getElementById("lawsuit-postal").value || "0",
    docs_signed: document.getElementById("lawsuit-docs-signed").checked,
  };
}

/**
 * Проверяет, что обязательные поля запроса заполнены.
 *
 * Принимает объект запроса и возвращает текст ошибки или пустую строку,
 * если все обязательные поля на месте.
 */
function validateLawsuitRequest(request) {
  if (!request.defendant.name) {
    return "Укажите наименование ответчика.";
  }
  if (!request.excel_path) {
    return "Выберите Excel-файл с реестром счетов.";
  }
  if (!request.output_dir) {
    return "Выберите папку для сохранения результата.";
  }
  if (!request.claim_date) {
    return "Укажите дату расчёта иска.";
  }
  return "";
}

/**
 * Обрабатывает нажатие кнопки генерации иска.
 *
 * Собирает и проверяет данные формы, вызывает бэкенд с живой трансляцией
 * хода работы (лог и процент готовности приходят по мере обработки) и
 * показывает итог или сообщение об ошибке.
 */
async function handleLawsuitGeneration() {
  const request = collectLawsuitRequest();

  const validationError = validateLawsuitRequest(request);
  if (validationError) {
    appendLawsuitLogLine(`❌ ${validationError}`, true);
    return;
  }

  const progressBar = document.getElementById("lawsuit-progress");
  const progressFill = document.getElementById("lawsuit-progress-fill");
  progressBar.classList.remove("hidden");
  progressFill.style.width = "0%";
  const button = document.getElementById("lawsuit-generate-button");

  try {
    const result = await withButtonBusy(button, "Формирование…", () =>
      requestLawsuitGeneration(request, (payload) => {
        if (payload.message) {
          appendLawsuitLogLine(payload.message, isWarningLine(payload.message));
        }
        if (typeof payload.percent === "number") {
          progressFill.style.width = `${payload.percent}%`;
        }
      }),
    );
    showResultModal({
      success: true,
      title: "Готово",
      message:
        `Документы сформированы: ${result.created_files.length}.\n` +
        `Долг: ${result.total_debt} ₽ · Неустойка: ${result.total_penalty} ₽`,
    });
  } catch (error) {
    appendLawsuitLogLine(`❌ Ошибка: ${error.message}`, true);
    showResultModal({
      success: false,
      title: "Не удалось сформировать иск",
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
 * маркеров предупреждения (❌, [!], ⚠) — те же маркеры, что использует
 * лог вкладки «Сортировщик документов».
 */
function isWarningLine(message) {
  return message.includes("❌") || message.includes("[!]") || message.includes("⚠");
}

/**
 * Добавляет одну строку в лог процесса формирования иска.
 *
 * Принимает текст строки и необязательный флаг предупреждения (выделяется
 * красным жирным). Прокручивает лог к последней строке.
 */
function appendLawsuitLogLine(message, isWarning = false) {
  const log = document.getElementById("lawsuit-log");
  const line = document.createElement("div");
  if (isWarning) {
    line.className = "text-red-600 font-medium";
  }
  line.textContent = message;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}
