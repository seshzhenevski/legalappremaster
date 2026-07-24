// theme.js
// Переключение светлой/тёмной темы приложения.
//
// Тема — это класс `dark` на корневом элементе (<html>); все цвета берутся из
// CSS-переменных (см. src/css/input.css). Здесь живёт: применение темы,
// синхронизация обеих презентаций контрола (иконка в свёрнутом сайдбаре и
// тумблер в развёрнутом — это один и тот же контрол), сохранение выбора
// (settings.json + синхронное зеркало в localStorage для «без вспышки») и
// оповещение остальных модулей (событие themechange — его слушает дашборд,
// чтобы перерисовать графики).

import { loadThemeFromStore, saveThemeToStore } from "./theme-store.js";

const MIRROR_KEY = "theme";
const ANIM_CLASS = "theme-anim";
const ANIM_MS = 260;

let currentTheme = "light";

/**
 * Инициализирует тему после загрузки DOM.
 *
 * До первой отрисовки класс уже выставил theme-boot.js по localStorage-зеркалу;
 * здесь состояние приводится к источнику истины (settings.json) и навешивается
 * обработчик на переключатель.
 */
export async function initTheme() {
  let mirror = null;
  try {
    mirror = localStorage.getItem(MIRROR_KEY);
  } catch (error) {
    mirror = null;
  }

  const stored = await loadThemeFromStore();
  const theme = stored || mirror || "light";
  applyTheme(theme, { animate: false });
  writeMirror(theme);
  if (!stored) {
    // Первый запуск (или тема жила только в зеркале) — зафиксировать в settings.
    await saveThemeToStore(theme);
  }

  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      setTheme(currentTheme === "dark" ? "light" : "dark");
    });
  }
}

/**
 * Меняет тему по действию пользователя: применяет с анимацией и сохраняет.
 */
async function setTheme(theme) {
  applyTheme(theme, { animate: true });
  writeMirror(theme);
  await saveThemeToStore(theme);
}

/**
 * Применяет тему к документу и синхронизирует контрол.
 *
 * При animate=true на время переключения включается точечный переход цветов
 * (класс theme-anim), если пользователь не просил уменьшить анимации.
 */
function applyTheme(theme, { animate }) {
  currentTheme = theme === "dark" ? "dark" : "light";
  const root = document.documentElement;

  if (animate && !prefersReducedMotion()) {
    root.classList.add(ANIM_CLASS);
    window.setTimeout(() => root.classList.remove(ANIM_CLASS), ANIM_MS);
  }

  root.classList.toggle("dark", currentTheme === "dark");
  updateControl();
  document.dispatchEvent(
    new CustomEvent("themechange", { detail: { theme: currentTheme } }),
  );
}

/**
 * Обновляет состояние переключателя: aria, подсказку и активную подпись.
 *
 * Визуальные состояния (иконка, положение и форма ползунка) переключает CSS по
 * классу `dark`; здесь — доступность и текст подсказки/подписей.
 */
function updateControl() {
  const toggle = document.getElementById("theme-toggle");
  if (!toggle) {
    return;
  }
  const isDark = currentTheme === "dark";
  // Подсказка называет тему, на которую переключит клик.
  const nextThemeLabel = isDark ? "Светлая тема" : "Тёмная тема";

  toggle.setAttribute("aria-checked", isDark ? "true" : "false");
  toggle.setAttribute("title", nextThemeLabel);
  toggle.setAttribute("aria-label", nextThemeLabel);

  const darkLabel = toggle.querySelector(".theme-label-dark");
  const lightLabel = toggle.querySelector(".theme-label-light");
  if (darkLabel) {
    darkLabel.classList.toggle("is-active", isDark);
  }
  if (lightLabel) {
    lightLabel.classList.toggle("is-active", !isDark);
  }
}

function writeMirror(theme) {
  try {
    localStorage.setItem(MIRROR_KEY, theme);
  } catch (error) {
    // Зеркало недоступно — тема всё равно сохранится в settings.json.
  }
}

function prefersReducedMotion() {
  return (
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
