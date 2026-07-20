// tab-dashboard.js
// Вкладка «Дашборд» — аналитика по реестру судебных дел из Google-таблицы.
//
// Отвечает только за свою вкладку: читает настройки доступа, просит у бэкенда
// посчитанные показатели и рисует их карточками и графиками (Chart.js).
// Считает показатели не она — это делает слой логики; здесь только отрисовка.
//
// Данные грузятся один раз (при первом открытии вкладки и по кнопке
// «Обновить»), а переключение между общим обзором и экраном года идёт по уже
// загруженным данным — без повторного обращения к Google.

import { requestDashboardData } from "./backend-api.js";
import { loadSheetsSettings, saveSheetsSettings } from "./sheets-settings-store.js";
import { selectJsonKeyFile } from "./file-dialogs.js";
import { formatAmountAsRubles } from "./formatting.js";
import { withButtonBusy } from "./loading-button.js";

// Таблица с реестром судебных дел по умолчанию. Подставляется в поле настроек,
// если оно ещё не заполнено, — вводить длинный идентификатор руками не нужно.
// Значение можно поменять в поле: сохранённая настройка всегда важнее этой.
const DEFAULT_SPREADSHEET_ID = "1vYiCw-uciX63FizN8XELikp9xE_laj8Rq9dTfhSOE4Q";

// Цвет несёт смысл: погашенный долг — зелёный, процесс — синий, банкротство —
// янтарный (деньги под угрозой), проблемы с данными — серый и красный. Ключи —
// это стадии из реестра, как их возвращает бэкенд.
const STAGE_COLORS = {
  "подготовка иска": "#38bdf8",
  "процесс": "#2563eb",
  "исполнительное пр-во": "#8b5cf6",
  "банкротство": "#f59e0b",
  "долг погашен": "#16a34a",
  // Списанный долг — красный: это не этап, а потерянные деньги.
  "невозвратная задолженность": "#dc2626",
  // Категории про качество данных — серые: они про реестр, а не про процесс.
  "Статус не указан": "#cbd5e1",
  "Статус не распознан": "#94a3b8",
};
const DEFAULT_COLOR = "#2563eb";
const STRUCTURE_COLORS = ["#2563eb", "#f59e0b", "#94a3b8"];

// Прозрачность светлого тона стадии (~30%): им закрашен невзысканный остаток в
// столбце сумм. Тон берётся от цвета самой стадии, а не задаётся отдельной
// палитрой, — иначе цвета пришлось бы держать в паре и синхронизировать руками.
const LIGHT_TONE_ALPHA = "4d";

const CHART_ANIMATION_MS = 400;

// Сколько строк топа видно до нажатия «Показать все».
const TOP_DEBTORS_COLLAPSED = 3;

// Загруженные данные и состояние экрана. selectedYear === null — общий обзор.
let dashboardData = null;
let selectedYear = null;
let hasLoadedOnce = false;

// Живые экземпляры Chart.js по id канваса: перед перерисовкой старый график
// нужно уничтожить, иначе Chart.js ругается на занятый канвас.
const charts = {};

/**
 * Инициализирует вкладку дашборда.
 *
 * Вешает обработчики на управление и подтягивает сохранённые настройки
 * доступа. Данные не грузятся сразу: загрузка идёт при первом открытии
 * вкладки, чтобы запуск приложения не ждал ответа Google.
 */
export function initDashboardTab() {
  document
    .getElementById("dashboard-refresh-button")
    .addEventListener("click", () => loadDashboard({ force: true }));
  document
    .getElementById("dashboard-pdf-button")
    .addEventListener("click", exportDashboardToPdf);
  document
    .getElementById("dashboard-settings-button")
    .addEventListener("click", toggleSettingsPanel);
  document
    .getElementById("dashboard-settings-save-button")
    .addEventListener("click", saveSettingsAndReload);
  document
    .getElementById("dashboard-credentials-button")
    .addEventListener("click", chooseCredentialsFile);
  document
    .getElementById("dashboard-back-button")
    .addEventListener("click", () => selectYear(null));
  document
    .getElementById("dashboard-year-filter")
    .addEventListener("change", (event) => selectYear(event.target.value || null));

  // Вкладка сама решает, когда ей грузиться: навигация о содержимом вкладок
  // не знает и знать не должна.
  document
    .querySelector('[data-tab-target="panel-dashboard"]')
    .addEventListener("click", () => loadDashboard({ force: false }));

  // Перед печатью canvas графиков нужно пересчитать под ширину печатной
  // страницы: свой пиксельный размер он взял от окна приложения (оно шире A4),
  // и без пересчёта графики в PDF уезжают вправо и обрезаются. После печати —
  // обратно под экран.
  window.addEventListener("beforeprint", resizeAllCharts);
  window.addEventListener("afterprint", resizeAllCharts);

  fillSettingsFields();
}

/**
 * Пересчитывает размеры всех живых графиков под текущую ширину контейнеров.
 */
function resizeAllCharts() {
  Object.values(charts).forEach((chart) => chart.resize());
}

// ── Загрузка данных ─────────────────────────────────────────────────────────

/**
 * Загружает показатели из таблицы и перерисовывает дашборд.
 *
 * Без force повторная загрузка не делается: данные уже в памяти, а
 * переключение годов идёт по ним. Если доступ ещё не настроен, вместо ошибки
 * показывается приглашение открыть настройки.
 */
async function loadDashboard({ force }) {
  if (hasLoadedOnce && !force) {
    return;
  }

  const settings = await loadSheetsSettings();
  if (!settings.credentialsPath || !settings.spreadsheetId) {
    showSettingsInvitation();
    return;
  }

  showLoading();
  const button = document.getElementById("dashboard-refresh-button");

  try {
    await withButtonBusy(button, "Загрузка…", async () => {
      dashboardData = await requestDashboardData(
        settings.credentialsPath,
        settings.spreadsheetId,
      );
    });
    hasLoadedOnce = true;
    selectedYear = null;
    fillYearFilter();
    showUpdatedAt();
    render();
  } catch (error) {
    showError(error.message);
  }
}

