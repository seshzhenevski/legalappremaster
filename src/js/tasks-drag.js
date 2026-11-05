// tasks-drag.js
// Перетаскивание карточек доски задач мышью.
//
// Своё, на событиях указателя, а не встроенное перетаскивание браузера: в
// окне Tauri на Windows встроенное не работает, пока окно само принимает
// перетаскиваемые файлы, — а это нужно зонам Excel в иске и претензии.
// Отключить приём файлов ради доски значило бы сломать те вкладки.
//
// Пока карточку тащат, за указателем едет её копия, а на месте, куда она
// встанет, — пунктирная заглушка того же размера. Сама карточка на это время
// прячется, поэтому соседние карточки раздвигаются ровно под неё.

// На сколько пикселей нужно сдвинуть мышь, чтобы нажатие стало
// перетаскиванием, а не щелчком: рука дрожит, и щелчок по карточке иначе то
// и дело превращался бы в перенос на то же место.
const DRAG_THRESHOLD = 5;

// Ширина полосы у края колонки и доски, в которой содержимое само
// прокручивается, и шаг прокрутки за кадр: без этого карточку нельзя было бы
// донести до места, которое не видно на экране.
const AUTO_SCROLL_EDGE = 48;
const AUTO_SCROLL_STEP = 12;

/**
 * Считает, на какое место встанет карточка.
 *
 * Принимает середины по высоте карточек колонки (без перетаскиваемой) и
 * высоту указателя. Возвращает номер места: перед первой карточкой, чья
 * середина ниже указателя, или в конец.
 */
export function insertionIndex(centers, pointerY) {
  const index = centers.findIndex((center) => pointerY < center);
  return index === -1 ? centers.length : index;
}

/**
 * Включает перетаскивание карточек на доске.
 *
 * Принимает контейнер доски и настройки:
 *   canDrag() — можно ли сейчас таскать. Нельзя, пока идёт поиск: видна
 *               только часть карточек, и место среди них ничего не значит;
 *   onDrop(taskId, columnId, index) — куда карточку положили: колонка и
 *               номер места среди её карточек без перетаскиваемой.
 *
 * Карточка — элемент с data-task-id, колонка — элемент с data-column, список
 * карточек в ней — элемент с data-column-list и data-column-id.
 */
