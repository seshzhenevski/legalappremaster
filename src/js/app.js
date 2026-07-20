// app.js
// Точка входа фронтенда.
//
// Единственная задача — инициализировать навигацию и все вкладки
// после загрузки страницы. Не содержит бизнес-логики.

import { initSidebar } from "./sidebar.js";
import { initTabNavigation } from "./tab-navigation.js";
import { initLawsuitTab } from "./tab-lawsuit.js";
import { initClaimTab } from "./tab-claim.js";
import { initSorterTab } from "./tab-sorter.js";
import { initPenaltyTab } from "./tab-penalty.js";
import { initStateDutyTab } from "./tab-state-duty.js";
import { initDashboardTab } from "./tab-dashboard.js";
import { initDatePickers } from "./date-picker.js";

/**
 * Инициализирует всё приложение после загрузки DOM.
 *
 * Запускает кастомный календарь, навигацию по вкладкам и инициализацию
 * каждой вкладки. Добавление новой вкладки — это один вызов init-функции
 * здесь.
 */
function initApplication() {
  initDatePickers();
  initSidebar();
  initTabNavigation();
  initLawsuitTab();
  initClaimTab();
  initSorterTab();
  initPenaltyTab();
  initStateDutyTab();
  initDashboardTab();
}

window.addEventListener("DOMContentLoaded", initApplication);