// ── Переключение экранов: общий обзор ↔ год ─────────────────────────────────

/**
 * Переключает экран на конкретный год или обратно на общий обзор.
 *
 * Данные не перезапрашиваются — фильтрация идёт по уже загруженным
 * показателям, поэтому переключение мгновенное.
 */
function selectYear(year) {
  selectedYear = year;
  document.getElementById("dashboard-year-filter").value = year || "";
  render();
}

/**
 * Возвращает секцию показателей для текущего экрана.
 *
 * Общий обзор — сводные показатели по всем годам; экран года — показатели
 * только этого года (их посчитал бэкенд, здесь ничего не пересчитывается).
 */
function currentCasesSection() {
  if (selectedYear === null) {
    return dashboardData.cases.overall;
  }
  return dashboardData.cases.by_year[selectedYear] || emptySection();
}

/**
 * Пустая секция — на случай, если выбранного года в данных не оказалось.
 */
function emptySection() {
  return {
    kpi: {
      cases_count: 0,
      claimed_total: 0,
      recovered_total: 0,
      recovery_percent: null,
      recovery_percent_principal: null,
      average_review_days: null,
      review_cases_count: 0,
      average_prep_days: null,
      prep_cases_count: 0,
    },
    funnel: [],
    claim_structure: { principal: 0, penalty: 0, court_costs: 0 },
    top_debtors: [],
    courts: [],
  };
}

// ── Отрисовка ───────────────────────────────────────────────────────────────

/**
 * Перерисовывает весь дашборд под текущий экран.
 *
 * Блоки, которые имеют смысл только в общем обзоре (динамика по годам и
 * карточки годов), на экране года скрываются.
 */
function render() {
  const section = currentCasesSection();
  const isOverview = selectedYear === null;

  document.getElementById("dashboard-state").innerHTML = "";
  document.getElementById("dashboard-content").classList.remove("hidden");
  document.getElementById("dashboard-back-button").classList.toggle("hidden", isOverview);

  const period = isOverview ? "все годы" : `${selectedYear} год`;
  document.getElementById("dashboard-title").textContent = `Судебные дела · ${period}`;
  document.getElementById("dashboard-print-meta").textContent =
    `Период: ${period} · Сформирован ${new Date().toLocaleDateString("ru-RU")}`;

  renderKpi(section.kpi);
  renderFunnel(section.funnel);
  renderStageAmounts(section.funnel);
  renderStructure(section.claim_structure);
  renderTopDebtors(section.top_debtors);
  renderCourts(section.courts);

  document.getElementById("dashboard-dynamics-card").classList.toggle("hidden", !isOverview);
  document.getElementById("dashboard-year-cards-block").classList.toggle("hidden", !isOverview);
  if (isOverview) {
    renderDynamics(dashboardData.cases.dynamics);
    renderYearCards(dashboardData.cases.dynamics);
  }

  renderBankruptcy(currentBankruptcySection());
  document.getElementById("bankruptcy-dynamics-card").classList.toggle("hidden", !isOverview);
  if (isOverview) {
    renderBankruptcyDynamics(dashboardData.bankruptcy.dynamics);
  }

  renderClaims(dashboardData.claims, isOverview);
  renderWarnings(dashboardData.warnings);

  playAppearAnimation();
}

/**
 * Заполняет плитки ключевых показателей.
 *
 * Числа набираются плавно — это единственная анимация, которая касается
 * значений, и она не повторяется при наведении.
 */
function renderKpi(kpi) {
  animateNumber("kpi-cases-count", kpi.cases_count, (value) =>
    Math.round(value).toLocaleString("ru-RU"),
  );
  animateNumber("kpi-claimed-total", kpi.claimed_total, formatMoney);
  animateNumber("kpi-recovered-total", kpi.recovered_total, formatMoney);

  // Требований нет — процента взыскания не существует. Прочерк вместо деления
  // на ноль (и вместо «NaN%»).
  const percentElement = document.getElementById("kpi-recovery-percent");
  if (kpi.recovery_percent === null) {
    percentElement.textContent = "—";
  } else {
    animateNumber("kpi-recovery-percent", kpi.recovery_percent, (value) =>
      `${value.toFixed(1).replace(".", ",")} %`,
    );
  }

  // Вторая строка — процент к основному долгу. Основного долга нет (все
  // требования — только неустойка/расходы) — строку прячем, а не пишем прочерк.
  const principalElement = document.getElementById("kpi-recovery-percent-principal");
  if (kpi.recovery_percent_principal === null) {
    principalElement.innerHTML = "&nbsp;";
  } else {
    // Значение — из числа, поэтому в innerHTML попадают только цифры (без риска
    // разметки). Процент — чёрным (как основной показатель), текст — серым.
    const principalPercent = kpi.recovery_percent_principal.toFixed(1).replace(".", ",");
    principalElement.innerHTML = `<span class="text-slate-900">${principalPercent} %</span> к основному долгу`;
  }

  renderAverageReviewTerm(kpi);
}

/**
 * Показывает два срока: общий (от «В работе» до решения) и срок подготовки иска
 * (от «В работе» до передачи в суд).
 *
 * Общий срок — крупным числом, срок подготовки — мелкой строкой под ним, как в
 * плитке «Процент взыскания». Каждый показатель считается по своей выборке дел
 * с нужными датами; если считать не из чего — прочерк / пустая строка.
 */
