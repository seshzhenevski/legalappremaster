// tab-penalty.js
// Вкладка «Калькулятор неустойки».
//
// Управляет динамическими строками задолженностей и платежей, собирает
// данные формы и запрашивает расчёт у бэкенда. Умеет импортировать долги и
// платежи из Excel и рендерит детальную таблицу расчёта по периодам.

import {
  requestPenaltyCalculation,
  requestPenaltyExcelImport,
} from "./backend-api.js";
import { selectExcelFile } from "./file-dialogs.js";
import { parseAmountInput } from "./formatting.js";
import { registerExcelDropZone } from "./drag-drop.js";
import { createDateField, setDateFieldValue } from "./date-picker.js";
import { withButtonBusy, setButtonBusy } from "./loading-button.js";
import { showToast } from "./toast.js";

// Блоки последнего успешного расчёта — нужны кнопке «Копировать таблицу»,
// которая теперь существует в разметке постоянно (а не создаётся заново
// после каждого расчёта).
let lastCalculationBlocks = [];
let lastCalculationTotals = { totalDebt: "", totalPenalty: "" };

/**
 * Инициализирует вкладку расчёта неустойки.
 *
 * Вешает обработчики на кнопки добавления строк, импорта из Excel и на
 * кнопку расчёта.
 */
export function initPenaltyTab() {
  document
    .getElementById("penalty-add-debt-button")
    .addEventListener("click", addDebtRow);
  document
    .getElementById("penalty-add-payment-button")
    .addEventListener("click", addPaymentRow);
  document
    .getElementById("penalty-calculate-button")
    .addEventListener("click", handlePenaltyCalculation);
  document
    .getElementById("penalty-import-excel-button")
    .addEventListener("click", handleExcelImportViaDialog);
  document
    .getElementById("penalty-clear-button")
    .addEventListener("click", clearPenaltyForm);
  document
    .getElementById("penalty-copy-table-button")
    .addEventListener("click", copyPenaltyTableToClipboard);

  registerExcelDropZone("penalty-excel-drop-zone", importPenaltyExcelFromPath);

  document
    .getElementById("penalty-period-end-slot")
    .appendChild(createDateField({ id: "penalty-period-end" }));

  addDebtRow();
}

/**
 * Добавляет пустую строку задолженности в форму.
 *
 * Создаёт поля суммы и даты начала просрочки с кнопкой удаления строки.
 */
function addDebtRow() {
  const container = document.getElementById("penalty-debts-container");
  container.appendChild(buildAmountDateRow("debt"));
}

/**
 * Добавляет пустую строку платежа в форму.
 *
 * Создаёт поля суммы и даты платежа с кнопкой удаления строки.
 */
function addPaymentRow() {
  const container = document.getElementById("penalty-payments-container");
  container.appendChild(buildAmountDateRow("payment"));
}

/**
 * Строит строку с полями суммы, даты и кнопкой удаления.
 *
 * Принимает тип строки (для CSS-класса) и необязательные значения по
 * умолчанию, возвращает готовый DOM-элемент. Общая функция для строк
 * задолженностей и платежей (принцип DRY).
 */
function buildAmountDateRow(rowType, amountValue = "", dateValue = "") {
  const row = document.createElement("div");
  row.className = `${rowType}-row amount-date-row flex gap-2 items-center mb-2`;

  const amountInput = document.createElement("input");
  amountInput.type = "text";
  amountInput.placeholder = "Сумма";
  amountInput.value = amountValue;
  amountInput.className =
    "row-amount flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm";

  const dateField = createDateField({ extraHiddenClass: "row-date", value: dateValue });
  dateField.classList.add("w-36", "flex-shrink-0");

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "row-remove px-2 text-slate-400 hover:text-red-500";
  removeButton.textContent = "✕";
  removeButton.addEventListener("click", () => row.remove());

  row.appendChild(amountInput);
  row.appendChild(dateField);
  row.appendChild(removeButton);
  return row;
}

/**
 * Собирает данные из строк указанного контейнера.
 *
 * Читает пары «сумма + дата» из всех строк контейнера и возвращает массив
 * объектов. Пропускает строки с незаполненными полями.
 */
function collectRowsData(containerId, dateFieldName) {
  const container = document.getElementById(containerId);
  const collected = [];

  container.querySelectorAll(".amount-date-row").forEach((row) => {
    const amountText = row.querySelector(".row-amount").value;
    const dateText = row.querySelector(".row-date").value;
    if (!amountText || !dateText) {
      return;
    }
    const amount = parseAmountInput(amountText);
    collected.push({ amount: String(amount), [dateFieldName]: dateText });
  });
  return collected;
}

