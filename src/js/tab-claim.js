// tab-claim.js
// Вкладка «Генератор претензий».
//
// Собирает реквизиты должника, данные претензии и договора, сумму долга и
// путь к реестру «ОТПРАВКИ ПРЕТЕНЗИЙ.xlsx». Поддерживает поиск по ИНН,
// автоподстановку суммы/договора из загруженного Excel, генерацию письма
// (DOCX + PDF с факсимиле) и опись, дозапись строки в реестр и скачивание
// готовых документов.

import {
  requestClaimGeneration,
  requestClaimExcelSummary,
  requestClaimExport,
  requestCompanyLookup,
} from "./backend-api.js";
import { selectExcelFile, selectDirectory, selectSaveFile } from "./file-dialogs.js";
import { isValidInn } from "./formatting.js";
import { registerExcelDropZone } from "./drag-drop.js";
import { loadDadataApiKey, saveDadataApiKey } from "./dadata-key-store.js";
import { createDateField, setDateFieldValue } from "./date-picker.js";
import { withButtonBusy } from "./loading-button.js";
import { showResultModal } from "./result-modal.js";

// Папка с реестром «ОТПРАВКИ ПРЕТЕНЗИЙ.xlsx» по умолчанию — общая сетевая папка
// юридического департамента. Подставляется в поле при открытии и после очистки;
// путь можно изменить вручную или кнопкой «Обзор». Тот же путь зашит в бэкенде
// (CLAIM_REGISTRY_DEFAULT_FOLDER в legal_tools/config.py) — оттуда его берёт
// вкладка иска, у которой поля пути нет.
const DEFAULT_REGISTRY_FOLDER = "Z:\\ЮРИДИЧЕСКИЙ ДЕПАРТАМЕНТ\\ПДЗ";

// Ключ DaData кешируется в памяти на время сессии (как во вкладке иска).
let dadataApiKey = null;

// Пути к временным файлам последней генерации (для кнопок скачивания).
// Пока не сгенерировано — null, кнопки скачивания заблокированы.
let generatedFiles = null;

/**
 * Возвращает сегодняшнюю дату в формате ГГГГ-ММ-ДД.
 */
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Инициализирует вкладку генератора претензий.
 *
 * Вешает обработчики на кнопки поиска по ИНН, выбора файлов, генерации,
 * очистки и скачивания; создаёт поля даты (претензии — с сегодняшней датой)
 * и регистрирует зону перетаскивания Excel.
 */
export function initClaimTab() {
  document
    .getElementById("claim-inn-search-button")
    .addEventListener("click", handleInnSearch);
  document
    .getElementById("claim-excel-button")
    .addEventListener("click", handleExcelSelection);
  document
    .getElementById("claim-registry-button")
    .addEventListener("click", handleRegistrySelection);
  document
    .getElementById("claim-generate-button")
    .addEventListener("click", handleClaimGeneration);
  document
    .getElementById("claim-clear-button")
    .addEventListener("click", clearClaimForm);
  document
    .getElementById("claim-clear-log-button")
    .addEventListener("click", clearClaimLog);
  document
    .getElementById("claim-download-docx-button")
    .addEventListener("click", () => handleDownload("docx"));
  document
    .getElementById("claim-download-pdf-button")
    .addEventListener("click", () => handleDownload("pdf"));

  registerExcelDropZone("claim-excel-drop-zone", (path) => applyExcelFile(path));

  document.getElementById("claim-registry-path").value = DEFAULT_REGISTRY_FOLDER;

  document
    .getElementById("claim-date-slot")
    .appendChild(createDateField({ id: "claim-date", value: todayIso() }));
  document
    .getElementById("claim-contract-date-slot")
    .appendChild(createDateField({ id: "claim-contract-date" }));
}

/**
 * Сбрасывает форму генератора претензий к значениям по умолчанию.
 *
 * Очищает все поля, возвращает дату претензии на сегодня, снимает
 * результат предыдущей генерации и блокирует кнопки скачивания.
 */
function clearClaimForm() {
  const textFieldIds = [
    "claim-debtor-inn",
    "claim-debtor-name",
    "claim-debtor-ogrn",
    "claim-debtor-address",
    "claim-number",
    "claim-contract-number",
    "claim-debt-amount",
    "claim-excel-path",
    "claim-registry-path",
  ];
  textFieldIds.forEach((id) => {
    document.getElementById(id).value = "";
  });
  // Путь к реестру не «теряется» при очистке — возвращается к значению по умолчанию.
  document.getElementById("claim-registry-path").value = DEFAULT_REGISTRY_FOLDER;
  setDateFieldValue("claim-date", todayIso());
  setDateFieldValue("claim-contract-date", "");
  resetGeneratedFiles();
}