function renderAverageReviewTerm(kpi) {
  // Сравнение через == null ловит и null (срок посчитать не из чего), и
  // undefined (бэкенд старой версии, который поля ещё не отдаёт): вкладка
  // покажет прочерк, а не упадёт.
  if (kpi.average_review_days == null) {
    document.getElementById("kpi-average-review").textContent = "—";
  } else {
    animateNumber("kpi-average-review", kpi.average_review_days, (value) =>
      pluralize(Math.round(value), "день", "дня", "дней"),
    );
  }

  const prepElement = document.getElementById("kpi-average-prep");
  if (kpi.average_prep_days == null) {
    prepElement.innerHTML = "&nbsp;";
  } else {
    // pluralize возвращает «20 дней» — только цифры и текст, в innerHTML
    // безопасно. Число — чёрным (как основной показатель), подпись — серым.
    const prep = pluralize(Math.round(kpi.average_prep_days), "день", "дня", "дней");
    prepElement.innerHTML = `<span class="text-slate-900">${prep}</span> — срок подготовки иска`;
  }
}

/**
 * Рисует воронку по стадиям: сколько дел на каждой стадии.
 *
 * Горизонтальные столбцы в порядке процесса — видно, где скапливаются дела.
 */
function renderFunnel(funnel) {
  const options = baseChartOptions();
  // У стадии «долг погашен» бэкенд отдаёт разбивку: вернули до суда или взыскали
  // по исполнительному листу. В столбце это одно число, а в подсказке — детали.
  options.plugins.tooltip.callbacks.afterBody = (items) => {
    const stage = funnel[items[0].dataIndex];
    if (!stage || !stage.breakdown) {
      return "";
    }
    return stage.breakdown.map((item) => `${item.name}: ${item.count}`);
  };

  renderChart("chart-funnel", funnel.length > 0, {
    type: "bar",
    data: {
      labels: funnel.map((stage) => capitalize(stage.stage)),
      datasets: [{
        label: "Дел",
        data: funnel.map((stage) => stage.count),
        backgroundColor: funnel.map((stage) => STAGE_COLORS[stage.stage] || DEFAULT_COLOR),
        borderRadius: 6,
      }],
    },
    options: {
      indexAxis: "y",
      ...options,
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 } },
        y: { grid: { display: false } },
      },
    },
  });
}

/**
 * Рисует суммы требований по стадиям — сколько денег «стоит» каждая стадия.
 *
 * Столбец стадии составной: насыщенным цветом снизу — уже взысканное, светлым
 * сверху — остаток до заявленного. Так на одном столбце видно и сколько
 * требовали, и сколько из этого вернулось. Высота столбца — заявленная сумма.
 */
function renderStageAmounts(funnel) {
  const hasMoney = funnel.some((stage) => stage.claimed > 0 || stage.recovered > 0);
  const options = baseChartOptions();
  options.plugins.tooltip.callbacks = { label: stageAmountTooltipLabel(funnel) };

  renderChart("chart-stage-amounts", hasMoney, {
    type: "bar",
    data: {
      labels: funnel.map((stage) => capitalize(stage.stage)),
      datasets: [
        {
          label: "Фактически взыскано",
          data: funnel.map((stage) => stage.recovered),
          backgroundColor: funnel.map((stage) => stageColor(stage)),
        },
        {
          label: "Заявлено",
          data: funnel.map((stage) => outstandingAmount(stage)),
          backgroundColor: funnel.map((stage) => `${stageColor(stage)}${LIGHT_TONE_ALPHA}`),
          borderRadius: 6,
        },
      ],
    },
    options: {
      ...options,
      // Подсказка отвечает за сегмент под курсором, а не за весь столбец: у
      // составного столбца две части, и у каждой своя сумма.
      interaction: { mode: "nearest", intersect: true },
      // Запас справа под последнюю скошенную подпись оси («Статус не указан») —
      // без него она вылезала за область графика и обрезалась при печати.
      layout: { padding: { right: 16 } },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: { autoSkip: false, maxRotation: 40, minRotation: 0 },
        },
        y: { stacked: true, beginAtZero: true, ticks: { callback: formatAxisMoney } },
      },
    },
  });
}

/**
 * Цвет стадии — насыщенный тон для взысканной части столбца.
 */
function stageColor(stage) {
  return STAGE_COLORS[stage.stage] || DEFAULT_COLOR;
}

/**
 * Считает невзысканный остаток стадии — светлую часть столбца.
 *
 * Взысканное может превысить заявленное: в реестре встречается заполненное
 * «Взыскано» при пустой «Сумме». Остаток тогда нулевой, и столбец вырастает до
 * взысканного — аномалия видна, а не спрятана за отрицательной высотой.
 */
function outstandingAmount(stage) {
  return Math.max(stage.claimed - stage.recovered, 0);
}

/**
 * Собирает подсказку для составного столбца стадии.
 *
 * Величины берутся из воронки, а не из высоты сегмента: у светлой части высота
 * — это остаток до заявленного, а показать нужно всю заявленную сумму.
 */
function stageAmountTooltipLabel(funnel) {
  return (context) => {
    const stage = funnel[context.dataIndex];
    const isRecovered = context.datasetIndex === 0;
    const value = isRecovered ? stage.recovered : stage.claimed;
    return `${context.dataset.label}: ${formatAmountAsRubles(value)} ₽`;
  };
}

/**
 * Рисует структуру требований: доли ОСВ, неустойки и судебных расходов.
 */
function renderStructure(structure) {
  const values = [structure.principal, structure.penalty, structure.court_costs];
  renderChart("chart-structure", values.some((value) => value > 0), {
    type: "doughnut",
    data: {
      labels: ["ПДЗ (основной долг)", "Неустойка", "Судебные расходы"],
      datasets: [{
        data: values,
        backgroundColor: STRUCTURE_COLORS,
        borderWidth: 0,
        // Сектор под курсором выдвигается и слегка растёт — видно, о какой
        // части требований подсказка.
        hoverOffset: 14,
        hoverBorderWidth: 0,
      }],
    },
    options: {
      ...baseChartOptions({ moneyTooltip: true, legend: true }),
      // Запас вокруг кольца под выдвижение сектора (hoverOffset): без него
      // выехавший сектор обрезался бы верхним краем области графика.
      layout: { padding: 18 },
    },
  });
}

/**
 * Рисует динамику по годам: дела, требования и взыскания год к году.
 *
 * Количество дел вынесено на вторую ось: иначе столбик в десяток дел не виден
 * рядом с миллионами рублей.
 */
