// tab-state-duty.js
// Вкладка «Калькулятор госпошлины».
//
// Отвечает только за свою вкладку: читает поля ввода, вызывает бэкенд
// через backend-api и показывает результат. Сумма пошлины редактируема —
// её можно поправить вручную перед формированием платёжного поручения.

import {
  requestStateDutyCalculation,
  requestPaymentOrderPdf,
} from "./backend-api.js";
import { selectSaveFile } from "./file-dialogs.js";
import { parseAmountInput } from "./formatting.js";
import { createDateField, setDateFieldValue } from "./date-picker.js";
import { withButtonBusy } from "./loading-button.js";

/**
 * Возвращает сегодняшнюю дату в формате ГГГГ-ММ-ДД.
 */
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Инициализирует вкладку расчёта госпошлины.
 *
 * Находит элементы вкладки в DOM и вешает обработчики на кнопки расчёта
 * и формирования PDF. Вызывается один раз при загрузке приложения.
 */
export function initStateDutyTab() {
  document
    .getElementById("duty-calculate-button")
    .addEventListener("click", handleDutyCalculation);
  document
    .getElementById("duty-generate-pdf-button")
    .addEventListener("click", handlePdfGeneration);
  document
    .getElementById("duty-clear-button")
    .addEventListener("click", clearDutyForm);

  document
    .getElementById("duty-payment-date-slot")
    .appendChild(createDateField({ id: "duty-payment-date", value: todayIso() }));
}

/**
 * Сбрасывает форму расчёта госпошлины к значениям по умолчанию.
 *
 * Очищает цену иска, ответчика и результат расчёта, возвращает дату
 * платежа на сегодняшний день.
 */
function clearDutyForm() {
  document.getElementById("duty-claim-amount").value = "";
  document.getElementById("duty-defendant-name").value = "";
  setDateFieldValue("duty-payment-date", todayIso());
  document.getElementById("duty-amount-input").value = "";
  document.getElementById("duty-amount-words").textContent = "";
  document.getElementById("duty-pdf-status").innerHTML = "";
}

/**
 * Обрабатывает нажатие кнопки расчёта госпошлины.
 *
 * Читает и проверяет цену иска, запрашивает расчёт у бэкенда и выводит
 * результат в редактируемое поле суммы. Показывает сообщение об ошибке
 * при некорректном вводе.
 */
async function handleDutyCalculation() {
  const claimAmountInput = document.getElementById("duty-claim-amount");
  const claimAmount = parseAmountInput(claimAmountInput.value);

  if (isNaN(claimAmount) || claimAmount <= 0) {
    showDutyError("Введите цену иска больше нуля.");
    return;
  }

  const button = document.getElementById("duty-calculate-button");
  try {
    await withButtonBusy(button, "Расчёт…", async () => {
      const result = await requestStateDutyCalculation(claimAmount);
      showDutyResult(result);
    });
  } catch (error) {
    showDutyError(error.message);
  }
}

/**
 * Показывает успешный результат расчёта госпошлины.
 *
 * Заполняет редактируемое поле суммы и подпись прописью, открывает блок
 * результата (дата платежа, кнопка формирования PDF).
 */
function showDutyResult(result) {
  document.getElementById("duty-amount-input").value = result.duty_amount;
  document.getElementById("duty-amount-words").textContent =
    result.duty_amount_in_words;
  document.getElementById("duty-pdf-status").innerHTML = "";
}

/**
 * Показывает сообщение об ошибке во вкладке госпошлины.
 *
 * Скрывает блок результата и выводит текст ошибки под кнопкой расчёта.
 */
function showDutyError(message) {
  document.getElementById("duty-amount-input").value = "";
  document.getElementById("duty-amount-words").textContent = "";
  document.getElementById("duty-pdf-status").innerHTML =
    `<div class="text-red-600">${message}</div>`;
}

/**
 * Обрабатывает нажатие кнопки «Сформировать PDF».
 *
 * Проверяет заполненность полей, открывает диалог сохранения файла
 * и запрашивает у бэкенда генерацию платёжного поручения.
 */
async function handlePdfGeneration() {
  const statusContainer = document.getElementById("duty-pdf-status");
  const claimAmount = parseAmountInput(
    document.getElementById("duty-claim-amount").value,
  );
  const dutyAmount = parseAmountInput(
    document.getElementById("duty-amount-input").value,
  );
  const defendantName = document
    .getElementById("duty-defendant-name")
    .value.trim();
  const paymentDate = document.getElementById("duty-payment-date").value;

  if (!defendantName) {
    statusContainer.innerHTML =
      '<div class="text-red-600">Укажите ответчика.</div>';
    return;
  }
  if (isNaN(dutyAmount) || dutyAmount <= 0) {
    statusContainer.innerHTML =
      '<div class="text-red-600">Сначала рассчитайте или введите сумму госпошлины.</div>';
    return;
  }

  const outputPath = await selectSaveFile(
    `Госпошлина (${defendantName}).pdf`,
    "PDF",
    ["pdf"],
  );
  if (!outputPath) {
    return;
  }

  statusContainer.innerHTML =
    '<div class="text-slate-500">Формирование PDF...</div>';
  const button = document.getElementById("duty-generate-pdf-button");

  try {
    await withButtonBusy(button, "Формирование…", () =>
      requestPaymentOrderPdf({
        output_path: outputPath,
        duty_amount: dutyAmount,
        defendant_name: defendantName,
        claim_amount: claimAmount,
        payment_date: paymentDate || null,
      }),
    );
    statusContainer.innerHTML =
      '<div class="text-green-700">✓ Платёжное поручение сформировано.</div>';
  } catch (error) {
    statusContainer.innerHTML = `<div class="text-red-600">Ошибка: ${error.message}</div>`;
  }
}