/**
 * Очищает лог процесса формирования претензии.
 */
function clearClaimLog() {
  document.getElementById("claim-log").innerHTML = "";
}

/**
 * Обрабатывает поиск реквизитов должника по ИНН.
 *
 * Проверяет ИНН, запрашивает ключ DaData при необходимости, вызывает
 * бэкенд и заполняет поля наименования, ОГРН и адреса.
 */
async function handleInnSearch() {
  const inn = document.getElementById("claim-debtor-inn").value.trim();

  if (!isValidInn(inn)) {
    appendClaimLogLine("❌ Введите корректный ИНН (10 или 12 цифр).", true);
    return;
  }

  if (dadataApiKey === null) {
    dadataApiKey = await loadDadataApiKey();
  }

  if (!dadataApiKey) {
    openDadataKeyModal(inn);
    return;
  }

  const button = document.getElementById("claim-inn-search-button");
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
      fillDebtorFields(company);
      appendClaimLogLine("✅ Реквизиты заполнены из ЕГРЮЛ.");
    } else {
      appendClaimLogLine("❌ Компания с таким ИНН не найдена.", true);
    }
  } catch (error) {
    appendClaimLogLine(`❌ Ошибка поиска: ${error.message}`, true);
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
function fillDebtorFields(company) {
  document.getElementById("claim-debtor-name").value = company.name;
  document.getElementById("claim-debtor-ogrn").value = company.ogrn;
  document.getElementById("claim-debtor-address").value = company.address;
}

/**
 * Обрабатывает выбор Excel-файла со списком счетов через диалог.
 */
async function handleExcelSelection() {
  const path = await selectExcelFile();
  if (path) {
    await applyExcelFile(path);
  }
}

/**
 * Применяет выбранный/перетащенный Excel: подставляет путь и запрашивает
 * у бэкенда итоговую сумму и реквизиты договора для автозаполнения полей.
 *
 * Общая сумма берётся из столбца 4, номер и дата договора — из столбца 3.
 * Результат подставляется в поля «Сумма долга», «Номер договора» и «Дата
 * договора»; ход и итоги пишутся в лог.
 */
async function applyExcelFile(path) {
  document.getElementById("claim-excel-path").value = path;
  try {
    const summary = await requestClaimExcelSummary(path);
    document.getElementById("claim-debt-amount").value = summary.total;
    if (summary.contract_number) {
      document.getElementById("claim-contract-number").value = summary.contract_number;
    }
    if (summary.contract_date) {
      setDateFieldValue("claim-contract-date", summary.contract_date);
    }
    appendClaimLogLine(
      `✅ Из Excel: счетов ${summary.counted}, сумма ${summary.total} руб.` +
        (summary.contract_number ? `, договор № ${summary.contract_number}` : ""),
    );
  } catch (error) {
    appendClaimLogLine(`❌ Не удалось прочитать Excel: ${error.message}`, true);
  }
}

/**
 * Обрабатывает выбор папки с реестром «ОТПРАВКИ ПРЕТЕНЗИЙ.xlsx».
 */
async function handleRegistrySelection() {
  const path = await selectDirectory();
  if (path) {
    document.getElementById("claim-registry-path").value = path;
  }
}

/**
 * Собирает данные формы в объект запроса на генерацию претензии.
 */
function collectClaimRequest() {
  return {
    defendant: {
      name: document.getElementById("claim-debtor-name").value.trim(),
      inn: document.getElementById("claim-debtor-inn").value.trim(),
      ogrn: document.getElementById("claim-debtor-ogrn").value.trim(),
      address: document.getElementById("claim-debtor-address").value.trim(),
    },
    claim_number: document.getElementById("claim-number").value.trim(),
    claim_date: document.getElementById("claim-date").value,
    contract_number: document.getElementById("claim-contract-number").value.trim(),
    contract_date: document.getElementById("claim-contract-date").value,
    debt_amount: document.getElementById("claim-debt-amount").value.trim(),
    registry_folder: document.getElementById("claim-registry-path").value,
  };
}

/**
 * Проверяет, что обязательные поля запроса заполнены.
 *
 * Возвращает текст ошибки или пустую строку, если всё на месте.
 */
function validateClaimRequest(request) {
  if (!request.defendant.name) {
    return "Укажите наименование должника.";
  }
  if (!request.debt_amount) {
    return "Укажите сумму долга или загрузите Excel со счетами.";
  }
  if (!request.registry_folder) {
    return "Укажите папку с файлом «ОТПРАВКИ ПРЕТЕНЗИЙ.xlsx».";
  }
  return "";
}

/**
 * Обрабатывает нажатие кнопки генерации претензии.
 *
 * Собирает и проверяет данные формы, вызывает бэкенд с живой трансляцией
 * хода работы, дописывает реестр и по завершении активирует кнопки
 * скачивания DOCX/PDF.
 */
async function handleClaimGeneration() {
  const request = collectClaimRequest();

  const validationError = validateClaimRequest(request);
  if (validationError) {
    appendClaimLogLine(`❌ ${validationError}`, true);
    return;
  }

  resetGeneratedFiles();
  const progressBar = document.getElementById("claim-progress");
  const progressFill = document.getElementById("claim-progress-fill");
  progressBar.classList.remove("hidden");
  progressFill.style.width = "0%";
  const button = document.getElementById("claim-generate-button");

  try {
    const result = await withButtonBusy(button, "Формирование…", () =>
      requestClaimGeneration(request, (payload) => {
        if (payload.message) {
          appendClaimLogLine(payload.message, isWarningLine(payload.message));
        }
        if (typeof payload.percent === "number") {
          progressFill.style.width = `${payload.percent}%`;
        }
      }),
    );
    enableGeneratedFiles(result);
    showResultModal({
      success: true,
      title: "Претензия сформирована",
      message:
        `№ ${result.claim_number} от ${result.claim_date} · долг ${result.total_debt} ₽.\n` +
        "Документы готовы — нажмите «Скачать DOCX» или «Скачать PDF».",
    });
  } catch (error) {
    appendClaimLogLine(`❌ Ошибка: ${error.message}`, true);
    showResultModal({
      success: false,
      title: "Не удалось сформировать претензию",
      message: error.message,
      buttonText: "Закрыть",
    });
  } finally {
    progressBar.classList.add("hidden");
  }
}

/**
 * Запоминает пути к сгенерированным файлам и активирует кнопки скачивания.
 */
function enableGeneratedFiles(result) {
  generatedFiles = result;
  document.getElementById("claim-download-docx-button").disabled = false;
  document.getElementById("claim-download-pdf-button").disabled = false;
}

/**
 * Сбрасывает результат генерации и блокирует кнопки скачивания.
 */
function resetGeneratedFiles() {
  generatedFiles = null;
  document.getElementById("claim-download-docx-button").disabled = true;
  document.getElementById("claim-download-pdf-button").disabled = true;
}

/**
 * Обрабатывает скачивание готовой претензии в выбранном формате.
 *
 * Принимает формат ("docx"/"pdf"). Открывает диалог сохранения, затем
 * просит бэкенд скопировать соответствующий временный файл в выбранное
 * место (опись сохраняется рядом в .docx). Итог пишется в лог.
 */
async function handleDownload(format) {
  if (!generatedFiles) {
    return;
  }
  const isPdf = format === "pdf";
  const sourcePath = isPdf ? generatedFiles.pdf_path : generatedFiles.docx_path;
  const defaultName = `Досудебная претензия (${generatedFiles.safe_name}).${format}`;
  const targetPath = await selectSaveFile(
    defaultName,
    isPdf ? "PDF" : "Word",
    [format],
  );
  if (!targetPath) {
    return;
  }

  const button = document.getElementById(
    isPdf ? "claim-download-pdf-button" : "claim-download-docx-button",
  );
  try {
    const result = await withButtonBusy(button, "Сохранение…", () =>
      requestClaimExport({
        source_path: sourcePath,
        target_path: targetPath,
        opis_path: generatedFiles.opis_path,
        safe_name: generatedFiles.safe_name,
      }),
    );
    appendClaimLogLine(`✅ Сохранено: ${result.saved.length} файл(а) (претензия + опись).`);
  } catch (error) {
    appendClaimLogLine(`❌ Ошибка сохранения: ${error.message}`, true);
  }
}

/**
 * Определяет, является ли строка лога предупреждением/ошибкой.
 */
function isWarningLine(message) {
  return message.includes("❌") || message.includes("[!]") || message.includes("⚠");
}

/**
 * Добавляет одну строку в лог процесса формирования претензии.
 *
 * Принимает текст строки и необязательный флаг предупреждения (выделяется
 * красным жирным). Прокручивает лог к последней строке.
 */
function appendClaimLogLine(message, isWarning = false) {
  const log = document.getElementById("claim-log");
  const line = document.createElement("div");
  if (isWarning) {
    line.className = "text-red-600 font-medium";
  }
  line.textContent = message;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}