function renderDynamics(dynamics) {
  const byYearAscending = [...dynamics].reverse();
  renderChart("chart-dynamics", byYearAscending.length > 0, {
    type: "bar",
    data: {
      labels: byYearAscending.map((year) => year.year),
      datasets: [
        {
          label: "Требования",
          data: byYearAscending.map((year) => year.claimed),
          backgroundColor: "#2563eb",
          borderRadius: 6,
          yAxisID: "y",
          // Столбцы — на заднем плане. Chart.js рисует датасеты от большего
          // order к меньшему, поэтому больший order оказывается ниже.
          order: 2,
        },
        {
          label: "Взыскано",
          data: byYearAscending.map((year) => year.recovered),
          backgroundColor: "#16a34a",
          borderRadius: 6,
          yAxisID: "y",
          order: 2,
        },
        {
          label: "Дел",
          // Не деньги: в подсказке показывается просто число, без рублей.
          isMoney: false,
          data: byYearAscending.map((year) => year.cases_count),
          type: "line",
          borderColor: "#0f172a",
          backgroundColor: "#0f172a",
          tension: 0.3,
          yAxisID: "yCount",
          // Меньший order — кривую рисует последней, поверх столбцов.
          order: 1,
        },
      ],
    },
    options: {
      ...baseChartOptions({ moneyTooltip: true, legend: true }),
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { callback: formatAxisMoney } },
        yCount: {
          beginAtZero: true,
          position: "right",
          grid: { display: false },
          ticks: { precision: 0 },
        },
      },
    },
  });
}

/**
 * Рисует распределение дел по судам.
 */
function renderCourts(courts) {
  renderChart("chart-courts", courts.length > 0, {
    type: "bar",
    data: {
      labels: courts.map((court) => court.name),
      datasets: [{
        label: "Дел",
        data: courts.map((court) => court.count),
        backgroundColor: DEFAULT_COLOR,
        borderRadius: 6,
      }],
    },
    options: {
      indexAxis: "y",
      ...baseChartOptions(),
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 } },
        // autoSkip: false — иначе Chart.js при большом числе судов прореживает
        // подписи оси, и у части полос название пропадает.
        y: { grid: { display: false }, ticks: { autoSkip: false } },
      },
    },
  });
}

/**
 * Заполняет таблицу крупнейших дел по сумме требований.
 */
function renderTopDebtors(topDebtors) {
  renderTopTable(
    "dashboard-top-debtors",
    "dashboard-top-debtors-toggle",
    topDebtors,
    (row) => `
      <td>${escapeHtml(row.debtor)}</td>
      <td>${escapeHtml(row.inn) || "—"}</td>
      <td>${escapeHtml(row.case_number) || "—"}</td>
      <td class="dash-num">${formatAmountAsRubles(row.claimed)}</td>
      <td>${escapeHtml(capitalize(row.status))}</td>`,
    5,
  );
}

/**
 * Заполняет таблицу топа: видны первые три места, остальные — по кнопке.
 *
 * Три строки держат карточку компактной, но полный топ-10 всегда под рукой.
 * Кнопка появляется, только если разворачивать действительно есть что.
 */
function renderTopTable(bodyId, toggleId, rows, renderCells, columnCount) {
  const body = document.getElementById(bodyId);
  const toggle = document.getElementById(toggleId);

  if (rows.length === 0) {
    body.innerHTML = emptyTableRow(columnCount);
    toggle.classList.add("hidden");
    return;
  }

  body.innerHTML = rows
    .map((row, index) => {
      const collapsed = index >= TOP_DEBTORS_COLLAPSED ? " class=\"dash-row-collapsed\"" : "";
      return `<tr${collapsed}>${renderCells(row)}</tr>`;
    })
    .join("");

  const hiddenCount = rows.length - TOP_DEBTORS_COLLAPSED;
  toggle.classList.toggle("hidden", hiddenCount <= 0);
  if (hiddenCount <= 0) {
    return;
  }

  // Каждая отрисовка (в том числе переход в год) начинается со свёрнутого
  // состояния, поэтому текст кнопки и обработчик задаются заново.
  toggle.textContent = `Показать все ${rows.length} ↓`;
  toggle.dataset.expanded = "false";
  toggle.onclick = () => toggleTopRows(body, toggle, rows.length);
}

/**
 * Разворачивает или сворачивает скрытые строки топа с плавной анимацией.
 *
 * При раскрытии строки сразу становятся видимыми и проявляются анимацией. При
 * сворачивании сначала проигрывается исчезновение, и только по его завершении
 * строка прячется (display:none) — иначе она пропала бы рывком.
 */
function toggleTopRows(body, toggle, totalRows) {
  const expanded = toggle.dataset.expanded === "true";
  const extraRows = Array.from(body.querySelectorAll("tr")).slice(TOP_DEBTORS_COLLAPSED);

  extraRows.forEach((row) => {
    row.classList.remove("dash-row-showing", "dash-row-hiding");

    if (expanded) {
      row.classList.add("dash-row-hiding");
      row.addEventListener("animationend", () => {
        row.classList.add("dash-row-collapsed");
        row.classList.remove("dash-row-hiding");
      }, { once: true });
    } else {
      row.classList.remove("dash-row-collapsed");
      row.classList.add("dash-row-showing");
      row.addEventListener("animationend", () => {
        row.classList.remove("dash-row-showing");
      }, { once: true });
    }
  });

  toggle.dataset.expanded = expanded ? "false" : "true";
  toggle.textContent = expanded ? `Показать все ${totalRows} ↓` : "Свернуть ↑";
}

/**
 * Выбирает секцию «Банкротство» под текущий экран.
 *
 * Как и судебная часть, банкротство разбито по годам: в общем обзоре — все
 * дела, на экране года — дела этого года (год берётся из номера дела). Если у
 * выбранного года банкротных дел нет — пустая секция с прочерками.
 */