/**
 * Обрабатывает нажатие кнопки расчёта неустойки.
 *
 * Собирает задолженности и платежи, читает дату окончания, ставку, тип
 * ставки и ограничение, запрашивает расчёт у бэкенда и выводит результат.
 */
async function handlePenaltyCalculation() {
  const debts = collectRowsData("penalty-debts-container", "start_date");
  const payments = collectRowsData("penalty-payments-container", "date");
  const periodEndDate = document.getElementById("penalty-period-end").value;
  const dailyRatePercent = document.getElementById("penalty-rate").value;
  const rateType = document.getElementById("penalty-rate-type").value;
  const capPercent = document.getElementById("penalty-cap").value;

  if (debts.length === 0) {
    showPenaltyStatus("Добавьте хотя бы одну задолженность.", true);
    return;
  }
  if (!periodEndDate) {
    showPenaltyStatus("Укажите дату окончания периода.", true);
    return;
  }

  const button = document.getElementById("penalty-calculate-button");
  try {
    await withButtonBusy(button, "Расчёт…", async () => {
      const result = await requestPenaltyCalculation(
        debts,
        payments,
        periodEndDate,
        dailyRatePercent || "0.1",
        rateType,
        capPercent,
      );
      showPenaltyResult(result);
    });
  } catch (error) {
    showPenaltyStatus(error.message, true);
  }
}

/**
 * Показывает результат расчёта неустойки.
 *
 * Обновляет итоговый долг, итоговую неустойку, предупреждение об
 * ограничении (если сработало) и детальную таблицу расчёта по периодам.
 */
function showPenaltyResult(result) {
  lastCalculationBlocks = result.blocks;
  lastCalculationTotals = {
    totalDebt: result.total_debt,
    totalPenalty: result.total_penalty,
  };

  document.getElementById("penalty-cap-warning").textContent = result.cap_info
    ? `Неустойка ограничена ${result.cap_info.cap_percent}% от суммы долга ` +
      `(без ограничения было бы ${result.cap_info.uncapped_total} ₽).`
    : "";

  document.getElementById("penalty-result-table-body").innerHTML = buildPenaltyTableRows(
    result.blocks,
    result.total_debt,
    result.total_penalty,
  );

  if (result.warnings.length) {
    showPenaltyStatus(result.warnings.join(" "), true);
  } else {
    showPenaltyStatus("✅ Расчёт выполнен.", false);
  }
}

/**
 * Показывает статусную строку под таблицей результата неустойки.
 *
 * Принимает текст и флаг предупреждения/ошибки (окрашивает текст красным).
 */
function showPenaltyStatus(message, isWarning) {
  const statusBar = document.getElementById("penalty-status-bar");
  statusBar.textContent = message;
  statusBar.className = isWarning
    ? "text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2"
    : "text-sm text-slate-500 bg-slate-50 rounded-lg px-3 py-2";
}

/**
 * Строит HTML-строки таблицы расчёта неустойки по блокам.
 *
 * Формат один в один соответствует таблице неустойки в исковом заявлении
 * (см. legal_tools/generators/lawsuit_docx.py:_law_build_penalty_table):
 * «Месяц» и «Начислено» объединены (rowspan) на все строки блока, после
 * строк блока — строка «Итого: … руб.», в конце таблицы — две итоговые
 * строки с суммой долга и неустойки по всем задолженностям.
 */
function buildPenaltyTableRows(blocks, totalDebt, totalPenalty) {
  const rowsHtml = [];

  for (const block of blocks) {
    const rowCount = block.rows.length;

    block.rows.forEach((row, index) => {
      const spanCells = index === 0
        ? `<td class="py-1 px-2 text-center align-top" rowspan="${rowCount}">${block.start_date}</td>
           <td class="py-1 px-2 text-center align-top" rowspan="${rowCount}">${block.initial_amount}</td>`
        : "";

      if (row[0] === "debt") {
        const [, amount, from, to, days, formula, penaltyAmount] = row;
        rowsHtml.push(`
          <tr class="border-b border-slate-100">
            ${spanCells}
            <td class="py-1 px-2 text-right">${amount}</td>
            <td class="py-1 px-2 text-center">${from}</td>
            <td class="py-1 px-2 text-center">${to}</td>
            <td class="py-1 px-2 text-center">${days}</td>
            <td class="py-1 px-2 text-right">${formula}</td>
            <td class="py-1 px-2 text-right">${penaltyAmount}</td>
          </tr>
        `);
      } else {
        const [, amount, paymentDate] = row;
        rowsHtml.push(`
          <tr class="border-b border-slate-100 bg-amber-50 text-slate-600">
            ${spanCells}
            <td class="py-1 px-2 text-right">${amount}</td>
            <td class="py-1 px-2 text-center">${paymentDate}</td>
            <td class="py-1 px-2" colspan="3">Погашение части долга</td>
            <td class="py-1 px-2"></td>
          </tr>
        `);
      }
    });

    rowsHtml.push(`
      <tr class="border-b border-slate-200">
        <td colspan="6"></td>
        <td class="py-1 px-2 text-right font-semibold">Итого:</td>
        <td class="py-1 px-2 text-right font-semibold">${block.penalty_total} руб.</td>
      </tr>
    `);
  }

  rowsHtml.push(`
    <tr>
      <td colspan="8" class="py-1 px-2 text-right font-semibold">
        Сумма основного долга: ${totalDebt} руб.
      </td>
    </tr>
    <tr>
      <td colspan="8" class="py-1 px-2 text-right font-semibold">
        Сумма пеней по всем задолженностям: ${totalPenalty} руб.
      </td>
    </tr>
  `);

  return rowsHtml.join("");
}

