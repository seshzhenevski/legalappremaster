// result-modal.js
// Всплывающее окно об итоге долгой операции (готово / ошибка).
//
// Один общий модальный компонент для всех вкладок — показывает крупную
// иконку (галочка/восклицательный знак), заголовок и текст, закрывается
// по кнопке или клику вне окна.

/**
 * Показывает модальное окно с результатом операции.
 *
 * Принимает объект { success, title, message, buttonText }. success
 * определяет цвет/иконку (зелёная галочка или красное предупреждение).
 */
export function showResultModal({ success, title, message, buttonText = "Понятно" }) {
  const modal = document.getElementById("result-modal");
  const icon = document.getElementById("result-modal-icon");
  const iconBaseClass = "mx-auto w-16 h-16 rounded-full flex items-center justify-center text-3xl";

  icon.textContent = success ? "✓" : "!";
  icon.className = success
    ? `${iconBaseClass} bg-green-100 text-green-600`
    : `${iconBaseClass} bg-red-100 text-red-600`;

  document.getElementById("result-modal-title").textContent = title;
  document.getElementById("result-modal-message").textContent = message;

  const closeButton = document.getElementById("result-modal-close-button");
  closeButton.textContent = buttonText;
  modal.classList.remove("hidden");

  const closeModal = () => {
    modal.classList.add("hidden");
    closeButton.removeEventListener("click", closeModal);
    modal.removeEventListener("click", onBackdropClick);
  };
  const onBackdropClick = (event) => {
    if (event.target === modal) {
      closeModal();
    }
  };

  closeButton.addEventListener("click", closeModal);
  modal.addEventListener("click", onBackdropClick);
}