function currentBankruptcySection() {
  const bankruptcy = dashboardData.bankruptcy;
  if (selectedYear === null) {
    return bankruptcy.overall;
  }
  return bankruptcy.by_year[selectedYear] || emptyBankruptcySection();
}

/**
 * Пустая секция «Банкротство» — на случай года без банкротных дел.
 */
function emptyBankruptcySection() {
  return {
    kpi: { cases_count: 0, claimed_total: 0 },
    conversion: emptyConversion(),
    stages: [],
    courts: [],
    top_debtors: [],
  };
}

/**
 * Пустые показатели конверсии — прочерк вместо чисел.
 */
function emptyConversion() {
  return { debtors_percent: null, amount_percent: null };
}

/**
 * Рисует секцию «Банкротство»: показатели, стадии и топ должников.
 *
 * Секция реагирует на выбранный год — принимает уже отобранный набор (общий
 * обзор или один год). Динамика по годам сюда не входит: она кросс-годовая и
 * рисуется отдельно, только в общем обзоре.
 */
function renderBankruptcy(section) {
  animateNumber("kpi-bankruptcy-count", section.kpi.cases_count, (value) =>
    Math.round(value).toLocaleString("ru-RU"),
  );
  animateNumber("kpi-bankruptcy-total", section.kpi.claimed_total, formatMoney);

  renderBankruptcyConversion(section.conversion);

  renderChart("chart-bankruptcy-stages", section.stages.length > 0, {
    type: "bar",
    data: {
      labels: section.stages.map((stage) => stage.name),
      datasets: [{
        label: "Дел",
        data: section.stages.map((stage) => stage.count),
        backgroundColor: "#8b5cf6",
        borderRadius: 6,
      }],
    },
    options: {
      indexAxis: "y",
      ...baseChartOptions(),
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 } },
        y: { grid: { display: false } },
      },
    },
  });

  renderChart("chart-bankruptcy-courts", section.courts.length > 0, {
    type: "bar",
    data: {
      labels: section.courts.map((court) => court.name),
      datasets: [{
        label: "Дел",
        data: section.courts.map((court) => court.count),
        backgroundColor: "#8b5cf6",
        borderRadius: 6,
      }],
    },
    options: {
      indexAxis: "y",
      ...baseChartOptions(),
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 } },
        // autoSkip: false — показываем название каждого суда, даже когда их много.
        y: { grid: { display: false }, ticks: { autoSkip: false } },
      },
    },
  });

  renderTopTable(
    "dashboard-bankruptcy-debtors",
    "dashboard-bankruptcy-debtors-toggle",
    section.top_debtors,
    (row) => `
      <td>${escapeHtml(row.debtor)}</td>
      <td>${escapeHtml(row.case_number) || "—"}</td>
      <td>${escapeHtml(row.court) || "—"}</td>
      <td>${escapeHtml(row.stage)}</td>
      <td class="dash-num">${formatAmountAsRubles(row.claimed)}</td>`,
    5,
  );
}

/**
 * Заполняет плитку «% от судебных дел»: конверсия по должникам и по сумме.
 *
 * По должникам — крупным числом, по сумме — мелкой строкой под ним, как в
 * плитке «Процент взыскания». Нет судебных дел (или их суммы) — прочерк вместо
 * деления на ноль.
 */
function renderBankruptcyConversion(conversion) {
  const debtorsElement = document.getElementById("kpi-bankruptcy-conversion-debtors");
  if (conversion.debtors_percent == null) {
    debtorsElement.textContent = "—";
  } else {
    animateNumber("kpi-bankruptcy-conversion-debtors", conversion.debtors_percent, (value) =>
      `${value.toFixed(1).replace(".", ",")} %`,
    );
  }

  const amountElement = document.getElementById("kpi-bankruptcy-conversion-amount");
  if (conversion.amount_percent == null) {
    amountElement.innerHTML = "&nbsp;";
  } else {
    // Значение — из числа, в innerHTML безопасно. Процент — чёрным (как
    // основной показатель), подпись — серым.
    const amountPercent = conversion.amount_percent.toFixed(1).replace(".", ",");
    amountElement.innerHTML = `<span class="text-slate-900">${amountPercent} %</span> в сумме требований`;
  }
}

/**
 * Рисует динамику банкротств по годам.
 *
 * Год берётся из номера дела, поэтому дело с двумя номерами разных лет попадает
 * в оба столбца. Взыскания в банкротстве нет (долг в реестре требований), так
 * что показываются только сумма требований и количество дел на второй оси.
 */
function renderBankruptcyDynamics(dynamics) {
  const byYearAscending = [...dynamics].reverse();
  renderChart("chart-bankruptcy-dynamics", byYearAscending.length > 0, {
    type: "bar",
    data: {
      labels: byYearAscending.map((year) => year.year),
      datasets: [
        {
          label: "Сумма требований",
          data: byYearAscending.map((year) => year.claimed),
          backgroundColor: "#f59e0b",
          borderRadius: 6,
          yAxisID: "y",
          // Столбцы — на заднем плане (больший order рисуется ниже).
          order: 2,
        },
        {
          label: "Дел",
          isMoney: false,
          data: byYearAscending.map((year) => year.cases_count),
          type: "line",
          borderColor: "#8b5cf6",
          backgroundColor: "#8b5cf6",
          tension: 0.3,
          yAxisID: "yCount",
          // Меньший order — кривая ложится поверх столбцов.
          order: 1,
        },
      ],
    },
    options: {
      ...baseChartOptions({ moneyTooltip: true, legend: true }),
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { callback: formatAxisMoney } },
        yCount: {
          beginAtZero: true,
          position: "right",
          grid: { display: false },
          ticks: { precision: 0 },
        },
      },
    },
  });
}

/**
 * Рисует секцию «Претензионный порядок».
 *
 * Показатели реагируют на выбранный год (год берётся из даты претензии).
 * Динамика по годам имеет смысл только в общем обзоре и на экране года
 * скрывается. Если реестр претензий не прочитался, вместо показателей —
 * понятное сообщение, а остальной дашборд продолжает работать.
 */