/**
 * Копирует таблицу расчёта неустойки в буфер обмена.
 *
 * Собирает и HTML-представление (вставляется как форматированная таблица
 * в Word/Excel), и TSV-текст (вставляется как обычный текст), кладёт оба
 * представления в буфер обмена одновременно. Использует блоки последнего
 * успешного расчёта.
 */
async function copyPenaltyTableToClipboard() {
  if (lastCalculationBlocks.length === 0) {
    showPenaltyStatus("Сначала выполните расчёт.", true);
    return;
  }

  const headers = ["Месяц", "Начислено", "Долг", "С", "По", "Дней", "Формула", "Пени"];
  const tsvRows = [headers.join("\t")];

  for (const block of lastCalculationBlocks) {
    block.rows.forEach((row, index) => {
      const monthCol = index === 0 ? block.start_date : "";
      const accruedCol = index === 0 ? block.initial_amount : "";
      if (row[0] === "debt") {
        const [, amount, from, to, days, formula, penaltyAmount] = row;
        tsvRows.push(
          [monthCol, accruedCol, amount, from, to, days, formula, penaltyAmount].join("\t"),
        );
      } else {
        const [, amount, paymentDate] = row;
        tsvRows.push(
          [monthCol, accruedCol, amount, paymentDate, "Погашение части долга", "", "", ""].join("\t"),
        );
      }
    });
    tsvRows.push(["", "", "", "", "", "", "Итого:", `${block.penalty_total} руб.`].join("\t"));
  }

  tsvRows.push(`Сумма основного долга: ${lastCalculationTotals.totalDebt} руб.`);
  tsvRows.push(`Сумма пеней по всем задолженностям: ${lastCalculationTotals.totalPenalty} руб.`);

  const html = buildPenaltyClipboardHtml(
    lastCalculationBlocks,
    lastCalculationTotals.totalDebt,
    lastCalculationTotals.totalPenalty,
  );
  const htmlBlob = new Blob([html], { type: "text/html" });
  const textBlob = new Blob([tsvRows.join("\n")], { type: "text/plain" });

  await navigator.clipboard.write([
    new ClipboardItem({ "text/html": htmlBlob, "text/plain": textBlob }),
  ]);
  showToast("Скопировано в буфер обмена");
}

/**
 * Строит самодостаточную HTML-таблицу для буфера обмена (со встроенными
 * стилями вместо CSS-классов страницы).
 *
 * При копировании в буфер обмена внешние приложения (Word, Outlook и др.)
 * не имеют доступа к странице, а значит и к её Tailwind-классам — только к
 * инлайн-стилям внутри самого HTML-фрагмента. Поэтому эта функция строит
 * таблицу заново с border/padding/text-align, заданными атрибутом style
 * на каждой ячейке, а не переиспользует DOM-элемент видимой таблицы.
 */
