// sidebar.js
// Раскрытие и сворачивание боковой навигации.
//
// Отвечает только за состояние «свёрнут/развёрнут»: ширину и метки анимирует
// CSS через атрибут data-expanded (см. .sidebar в index.html). Переключение
// вкладок живёт в tab-navigation.js и от состояния сайдбара не зависит.

const STORAGE_KEY = "sidebar-expanded";

/**
 * Инициализирует кнопку-триггер сайдбара.
 *
 * По умолчанию сайдбар свёрнут; если пользователь раскрывал его в прошлый раз,
 * состояние восстанавливается из localStorage. Клик по триггеру переключает
 * состояние — остальное (плавная ширина, проявление меток) делает CSS.
 */
export function initSidebar() {
  const sidebar = document.getElementById("sidebar");
  const toggle = document.getElementById("sidebar-toggle");
  if (!sidebar || !toggle) {
    return;
  }

  let expanded = false;
  try {
    expanded = localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // localStorage недоступен (приватный режим и т. п.) — просто стартуем свёрнутыми.
  }
  applyState(sidebar, toggle, expanded);

  toggle.addEventListener("click", () => {
    applyState(sidebar, toggle, sidebar.dataset.expanded !== "true");
  });
}

/**
 * Применяет состояние к сайдбару и триггеру и запоминает его.
 *
 * Видимая подпись триггера появляется только в развёрнутом виде, поэтому
 * состояние «Раскрыть» в свёрнутом виде передаётся подсказкой (title/aria).
 */
function applyState(sidebar, toggle, expanded) {
  sidebar.dataset.expanded = expanded ? "true" : "false";
  toggle.setAttribute("aria-label", expanded ? "Свернуть меню" : "Раскрыть меню");
  toggle.setAttribute("title", expanded ? "Свернуть" : "Раскрыть");

  try {
    localStorage.setItem(STORAGE_KEY, expanded ? "1" : "0");
  } catch {
    // Не смогли сохранить — не страшно: на текущую сессию состояние уже применено.
  }
}