function renderClaims(claims, isOverview) {
  const unavailable = document.getElementById("claims-unavailable");
  const content = document.getElementById("claims-content");

  if (!claims || !claims.available) {
    content.classList.add("hidden");
    unavailable.classList.remove("hidden");
    document.getElementById("claims-unavailable-message").textContent =
      (claims && claims.error) || "Не удалось прочитать реестр претензий.";
    return;
  }

  unavailable.classList.add("hidden");
  content.classList.remove("hidden");

  const section = isOverview
    ? claims.overall
    : (claims.by_year[selectedYear] || emptyClaimsSection());
  renderClaimsKpi(section.kpi);

  document.getElementById("claims-dynamics-card").classList.toggle("hidden", !isOverview);
  if (isOverview) {
    renderClaimsDynamics(claims.dynamics);
  }
}

/**
 * Пустая секция претензий — если у выбранного года претензий не оказалось.
 */
function emptyClaimsSection() {
  return {
    kpi: {
      claims_count: 0,
      claimed_total: 0,
      transferred_count: 0,
      transferred_total: 0,
      transfer_percent: null,
      average_days_to_transfer: null,
      transfer_term_count: 0,
    },
  };
}

/**
 * Заполняет плитки показателей претензионной работы.
 */
function renderClaimsKpi(kpi) {
  animateNumber("kpi-claims-count", kpi.claims_count, (value) =>
    Math.round(value).toLocaleString("ru-RU"),
  );
  animateNumber("kpi-claims-total", kpi.claimed_total, formatMoney);
  animateNumber("kpi-claims-transferred-count", kpi.transferred_count, (value) =>
    Math.round(value).toLocaleString("ru-RU"),
  );
  animateNumber("kpi-claims-transferred-total", kpi.transferred_total, formatMoney);

  const percentElement = document.getElementById("kpi-claims-transfer-percent");
  if (kpi.transfer_percent === null) {
    percentElement.textContent = "—";
  } else {
    animateNumber("kpi-claims-transfer-percent", kpi.transfer_percent, (value) =>
      `${value.toFixed(1).replace(".", ",")} %`,
    );
  }

  const note = document.getElementById("kpi-claims-avg-term-note");
  if (kpi.average_days_to_transfer == null) {
    document.getElementById("kpi-claims-avg-term").textContent = "—";
    note.textContent = "нет сопоставленных дел с датами";
  } else {
    animateNumber("kpi-claims-avg-term", kpi.average_days_to_transfer, (value) =>
      pluralize(Math.round(value), "день", "дня", "дней"),
    );
    note.textContent =
      `по ${pluralize(kpi.transfer_term_count || 0, "претензии", "претензиям", "претензиям")}`;
  }
}

/**
 * Рисует динамику претензий по годам: сумма столбцами, количество линией.
 */
function renderClaimsDynamics(dynamics) {
  const byYearAscending = [...dynamics].reverse();
  renderChart("chart-claims-dynamics", byYearAscending.length > 0, {
    type: "bar",
    data: {
      labels: byYearAscending.map((year) => year.year),
      datasets: [
        {
          label: "Сумма претензий",
          data: byYearAscending.map((year) => year.claimed),
          backgroundColor: "#0ea5e9",
          borderRadius: 6,
          yAxisID: "y",
          order: 2,
        },
        {
          label: "Претензий",
          isMoney: false,
          data: byYearAscending.map((year) => year.claims_count),
          type: "line",
          borderColor: "#0f172a",
          backgroundColor: "#0f172a",
          tension: 0.3,
          yAxisID: "yCount",
          order: 1,
        },
      ],
    },
    options: {
      ...baseChartOptions({ moneyTooltip: true, legend: true }),
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { callback: formatAxisMoney } },
        yCount: {
          beginAtZero: true,
          position: "right",
          grid: { display: false },
          ticks: { precision: 0 },
        },
      },
    },
  });
}

/**
 * Рисует кликабельные карточки годов.
 *
 * Карточка — короткая сводка по году и вход на его экран.
 */
function renderYearCards(dynamics) {
  const container = document.getElementById("dashboard-year-cards");
  container.innerHTML = "";

  dynamics.forEach((year) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "dash-year-card";
    card.innerHTML = `
      <div class="font-semibold text-slate-800">${escapeHtml(year.year)}</div>
      <div class="text-xs text-slate-500 mt-1">${pluralize(year.cases_count, "дело", "дела", "дел")}</div>
      <div class="text-sm text-blue-600 font-medium">${formatMoney(year.claimed)}</div>
      <div class="text-xs text-green-600">взыскано ${formatMoney(year.recovered)}</div>`;
    card.addEventListener("click", () => selectYear(year.year));
    container.appendChild(card);
  });

  if (dynamics.length === 0) {
    container.innerHTML = '<div class="text-sm text-slate-400">Дел пока нет.</div>';
  }
}

/**
 * Показывает блок предупреждений о качестве данных.
 *
 * Пропуски в реестре — не ошибка приложения, а подсказка юристу, где реестр не
 * дозаполнен. Если всё чисто, блок не показывается вовсе.
 */
