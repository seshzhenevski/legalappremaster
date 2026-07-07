// formatting.js
// Общие функции форматирования для интерфейса.
//
// Вынесены отдельно по принципу DRY: форматирование денег и парсинг
// пользовательского ввода используются в нескольких вкладках.

/**
 * Преобразует введённую пользователем строку суммы в число.
 *
 * Убирает пробелы-разделители тысяч и заменяет запятую на точку,
 * чтобы принять и «1 234,56», и «1234.56». Возвращает число или NaN.
 */
export function parseAmountInput(rawAmountText) {
  const normalizedText = rawAmountText
    .replace(/\s/g, "")
    .replace(",", ".");
  return parseFloat(normalizedText);
}

/**
 * Форматирует число как денежную сумму в рублях.
 *
 * Возвращает строку вида «1 234,56» с пробелом-разделителем тысяч
 * и запятой перед копейками (российский формат).
 */
export function formatAmountAsRubles(amount) {
  return amount
    .toLocaleString("ru-RU", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
    .replace(/\u00a0/g, " ");
}

/**
 * Проверяет, что строка содержит корректный ИНН (10 или 12 цифр).
 *
 * Возвращает true, если после удаления нецифровых символов остаётся
 * ровно 10 или 12 цифр.
 */
export function isValidInn(innText) {
  const digitsOnly = innText.replace(/\D/g, "");
  return digitsOnly.length === 10 || digitsOnly.length === 12;
}
