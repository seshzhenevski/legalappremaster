// toast.js
// Короткое всплывающее уведомление (например, «Скопировано в буфер обмена»).
//
// Один переиспользуемый элемент на всё приложение — появляется внизу
// экрана и исчезает сам через заданное время.

let toastElement = null;
let hideTimeoutId = null;

/**
 * Показывает короткое уведомление внизу экрана.
 *
 * Принимает текст сообщения и необязательную длительность показа в
 * миллисекундах (по умолчанию 2000). Повторный вызов во время показа
 * сбрасывает таймер и заменяет текст.
 */
export function showToast(message, durationMs = 2000) {
  if (!toastElement) {
    toastElement = document.createElement("div");
    toastElement.id = "app-toast";
    toastElement.className =
      "fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-sm " +
      "px-4 py-2 rounded-lg shadow-lg opacity-0 pointer-events-none transition-opacity " +
      "duration-200 z-30";
    document.body.appendChild(toastElement);
  }

  toastElement.textContent = message;
  toastElement.classList.remove("opacity-0");
  toastElement.classList.add("opacity-100");

  clearTimeout(hideTimeoutId);
  hideTimeoutId = setTimeout(() => {
    toastElement.classList.remove("opacity-100");
    toastElement.classList.add("opacity-0");
  }, durationMs);
}