function renderWarnings(warnings) {
  const block = document.getElementById("dashboard-warnings");
  const notes = [];

  if (warnings.cases_without_status > 0) {
    notes.push(`Строк без статуса: <b>${warnings.cases_without_status}</b> (стадия выведена по датам и суммам).`);
  }
  if (warnings.cases_without_debtor > 0) {
    notes.push(`Дел без должника или ИНН: <b>${warnings.cases_without_debtor}</b>.`);
  }
  if (warnings.unparsed_amounts_count > 0) {
    const rows = warnings.unparsed_amounts
      .map((item) => `строка ${item.row}, «${escapeHtml(item.column)}»: «${escapeHtml(item.value)}»`)
      .join("; ");
    notes.push(
      `Не удалось прочитать суммы: <b>${warnings.unparsed_amounts_count}</b> — учтены как ноль (${rows}).`,
    );
  }
  if (warnings.unknown_statuses_count > 0) {
    const rows = warnings.unknown_statuses
      .map((item) => `строка ${item.row}: «${escapeHtml(item.value)}»`)
      .join("; ");
    notes.push(`Статус не распознан: <b>${warnings.unknown_statuses_count}</b> (${rows}).`);
  }

  block.classList.toggle("hidden", notes.length === 0);
  block.innerHTML = notes.length === 0 ? "" : `
    <div class="dash-card-title text-amber-800">⚠️ Качество данных в реестре</div>
    <ul class="text-sm text-amber-900 space-y-1 list-disc pl-5">
      ${notes.map((note) => `<li>${note}</li>`).join("")}
    </ul>`;
}

// ── Графики: общая обвязка ──────────────────────────────────────────────────

/**
 * Базовые настройки графика, общие для всех диаграмм дашборда.
 *
 * Принимает флаги: показывать ли легенду и форматировать ли подсказку как
 * деньги. Анимация короткая и не повторяется при наведении.
 */
function baseChartOptions({ moneyTooltip = false, legend = false } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: CHART_ANIMATION_MS },
    plugins: {
      legend: { display: legend, position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: {
        callbacks: moneyTooltip ? { label: moneyTooltipLabel } : {},
      },
    },
  };
}

/**
 * Собирает текст подсказки для денежных графиков.
 *
 * Chart.js кладёт значение по-разному в зависимости от типа диаграммы: у
 * круговой это просто число, у столбчатой — координата по оси значений (y у
 * вертикальной, x у горизонтальной). Подпись берётся от набора данных, а у
 * круговой — от сектора.
 */
function moneyTooltipLabel(context) {
  const parsed = context.parsed;
  const value = typeof parsed === "number" ? parsed : parsed.y ?? parsed.x ?? 0;
  const name = context.dataset.label || context.label;

  // На денежном графике может жить и неденежный набор (количество дел в
  // динамике). Рубли к нему не приписываются — это штуки, а не деньги.
  if (context.dataset.isMoney === false) {
    return `${name}: ${Math.round(value).toLocaleString("ru-RU")}`;
  }
  // Знак рубля ставится ровно один раз — здесь. В подписях наборов данных его
  // быть не должно, иначе в подсказке получалось «Требования, ₽ … ₽».
  return `${name}: ${formatAmountAsRubles(value)} ₽`;
}

/**
 * Рисует график на канвасе, заменяя предыдущий.
 *
 * Если данных нет, вместо графика показывается надпись «Нет данных за этот
 * период» — пустая диаграмма выглядела бы как поломка.
 */
function renderChart(canvasId, hasData, config) {
  const canvas = document.getElementById(canvasId);
  const box = canvas.parentElement;

  if (charts[canvasId]) {
    charts[canvasId].destroy();
    delete charts[canvasId];
  }

  const existingPlaceholder = box.querySelector(".dash-chart-empty");
  if (existingPlaceholder) {
    existingPlaceholder.remove();
  }

  if (!hasData) {
    canvas.classList.add("hidden");
    const placeholder = document.createElement("div");
    placeholder.className =
      "dash-chart-empty h-full flex items-center justify-center text-sm text-slate-400";
    placeholder.textContent = "Нет данных за этот период";
    box.appendChild(placeholder);
    return;
  }

  canvas.classList.remove("hidden");
  if (printMode) {
    // Перед печатью график должен быть уже дорисован: анимированный канвас
    // попал бы в PDF в промежуточном состоянии.
    config.options.animation = false;
  }
  charts[canvasId] = new window.Chart(canvas, config);
}

// ── Печать в PDF ────────────────────────────────────────────────────────────

let printMode = false;

/**
 * Выгружает текущий экран дашборда в PDF.
 *
 * Печатается сама страница (те же карточки и графики, что на экране) — в
 * системном диалоге печати выбирается «Сохранить как PDF». Перед печатью
 * графики перерисовываются без анимации: canvas не подчиняется правилу
 * «animation: none» из печатных стилей, и недорисованный график попал бы в
 * PDF как есть.
 */
async function exportDashboardToPdf() {
  if (!dashboardData) {
    return;
  }

  printMode = true;
  render();
  await waitForFrames(2);

  window.print();
  printMode = false;
}

/**
 * Ждёт указанное число кадров отрисовки.
 *
 * Нужен, чтобы браузер успел вывести перерисованные графики до открытия
 * диалога печати.
 */
function waitForFrames(count) {
  return new Promise((resolve) => {
    let remaining = count;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
      } else {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  });
}

// ── Настройки доступа ───────────────────────────────────────────────────────

/**
 * Показывает или прячет панель настроек доступа к таблице.
 */
function toggleSettingsPanel() {
  document.getElementById("dashboard-settings").classList.toggle("hidden");
}

/**
 * Подставляет сохранённые настройки в поля панели настроек.
 */
async function fillSettingsFields() {
  const settings = await loadSheetsSettings();
  document.getElementById("dashboard-credentials-path").value = settings.credentialsPath;
  document.getElementById("dashboard-spreadsheet-id").value =
    settings.spreadsheetId || DEFAULT_SPREADSHEET_ID;
}

/**
 * Открывает диалог выбора JSON-ключа сервисного аккаунта.
 */
async function chooseCredentialsFile() {
  const selectedPath = await selectJsonKeyFile();
  if (selectedPath) {
    document.getElementById("dashboard-credentials-path").value = selectedPath;
  }
}

/**
 * Сохраняет настройки доступа и сразу загружает данные.
 */
async function saveSettingsAndReload() {
  const credentialsPath = document.getElementById("dashboard-credentials-path").value.trim();
  const spreadsheetId = document.getElementById("dashboard-spreadsheet-id").value.trim();

  if (!credentialsPath || !spreadsheetId) {
    showError("Укажите путь к JSON-ключу и идентификатор таблицы.");
    return;
  }

  await saveSheetsSettings({ credentialsPath, spreadsheetId });
  document.getElementById("dashboard-settings").classList.add("hidden");
  await loadDashboard({ force: true });
}

