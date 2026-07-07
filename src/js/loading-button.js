// loading-button.js
// Индикатор занятости на кнопках долгих действий.
//
// Единственная задача — визуально показать, что после клика приложение
// действительно выполняет работу, а не зависло. Отключает кнопку, заменяет
// её содержимое на спиннер + текст на время выполнения, затем восстанавливает
// исходное содержимое.

/**
 * Включает или выключает состояние «занято» на кнопке.
 *
 * Принимает элемент кнопки, флаг занятости и текст, показываемый во время
 * ожидания. При включении запоминает исходное содержимое кнопки в её
 * dataset, чтобы восстановить один в один после завершения.
 */
export function setButtonBusy(button, isBusy, busyText = "Выполняется…") {
  if (isBusy) {
    if (button.dataset.originalContent === undefined) {
      button.dataset.originalContent = button.innerHTML;
    }
    button.disabled = true;
    button.innerHTML = `
      <span class="inline-block w-4 h-4 border-2 border-current border-t-transparent
                   rounded-full animate-spin align-[-2px]"></span>
      <span>${busyText}</span>
    `;
  } else {
    button.disabled = false;
    if (button.dataset.originalContent !== undefined) {
      button.innerHTML = button.dataset.originalContent;
      delete button.dataset.originalContent;
    }
  }
}

/**
 * Оборачивает асинхронную функцию индикатором занятости на кнопке.
 *
 * Включает состояние «занято» перед вызовом, гарантированно выключает
 * его после (даже если функция бросит исключение — ошибку пробрасывает
 * дальше вызывающему коду).
 */
export async function withButtonBusy(button, busyText, asyncFunction) {
  setButtonBusy(button, true, busyText);
  try {
    return await asyncFunction();
  } finally {
    setButtonBusy(button, false);
  }
}
