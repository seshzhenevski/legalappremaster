// kb-menu.js
// Всплывающее меню действий для вкладки базы знаний.
//
// Меню живёт в конце body и позиционируется по кнопке, от которой его
// открыли. Рисовать его прямо в дереве нельзя: колонка дерева прокручивается
// (overflow-y), и всплывающее меню обрезалось бы по её краю — у нижних
// разделов от меню осталась бы одна строка.
//
// Открытым бывает только одно меню: второй вызов закрывает прежнее. Это
// избавляет вызывающий код от учёта того, что где-то осталось висеть чужое.

// Отступ меню от кнопки, чтобы оно не наезжало на неё.
const MENU_GAP = 4;

// Сколько оставить до края окна, если меню не помещается вниз или вправо.
const VIEWPORT_MARGIN = 8;

let activeMenu = null;

/**
 * Открывает меню действий рядом с кнопкой.
 *
 * Принимает кнопку-якорь и список пунктов: { label, onSelect, danger }.
 * Пункт с danger оформляется предупреждающим цветом — удаление не должно
 * выглядеть так же, как переименование.
 *
 * Меню закрывается выбором пункта, кликом мимо, Escape, прокруткой и сменой
 * размера окна: всё это уводит кнопку из-под меню, и оставленное висеть меню
 * оказалось бы привязанным к пустому месту.
 */
export function openMenu(anchorElement, items) {
  closeMenu();

  const menu = document.createElement("div");
  menu.className = "kb-menu";
  menu.setAttribute("role", "menu");

  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = item.danger ? "kb-menu-item kb-menu-item-danger" : "kb-menu-item";
    button.setAttribute("role", "menuitem");
    button.textContent = item.label;
    button.addEventListener("click", () => {
      closeMenu();
      item.onSelect();
    });
    menu.appendChild(button);
  });

  document.body.appendChild(menu);
  placeMenu(menu, anchorElement);

  anchorElement.setAttribute("aria-expanded", "true");
  activeMenu = { element: menu, anchor: anchorElement };

  // Подписки вешаются на следующем кадре: клик, открывший меню, ещё
  // всплывает, и меню закрылось бы тем же нажатием, которым открылось.
  setTimeout(() => {
    document.addEventListener("mousedown", handleOutsideClick, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", closeMenu, true);
    // Третий аргумент true — прокрутка любой области внутри окна, а не
    // только самого окна: дерево прокручивается своим контейнером.
    window.addEventListener("scroll", closeMenu, true);
  }, 0);

  const firstItem = menu.querySelector(".kb-menu-item");
  if (firstItem) {
    firstItem.focus();
  }
}

/**
 * Закрывает открытое меню, если оно есть.
 *
 * Возвращает фокус на кнопку, от которой меню открыли: иначе работа с
 * клавиатуры обрывается — фокус остаётся на исчезнувшем пункте.
 */
export function closeMenu() {
  if (!activeMenu) {
    return;
  }

  const { element, anchor } = activeMenu;
  activeMenu = null;

  document.removeEventListener("mousedown", handleOutsideClick, true);
  document.removeEventListener("keydown", handleKeyDown, true);
  window.removeEventListener("resize", closeMenu, true);
  window.removeEventListener("scroll", closeMenu, true);

  element.remove();
  if (anchor.isConnected) {
    anchor.setAttribute("aria-expanded", "false");
    anchor.focus();
  }
}

/**
 * Отвечает, открыто ли сейчас меню от этой кнопки.
 *
 * Нужно, чтобы повторное нажатие на те же три точки закрывало меню, а не
 * открывало его заново.
 */
export function isMenuOpenFor(anchorElement) {
  return Boolean(activeMenu) && activeMenu.anchor === anchorElement;
}

/**
 * Ставит меню под кнопкой, не давая ему уйти за край окна.
 *
 * Меню выравнивается по правому краю кнопки: три точки стоят у правого края
 * строки, и меню, растущее вправо, вылезало бы за колонку. Если снизу места
 * нет, меню поднимается над кнопкой.
 */
function placeMenu(menu, anchorElement) {
  const anchor = anchorElement.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;

  let left = anchor.right - width;
  if (left < VIEWPORT_MARGIN) {
    left = VIEWPORT_MARGIN;
  }
  const rightLimit = window.innerWidth - width - VIEWPORT_MARGIN;
  if (left > rightLimit) {
    left = Math.max(VIEWPORT_MARGIN, rightLimit);
  }

  let top = anchor.bottom + MENU_GAP;
  if (top + height > window.innerHeight - VIEWPORT_MARGIN) {
    top = anchor.top - height - MENU_GAP;
  }
  if (top < VIEWPORT_MARGIN) {
    top = VIEWPORT_MARGIN;
  }

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

/**
 * Закрывает меню по клику мимо него.
 *
 * Клик по самой кнопке пропускается: его обработает вызывающий код и закроет
 * меню сам, иначе меню закрылось бы здесь и тут же открылось заново.
 */
function handleOutsideClick(event) {
  if (!activeMenu) {
    return;
  }
  if (activeMenu.element.contains(event.target)
    || activeMenu.anchor.contains(event.target)) {
    return;
  }
  closeMenu();
}

/**
 * Ведёт меню с клавиатуры: Escape закрывает, стрелки переставляют фокус.
 *
 * Tab закрывает меню и отпускает фокус дальше по странице: висящее меню при
 * ушедшем из него фокусе выглядит как зависшая кнопка.
 */
function handleKeyDown(event) {
  if (!activeMenu) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeMenu();
    return;
  }
  if (event.key === "Tab") {
    closeMenu();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }

  event.preventDefault();
  const buttons = [...activeMenu.element.querySelectorAll(".kb-menu-item")];
  if (!buttons.length) {
    return;
  }
  const current = buttons.indexOf(document.activeElement);
  const step = event.key === "ArrowDown" ? 1 : -1;
  const next = (current + step + buttons.length) % buttons.length;
  buttons[next].focus();
}
