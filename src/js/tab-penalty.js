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
// Строки последнего расчёта по ст. 395 (единая таблица) для копирования.
let last395Rows = [];
// Текущий тип неустойки: "contractual" | "statutory_395".
let currentPenaltyType = "contractual";

// Заголовки таблицы результата для двух режимов (переключаются в thead).
const THEAD_CONTRACTUAL = `
  <tr class="text-center text-slate-500 border-b border-slate-200">
    <th class="py-1 px-2" rowspan="2">Месяц</th>
    <th class="py-1 px-2" rowspan="2">Начислено</th>
    <th class="py-1 px-2" rowspan="2">Долг</th>
    <th class="py-1 px-2" colspan="3">Период просрочки</th>
    <th class="py-1 px-2" rowspan="2">Формула</th>
    <th class="py-1 px-2" rowspan="2">Пени</th>
  </tr>
  <tr class="text-center text-slate-500 border-b border-slate-200">
    <th class="py-1 px-2">с</th>
    <th class="py-1 px-2">по</th>
    <th class="py-1 px-2">дней</th>
  </tr>`;
const THEAD_395 = `
  <tr class="text-center text-slate-500 border-b border-slate-200">
    <th class="py-1 px-2" rowspan="2">Задолженность</th>
    <th class="py-1 px-2" colspan="3">Период просрочки</th>
    <th class="py-1 px-2" rowspan="2">Ставка</th>
    <th class="py-1 px-2" rowspan="2">Формула</th>
    <th class="py-1 px-2" rowspan="2">Проценты</th>
  </tr>
  <tr class="text-center text-slate-500 border-b border-slate-200">
    <th class="py-1 px-2">с</th>
    <th class="py-1 px-2">по</th>
    <th class="py-1 px-2">дней</th>
  </tr>`;

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

  document.querySelectorAll("#penalty-type-toggle .penalty-type-option").forEach((button) => {
    button.addEventListener("click", () => setPenaltyType(button.dataset.penaltyType));
  });
  setPenaltyType("contractual");

  addDebtRow();
}

/**
 * Переключает тип неустойки (договорная / ст. 395 ГК РФ).
 *
 * Обновляет подсветку кнопок сегмент-контрола, показывает или скрывает поля
 * ставки и информационный блок, а также заголовок таблицы результата.
 */
function setPenaltyType(type) {
  currentPenaltyType = type;

  document.querySelectorAll("#penalty-type-toggle .penalty-type-option").forEach((button) => {
    const active = button.dataset.penaltyType === type;
    button.classList.toggle("bg-blue-600", active);
    button.classList.toggle("text-oncolor", active);
    button.classList.toggle("bg-white", !active);
    button.classList.toggle("text-slate-600", !active);
    button.classList.toggle("hover:bg-slate-50", !active);
  });

  const is395 = type === "statutory_395";
  document.getElementById("penalty-contractual-fields").classList.toggle("hidden", is395);
  document.getElementById("penalty-395-info").classList.toggle("hidden", !is395);
  document.getElementById("penalty-result-thead").innerHTML = is395
    ? THEAD_395
    : THEAD_CONTRACTUAL;
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
  // min-w-0 — чтобы поле суммы могло ужиматься при узком окне; иначе flex-1 с
  // авто-минимумом распирает строку и кнопка удаления «✕» уезжает за край.
  amountInput.className =
    "row-amount flex-1 min-w-0 px-3 py-2 border border-slate-300 rounded-lg text-sm";

  const dateField = createDateField({ extraHiddenClass: "row-date", value: dateValue });
  dateField.classList.add("w-36", "flex-shrink-0");

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  // shrink-0 — кнопка удаления всегда видна целиком, не сжимается и не режется.
  removeButton.className = "row-remove shrink-0 px-2 text-slate-400 hover:text-red-500";
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
        currentPenaltyType,
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
  const is395 = result.mode === "statutory_395";
  lastCalculationBlocks = result.blocks || [];
  last395Rows = result.rows_395 || [];
  lastCalculationTotals = {
    totalDebt: result.total_debt,
    totalPenalty: result.total_penalty,
    mode: result.mode,
  };

  // Заголовок таблицы соответствует режиму (на случай, если данные пришли
  // асинхронно после переключения — приводим thead к фактическому режиму).
  document.getElementById("penalty-result-thead").innerHTML = is395
    ? THEAD_395
    : THEAD_CONTRACTUAL;

  document.getElementById("penalty-cap-warning").textContent = result.cap_info
    ? `Неустойка ограничена ${result.cap_info.cap_percent}% от суммы долга ` +
      `(без ограничения было бы ${result.cap_info.uncapped_total} ₽).`
    : "";

  document.getElementById("penalty-result-table-body").innerHTML = is395
    ? build395TableRows(result.rows_395, result.total_debt, result.total_penalty)
    : buildPenaltyTableRows(result.blocks, result.total_debt, result.total_penalty);

  if (result.warnings.length) {
    showPenaltyStatus(result.warnings.join(" "), true);
  } else {
    showPenaltyStatus("✅ Расчёт выполнен.", false);
  }
}

/**
 * Строит строки единой таблицы расчёта по ст. 395 ГК РФ.
 *
 * Строки начисления процентов чередуются со строками-событиями (новая
 * задолженность / погашение части долга), в конце — две итоговые строки.
 */