// ── Состояния экрана ────────────────────────────────────────────────────────

/**
 * Показывает скелетоны на время загрузки — вместо пустого экрана.
 */
function showLoading() {
  document.getElementById("dashboard-content").classList.add("hidden");
  document.getElementById("dashboard-state").innerHTML = `
    <div class="space-y-4">
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        ${'<div class="dash-skeleton h-24"></div>'.repeat(4)}
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        ${'<div class="dash-skeleton h-64"></div>'.repeat(2)}
      </div>
    </div>`;
}

/**
 * Показывает понятное сообщение об ошибке доступа.
 *
 * Ошибка Google (нет прав, нет сети, неверный ключ) — это сообщение на экране,
 * а не падение приложения.
 */
function showError(message) {
  document.getElementById("dashboard-content").classList.add("hidden");
  document.getElementById("dashboard-state").innerHTML = `
    <div class="dash-card border-red-200 bg-red-50">
      <div class="dash-card-title text-red-800">Не удалось загрузить данные</div>
      <div class="text-sm text-red-900">${escapeHtml(message)}</div>
    </div>`;
}

/**
 * Приглашает настроить доступ, если ключ и таблица ещё не указаны.
 */
function showSettingsInvitation() {
  document.getElementById("dashboard-content").classList.add("hidden");
  document.getElementById("dashboard-state").innerHTML = `
    <div class="dash-card">
      <div class="dash-card-title">Доступ к таблице не настроен</div>
      <div class="text-sm text-slate-600">
        Нажмите «Настройки», укажите JSON-ключ сервисного аккаунта Google и
        идентификатор таблицы с реестром судебных дел. Таблица открывается
        только на чтение.
      </div>
    </div>`;
}

/**
 * Показывает время последнего обновления данных.
 */
function showUpdatedAt() {
  const time = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  document.getElementById("dashboard-updated-at").textContent = `Данные на ${time}`;
}

/**
 * Заполняет выпадающий фильтр годов по загруженным данным.
 */
function fillYearFilter() {
  const filter = document.getElementById("dashboard-year-filter");
  filter.innerHTML = '<option value="">Все годы</option>';
  dashboardData.cases.years.forEach((year) => {
    const option = document.createElement("option");
    option.value = year;
    option.textContent = year;
    filter.appendChild(option);
  });
  filter.value = "";
}

// ── Мелкие помощники отрисовки ──────────────────────────────────────────────

/**
 * Проигрывает мягкое появление карточек.
 *
 * Запускается на каждую отрисовку (в том числе при переходе в год и обратно) —
 * это и есть плавная смена экрана. Класс сначала снимается, иначе браузер не
 * перезапустит уже сыгранную анимацию.
 */
function playAppearAnimation() {
  if (printMode) {
    return;
  }
  const cards = document.querySelectorAll("#dashboard-content .dash-card");
  cards.forEach((card, index) => {
    card.classList.remove("dash-appear");
    void card.offsetWidth;
    card.style.setProperty("--dash-delay", `${Math.min(index, 8) * 30}ms`);
    card.classList.add("dash-appear");
  });
}

/**
 * Плавно набирает число в плитке показателя.
 *
 * Принимает id элемента, конечное значение и функцию форматирования. Нулевое
 * значение выводится сразу — анимировать нечего.
 */
function animateNumber(elementId, targetValue, format) {
  const element = document.getElementById(elementId);
  const duration = printMode ? 0 : 400;

  if (duration === 0 || !targetValue) {
    element.textContent = format(targetValue || 0);
    return;
  }

  const startedAt = performance.now();
  const step = (now) => {
    const progress = Math.min((now - startedAt) / duration, 1);
    // easeOutCubic: быстро в начале, мягко в конце
    const eased = 1 - Math.pow(1 - progress, 3);
    element.textContent = format(targetValue * eased);
    if (progress < 1) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
}

/**
 * Склоняет существительное по числу: 1 дело, 3 дела, 9 дел.
 *
 * Принимает число и три формы слова — для 1, для 2–4 и для остальных. Правило
 * общее для русского счёта: числа 11–14 всегда берут последнюю форму.
 */
function pluralize(count, one, few, many) {
  const absolute = Math.abs(count) % 100;
  const lastDigit = absolute % 10;

  let form = many;
  if (absolute < 11 || absolute > 14) {
    if (lastDigit === 1) {
      form = one;
    } else if (lastDigit >= 2 && lastDigit <= 4) {
      form = few;
    }
  }
  return `${count.toLocaleString("ru-RU")} ${form}`;
}

/**
 * Форматирует сумму для плиток и карточек: рубли без копеек.
 */
function formatMoney(amount) {
  return `${Math.round(amount).toLocaleString("ru-RU")} ₽`;
}

/**
 * Форматирует подпись денежной оси: миллионы и тысячи вместо длинных чисел.
 */
function formatAxisMoney(value) {
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(".", ",")} млн`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${Math.round(value / 1_000)} тыс.`;
  }
  return String(value);
}

/**
 * Возвращает строку-заглушку для пустой таблицы.
 */
function emptyTableRow(columnCount) {
  return `<tr><td colspan="${columnCount}" class="text-slate-400">Нет данных за этот период</td></tr>`;
}

/**
 * Делает первую букву заглавной (статусы в реестре пишут со строчной).
 */
function capitalize(text) {
  if (!text) {
    return "";
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Экранирует текст из таблицы перед вставкой в HTML.
 *
 * Данные приходят из Google-таблицы, которую ведут руками: в названии
 * должника может оказаться что угодно, и оно не должно превращаться в разметку.
 */
function escapeHtml(text) {
  const element = document.createElement("div");
  element.textContent = text ?? "";
  return element.innerHTML;
}