export function enableCardDragging(boardElement, { canDrag, onDrop }) {
  // Кнопку нажали на карточке, но мышь ещё не сдвинулась достаточно.
  let pending = null;
  // Идёт перетаскивание.
  let drag = null;

  boardElement.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag || !canDrag()) {
      return;
    }
    const card = event.target.closest("[data-task-id]");
    // С кнопок карточки — отметки «готово» и меню — перетаскивание не
    // начинается: там нажатие значит нажатие.
    if (!card || event.target.closest("button, input, textarea, select, a")) {
      return;
    }
    pending = {
      card: card,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
  });

  boardElement.addEventListener("pointermove", (event) => {
    if (drag && event.pointerId === drag.pointerId) {
      followPointer(event.clientX, event.clientY);
      return;
    }
    if (!pending || event.pointerId !== pending.pointerId) {
      return;
    }
    const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
    if (distance >= DRAG_THRESHOLD) {
      startDrag(event);
    }
  });

  boardElement.addEventListener("pointerup", (event) => {
    pending = null;
    if (drag && event.pointerId === drag.pointerId) {
      finishDrag(true);
    }
  });
  boardElement.addEventListener("pointercancel", () => {
    pending = null;
    finishDrag(false);
  });
  // Захват указателя теряется, например, если окно потеряло фокус посреди
  // перетаскивания. Карточка тогда возвращается на место, а не повисает.
  boardElement.addEventListener("lostpointercapture", () => finishDrag(false));
  document.addEventListener("keydown", (event) => {
    if (drag && event.key === "Escape") {
      event.preventDefault();
      finishDrag(false);
    }
  });

  /**
   * Превращает нажатие в перетаскивание: создаёт копию под указателем и
   * заглушку на месте карточки.
   */
  function startDrag(event) {
    const card = pending.card;
    const rect = card.getBoundingClientRect();

    const ghost = card.cloneNode(true);
    ghost.removeAttribute("data-task-id");
    ghost.removeAttribute("tabindex");
    ghost.classList.add("tasks-card-ghost");
    ghost.style.width = `${rect.width}px`;
    document.body.appendChild(ghost);

    const placeholder = document.createElement("div");
    placeholder.className = "tasks-card-placeholder";
    placeholder.style.height = `${rect.height}px`;
    card.before(placeholder);
    card.classList.add("tasks-card-dragging");

    drag = {
      card: card,
      taskId: card.dataset.taskId,
      pointerId: pending.pointerId,
      offsetX: pending.startX - rect.left,
      offsetY: pending.startY - rect.top,
      ghost: ghost,
      placeholder: placeholder,
      list: placeholder.parentElement,
      x: event.clientX,
      y: event.clientY,
      frame: 0,
    };
    pending = null;

    // Захват на доску, а не на карточку: карточка на время перетаскивания
    // прячется, а события должны приходить и тогда, когда указатель вышел
    // за край доски.
    try {
      boardElement.setPointerCapture(drag.pointerId);
    } catch {
      // Без захвата перетаскивание всё равно работает, пока указатель над
      // доской.
    }
    document.body.classList.add("tasks-dragging");
    followPointer(event.clientX, event.clientY);
    drag.frame = requestAnimationFrame(autoScroll);
  }

  /**
   * Двигает копию за указателем и переставляет заглушку.
   */
  function followPointer(x, y) {
    drag.x = x;
    drag.y = y;
    drag.ghost.style.left = `${x - drag.offsetX}px`;
    drag.ghost.style.top = `${y - drag.offsetY}px`;
    placePlaceholder();
  }

  /**
   * Ставит заглушку туда, куда встанет карточка, если отпустить её сейчас.
   *
   * Колонка выбирается по горизонтали — по всей её ширине, включая шапку:
   * попадать указателем ровно в список карточек было бы утомительно. Над
   * промежутком между колонками заглушка остаётся где была.
   */
  function placePlaceholder() {
    const column = [...boardElement.querySelectorAll("[data-column]")].find((element) => {
      const rect = element.getBoundingClientRect();
      return drag.x >= rect.left && drag.x <= rect.right;
    });
    const list = column ? column.querySelector("[data-column-list]") : null;
    if (!list) {
      return;
    }
    drag.list = list;

    const cards = [...list.querySelectorAll("[data-task-id]")]
      .filter((element) => element !== drag.card && !element.hidden);
    const centers = cards.map((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    const before = cards[insertionIndex(centers, drag.y)] || null;

    if (before) {
      if (drag.placeholder.nextElementSibling !== before) {
        list.insertBefore(drag.placeholder, before);
      }
    } else if (list.lastElementChild !== drag.placeholder) {
      list.appendChild(drag.placeholder);
    }
  }

  /**
   * Прокручивает колонку и доску, пока указатель стоит у их края.
   */
  function autoScroll() {
    if (!drag) {
      return;
    }
    let scrolled = false;

    const listRect = drag.list.getBoundingClientRect();
    if (drag.y < listRect.top + AUTO_SCROLL_EDGE && drag.list.scrollTop > 0) {
      drag.list.scrollTop -= AUTO_SCROLL_STEP;
      scrolled = true;
    } else if (drag.y > listRect.bottom - AUTO_SCROLL_EDGE) {
      const before = drag.list.scrollTop;
      drag.list.scrollTop += AUTO_SCROLL_STEP;
      scrolled = drag.list.scrollTop !== before;
    }

    const boardRect = boardElement.getBoundingClientRect();
    if (drag.x < boardRect.left + AUTO_SCROLL_EDGE && boardElement.scrollLeft > 0) {
      boardElement.scrollLeft -= AUTO_SCROLL_STEP;
      scrolled = true;
    } else if (drag.x > boardRect.right - AUTO_SCROLL_EDGE) {
      const before = boardElement.scrollLeft;
      boardElement.scrollLeft += AUTO_SCROLL_STEP;
      scrolled = scrolled || boardElement.scrollLeft !== before;
    }

    if (scrolled) {
      placePlaceholder();
    }
    drag.frame = requestAnimationFrame(autoScroll);
  }

  /**
   * Завершает перетаскивание: убирает копию и заглушку и, если карточку
   * отпустили, а не отменили, сообщает, куда её положили.
   */
  function finishDrag(commit) {
    if (!drag) {
      return;
    }
    const finished = drag;
    drag = null;

    cancelAnimationFrame(finished.frame);
    finished.ghost.remove();
    finished.card.classList.remove("tasks-card-dragging");
    document.body.classList.remove("tasks-dragging");

    const list = finished.placeholder.parentElement;
    let result = null;
    if (commit && list && list.dataset.columnId) {
      const places = [...list.children].filter((element) => (
        element === finished.placeholder
        || (element.dataset.taskId && element !== finished.card)
      ));
      result = {
        columnId: list.dataset.columnId,
        index: places.indexOf(finished.placeholder),
      };
    }
    finished.placeholder.remove();

    if (boardElement.hasPointerCapture?.(finished.pointerId)) {
      boardElement.releasePointerCapture(finished.pointerId);
    }

    // Отпущенная кнопка мыши следом даёт щелчок — и он открыл бы карточку,
    // которую только что перенесли. Щелчок приходит сразу за отпусканием, в
    // том же такте, поэтому перехватчик снимается на следующем.
    const swallowClick = (event) => {
      event.stopPropagation();
      event.preventDefault();
    };
    window.addEventListener("click", swallowClick, true);
    setTimeout(() => window.removeEventListener("click", swallowClick, true), 0);

    if (result) {
      onDrop(finished.taskId, result.columnId, result.index);
    }
  }
}
