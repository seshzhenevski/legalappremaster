// tab-navigation.js
// Переключение между вкладками приложения.
//
// Отвечает только за показ/скрытие панелей вкладок и подсветку активной
// кнопки. Не знает о содержимом вкладок.

/**
 * Инициализирует переключение вкладок.
 *
 * Вешает обработчик на каждую кнопку вкладки. По клику показывает
 * соответствующую панель и прячет остальные.
 */
export function initTabNavigation() {
  const tabButtons = document.querySelectorAll("[data-tab-target]");
  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      activateTab(button.dataset.tabTarget);
    });
  });
  const firstTab = tabButtons[0];
  if (firstTab) {
    activateTab(firstTab.dataset.tabTarget);
  }
}

/**
 * Активирует вкладку по идентификатору её панели.
 *
 * Показывает панель с указанным id, прячет все остальные панели
 * и обновляет подсветку кнопок вкладок.
 */
function activateTab(targetPanelId) {
  document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
    const isTarget = panel.id === targetPanelId;
    panel.classList.toggle("hidden", !isTarget);
  });

  document.querySelectorAll("[data-tab-target]").forEach((button) => {
    const isActive = button.dataset.tabTarget === targetPanelId;
    // Цвет текста и анимированное подчёркивание задаются в CSS через класс
    // .tab-active (см. .nav-tab в index.html) — здесь только переключаем его.
    button.classList.toggle("tab-active", isActive);
  });
}
