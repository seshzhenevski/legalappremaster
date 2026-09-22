// kb-dialog.js
// Диалоги подтверждения и ввода для вкладки базы знаний.
//
// Собственные, а не системные window.confirm / window.prompt. Причины две:
// prompt в WebView2 на Windows не поддерживается вовсе и молча возвращает
// пустой результат, а системные окна не подчиняются теме приложения —
// в тёмной теме они выглядят чужеродно.
//
// Обе функции возвращают обещание: вызывающий код пишется линейно, как с
// обычным await, без колбэков.

let activeResolve = null;

/**
 * Создаёт (один раз) разметку диалога и возвращает её элементы.
 *
 * Диалог живёт в конце body и позиционируется поверх всего окна, поэтому
 * не зависит от того, какая вкладка открыта и как свёрстана панель.
 */
function ensureDialogElements() {
  let overlay = document.getElementById("kb-modal-overlay");
  if (overlay) {
    return readElements(overlay);
  }

  overlay = document.createElement("div");
  overlay.id = "kb-modal-overlay";
  overlay.className = "kb-modal-overlay hidden";
  overlay.innerHTML = `
    <div class="kb-modal" role="dialog" aria-modal="true">
      <p class="kb-modal-title"></p>
      <p class="kb-modal-text"></p>
      <input class="kb-modal-input hidden" type="text">
      <div class="kb-modal-actions">
        <button type="button" class="kb-modal-cancel"></button>
        <button type="button" class="kb-modal-confirm"></button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const elements = readElements(overlay);
  elements.cancelButton.addEventListener("click", () => finish(null));
  elements.confirmButton.addEventListener("click", () => confirmFromInput(elements));

  elements.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      confirmFromInput(elements);
    }
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      finish(null);
    }
  });
  // Клик мимо окна равнозначен отказу — как в системных диалогах.
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) {
      finish(null);
    }
  });

  return elements;
}

/**
 * Достаёт элементы диалога из готовой разметки.
 */
function readElements(overlay) {
  return {
    overlay: overlay,
    title: overlay.querySelector(".kb-modal-title"),
    text: overlay.querySelector(".kb-modal-text"),
    input: overlay.querySelector(".kb-modal-input"),
    cancelButton: overlay.querySelector(".kb-modal-cancel"),
    confirmButton: overlay.querySelector(".kb-modal-confirm"),
  };
}

/**
 * Подтверждает диалог, отдавая текст поля либо признак согласия.
 */
function confirmFromInput(elements) {
  if (elements.input.classList.contains("hidden")) {
    finish(true);
    return;
  }
  const value = elements.input.value.trim();
  if (value) {
    finish(value);
  }
}

/**
 * Закрывает диалог и отдаёт результат ожидающему коду.
 */
function finish(result) {
  const overlay = document.getElementById("kb-modal-overlay");
  if (overlay) {
    overlay.classList.add("hidden");
  }
  const resolve = activeResolve;
  activeResolve = null;
  if (resolve) {
    resolve(result);
  }
}

/**
 * Показывает диалог и возвращает обещание с его результатом.
 *
 * Принимает заголовок, пояснение, подписи кнопок, признак опасного действия
 * и начальное значение поля ввода (если поле нужно).
 */
function openDialog(options) {
  const elements = ensureDialogElements();

  elements.title.textContent = options.title || "";
  elements.text.textContent = options.text || "";
  elements.text.classList.toggle("hidden", !options.text);
  elements.confirmButton.textContent = options.confirmLabel || "Продолжить";
  elements.cancelButton.textContent = options.cancelLabel || "Отмена";
  elements.confirmButton.classList.toggle("kb-modal-danger", Boolean(options.danger));

  const needsInput = typeof options.initialValue === "string";
  elements.input.classList.toggle("hidden", !needsInput);
  elements.input.value = needsInput ? options.initialValue : "";

  elements.overlay.classList.remove("hidden");
  if (needsInput) {
    elements.input.focus();
    elements.input.select();
  } else {
    elements.confirmButton.focus();
  }

  return new Promise((resolve) => {
    // Предыдущий диалог, если он почему-то остался открытым, закрываем
    // отказом — два ожидающих обещания разом привели бы к потерянному ответу.
    if (activeResolve) {
      activeResolve(null);
    }
    activeResolve = resolve;
  });
}

/**
 * Спрашивает подтверждение действия.
 *
 * Возвращает true, если пользователь согласился, и false в остальных
 * случаях — включая закрытие окна мимо кнопок.
 */
export async function askConfirm(options) {
  const answer = await openDialog(options);
  return answer === true;
}

/**
 * Запрашивает у пользователя строку.
 *
 * Возвращает введённый текст без пробелов по краям либо null, если
 * пользователь отказался. Пустую строку подтвердить нельзя.
 */
export async function askText(options) {
  const answer = await openDialog({ ...options, initialValue: options.initialValue || "" });
  return typeof answer === "string" ? answer : null;
}

/**
 * Предлагает выбрать одно значение из списка.
 *
 * Принимает заголовок и записи вида {value, label, hint}. Возвращает
 * выбранное значение либо null. Список, а не поле ввода: и путь раздела,
 * и идентификатор статьи печатать руками — верный способ ошибиться.
 */
export function askChoice(title, items) {
  const elements = ensureDialogElements();

  elements.title.textContent = title;
  elements.text.classList.add("hidden");
  elements.input.classList.add("hidden");
  elements.confirmButton.classList.add("hidden");
  elements.cancelButton.textContent = "Отмена";

  let list = elements.overlay.querySelector(".kb-modal-list");
  if (!list) {
    list = document.createElement("div");
    list.className = "kb-modal-list thin-scroll";
    elements.overlay.querySelector(".kb-modal")
      .insertBefore(list, elements.overlay.querySelector(".kb-modal-actions"));
  }
  list.classList.remove("hidden");
  list.innerHTML = "";

  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "kb-modal-list-item";

    const label = document.createElement("span");
    label.className = "kb-modal-list-label";
    label.textContent = item.label;
    button.appendChild(label);

    if (item.hint) {
      const hint = document.createElement("span");
      hint.className = "kb-modal-list-hint";
      hint.textContent = item.hint;
      button.appendChild(hint);
    }

    button.addEventListener("click", () => {
      list.classList.add("hidden");
      elements.confirmButton.classList.remove("hidden");
      finish(item.value);
    });
    list.appendChild(button);
  });

  elements.overlay.classList.remove("hidden");

  return new Promise((resolve) => {
    if (activeResolve) {
      activeResolve(null);
    }
    activeResolve = (result) => {
      list.classList.add("hidden");
      elements.confirmButton.classList.remove("hidden");
      resolve(typeof result === "string" ? result : null);
    };
  });
}