function buildPenaltyClipboardHtml(blocks, totalDebt, totalPenalty) {
  const tableStyle =
    "border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:12px;";
  const thStyle =
    "border:1px solid #999999;padding:4px 8px;background:#f3f4f6;text-align:center;";
  const tdStyle = "border:1px solid #999999;padding:4px 8px;";
  const tdRight = `${tdStyle}text-align:right;`;
  const tdCenter = `${tdStyle}text-align:center;`;
  const tdBoldRight = `${tdRight}font-weight:bold;`;

  const bodyRows = [];
  for (const block of blocks) {
    const rowCount = block.rows.length;

    block.rows.forEach((row, index) => {
      const spanCells = index === 0
        ? `<td style="${tdCenter}vertical-align:top;" rowspan="${rowCount}">${block.start_date}</td>
           <td style="${tdCenter}vertical-align:top;" rowspan="${rowCount}">${block.initial_amount}</td>`
        : "";

      if (row[0] === "debt") {
        const [, amount, from, to, days, formula, penaltyAmount] = row;
        bodyRows.push(`
          <tr>
            ${spanCells}
            <td style="${tdRight}">${amount}</td>
            <td style="${tdCenter}">${from}</td>
            <td style="${tdCenter}">${to}</td>
            <td style="${tdCenter}">${days}</td>
            <td style="${tdRight}">${formula}</td>
            <td style="${tdRight}">${penaltyAmount}</td>
          </tr>
        `);
      } else {
        const [, amount, paymentDate] = row;
        bodyRows.push(`
          <tr style="background:#fef3c7;">
            ${spanCells}
            <td style="${tdRight}">${amount}</td>
            <td style="${tdCenter}">${paymentDate}</td>
            <td style="${tdStyle}" colspan="3">Погашение части долга</td>
            <td style="${tdStyle}"></td>
          </tr>
        `);
      }
    });

    bodyRows.push(`
      <tr>
        <td style="${tdStyle}" colspan="6"></td>
        <td style="${tdBoldRight}">Итого:</td>
        <td style="${tdBoldRight}">${block.penalty_total} руб.</td>
      </tr>
    `);
  }

  bodyRows.push(`
    <tr><td style="${tdBoldRight}" colspan="8">Сумма основного долга: ${totalDebt} руб.</td></tr>
    <tr><td style="${tdBoldRight}" colspan="8">Сумма пеней по всем задолженностям: ${totalPenalty} руб.</td></tr>
  `);

  return `
    <table style="${tableStyle}">
      <thead>
        <tr>
          <th style="${thStyle}" rowspan="2">Месяц</th>
          <th style="${thStyle}" rowspan="2">Начислено</th>
          <th style="${thStyle}" rowspan="2">Долг</th>
          <th style="${thStyle}" colspan="3">Период просрочки</th>
          <th style="${thStyle}" rowspan="2">Формула</th>
          <th style="${thStyle}" rowspan="2">Пени</th>
        </tr>
        <tr>
          <th style="${thStyle}">с</th>
          <th style="${thStyle}">по</th>
          <th style="${thStyle}">дней</th>
        </tr>
      </thead>
      <tbody>${bodyRows.join("")}</tbody>
    </table>
  `;
}

/**
 * Обрабатывает нажатие кнопки «Загрузить из Excel».
 *
 * Открывает диалог выбора Excel-файла и запускает импорт.
 */
async function handleExcelImportViaDialog() {
  const path = await selectExcelFile();
  if (path) {
    await importPenaltyExcelFromPath(path);
  }
}

/**
 * Импортирует задолженности и платежи из Excel-файла по указанному пути.
 *
 * Запрашивает у бэкенда разбор долгов и платежей, очищает текущие строки
 * формы и заполняет их импортированными данными. Используется и кнопкой
 * «Загрузить из Excel», и перетаскиванием файла на зону импорта.
 */
async function importPenaltyExcelFromPath(path) {
  const button = document.getElementById("penalty-import-excel-button");
  setButtonBusy(button, true, "Импорт…");
  try {
    const result = await requestPenaltyExcelImport(path);
    fillImportedRows("penalty-debts-container", "debt", result.debts, "start_date");
    fillImportedRows("penalty-payments-container", "payment", result.payments, "date");
    showPenaltyStatus(
      `✅ Импортировано: ${result.debts.length} задолж., ${result.payments.length} платеж.`,
      false,
    );
  } catch (error) {
    showPenaltyStatus(`Ошибка импорта: ${error.message}`, true);
  } finally {
    setButtonBusy(button, false);
  }
}

/**
 * Сбрасывает форму расчёта неустойки к значениям по умолчанию.
 *
 * Очищает строки долгов и платежей (оставляя одну пустую строку долга),
 * поля периода/ставки/капинга и результат расчёта.
 */
function clearPenaltyForm() {
  document.getElementById("penalty-debts-container").innerHTML = "";
  document.getElementById("penalty-payments-container").innerHTML = "";
  setDateFieldValue("penalty-period-end", "");
  document.getElementById("penalty-rate").value = "0.1";
  document.getElementById("penalty-rate-type").value = "day";
  document.getElementById("penalty-cap").value = "";

  lastCalculationBlocks = [];
  lastCalculationTotals = { totalDebt: "", totalPenalty: "" };
  document.getElementById("penalty-cap-warning").textContent = "";
  document.getElementById("penalty-result-table-body").innerHTML = "";
  showPenaltyStatus("Введите данные и нажмите «Рассчитать»", false);

  addDebtRow();
}

/**
 * Заменяет строки контейнера импортированными данными.
 *
 * Очищает контейнер и создаёт по одной строке на каждый импортированный
 * элемент, подставляя сумму и дату.
 */
function fillImportedRows(containerId, rowType, items, dateFieldName) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  for (const item of items) {
    container.appendChild(
      buildAmountDateRow(rowType, item.amount, item[dateFieldName]),
    );
  }
}