function build395TableRows(rows, totalDebt, totalPenalty) {
  const html = [];
  for (const row of rows) {
    if (row.type === "interest") {
      html.push(`
        <tr class="border-b border-slate-100">
          <td class="py-1 px-2 text-right">${row.debt}</td>
          <td class="py-1 px-2 text-center">${row.from}</td>
          <td class="py-1 px-2 text-center">${row.to}</td>
          <td class="py-1 px-2 text-center">${row.days}</td>
          <td class="py-1 px-2 text-center">${row.rate}</td>
          <td class="py-1 px-2 text-right">${row.formula}</td>
          <td class="py-1 px-2 text-right">${row.interest}</td>
        </tr>
      `);
    } else {
      const isDebt = row.type === "debt";
      const label = isDebt ? "Новая задолженность" : "Погашение части долга";
      const rowClass = isDebt ? "bg-emerald-50" : "bg-amber-50";
      html.push(`
        <tr class="border-b border-slate-100 ${rowClass} text-slate-600">
          <td class="py-1 px-2 text-right">${row.amount}</td>
          <td class="py-1 px-2 text-center">${row.date}</td>
          <td class="py-1 px-2" colspan="5">${label}</td>
        </tr>
      `);
    }
  }

  html.push(`
    <tr>
      <td colspan="7" class="py-1 px-2 text-right font-semibold">
        Сумма основного долга: ${totalDebt} руб.
      </td>
    </tr>
    <tr>
      <td colspan="7" class="py-1 px-2 text-right font-semibold">
        Сумма процентов: ${totalPenalty} руб.
      </td>
    </tr>
  `);

  return html.join("");
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
  if (lastCalculationTotals.mode === "statutory_395") {
    await copy395TableToClipboard();
    return;
  }
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
 * Копирует единую таблицу расчёта по ст. 395 ГК РФ в буфер обмена.
 *
 * Готовит и HTML (форматированная таблица для Word/Excel), и TSV (обычный
 * текст) из строк последнего расчёта по ст. 395.
 */
async function copy395TableToClipboard() {
  if (last395Rows.length === 0) {
    showPenaltyStatus("Сначала выполните расчёт.", true);
    return;
  }

  const headers = ["Задолженность", "С", "По", "Дней", "Ставка", "Формула", "Проценты"];
  const tsvRows = [headers.join("\t")];
  for (const row of last395Rows) {
    if (row.type === "interest") {
      tsvRows.push(
        [row.debt, row.from, row.to, row.days, row.rate, row.formula, row.interest].join("\t"),
      );
    } else {
      const label = row.type === "debt" ? "Новая задолженность" : "Погашение части долга";
      tsvRows.push([row.amount, row.date, label, "", "", "", ""].join("\t"));
    }
  }
  tsvRows.push(`Сумма основного долга: ${lastCalculationTotals.totalDebt} руб.`);
  tsvRows.push(`Сумма процентов: ${lastCalculationTotals.totalPenalty} руб.`);

  const html = build395ClipboardHtml(
    last395Rows,
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
 * Строит самодостаточную HTML-таблицу расчёта по ст. 395 для буфера обмена.
 */
function build395ClipboardHtml(rows, totalDebt, totalPenalty) {
  const tableStyle =
    "border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:12px;";
  const thStyle =
    "border:1px solid #999999;padding:4px 8px;background:#f3f4f6;text-align:center;";
  const tdStyle = "border:1px solid #999999;padding:4px 8px;";
  const tdRight = `${tdStyle}text-align:right;`;
  const tdCenter = `${tdStyle}text-align:center;`;
  const tdBoldRight = `${tdRight}font-weight:bold;`;

  const bodyRows = [];
  for (const row of rows) {
    if (row.type === "interest") {
      bodyRows.push(`
        <tr>
          <td style="${tdRight}">${row.debt}</td>
          <td style="${tdCenter}">${row.from}</td>
          <td style="${tdCenter}">${row.to}</td>
          <td style="${tdCenter}">${row.days}</td>
          <td style="${tdCenter}">${row.rate}</td>
          <td style="${tdRight}">${row.formula}</td>
          <td style="${tdRight}">${row.interest}</td>
        </tr>
      `);
    } else {
      const label = row.type === "debt" ? "Новая задолженность" : "Погашение части долга";
      const bg = row.type === "debt" ? "#d1fae5" : "#fef3c7";
      bodyRows.push(`
        <tr style="background:${bg};">
          <td style="${tdRight}">${row.amount}</td>
          <td style="${tdCenter}">${row.date}</td>
          <td style="${tdStyle}" colspan="5">${label}</td>
        </tr>
      `);
    }
  }
  bodyRows.push(`
    <tr><td style="${tdBoldRight}" colspan="7">Сумма основного долга: ${totalDebt} руб.</td></tr>
    <tr><td style="${tdBoldRight}" colspan="7">Сумма процентов: ${totalPenalty} руб.</td></tr>
  `);

  return `
    <table style="${tableStyle}">
      <thead>
        <tr>
          <th style="${thStyle}" rowspan="2">Задолженность</th>
          <th style="${thStyle}" colspan="3">Период просрочки</th>
          <th style="${thStyle}" rowspan="2">Ставка</th>
          <th style="${thStyle}" rowspan="2">Формула</th>
          <th style="${thStyle}" rowspan="2">Проценты</th>
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
  last395Rows = [];
  lastCalculationTotals = { totalDebt: "", totalPenalty: "" };
  setPenaltyType("contractual");
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
