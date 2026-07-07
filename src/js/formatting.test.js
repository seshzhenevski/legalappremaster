// formatting.test.js
// Юнит-тесты общих функций форматирования интерфейса.
// Запуск: node --test src/js/formatting.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseAmountInput,
  formatAmountAsRubles,
  isValidInn,
} from "./formatting.js";

test("parseAmountInput принимает точку как разделитель", () => {
  assert.equal(parseAmountInput("1234.56"), 1234.56);
});

test("parseAmountInput принимает запятую как разделитель", () => {
  assert.equal(parseAmountInput("1234,56"), 1234.56);
});

test("parseAmountInput убирает пробелы-разделители тысяч", () => {
  assert.equal(parseAmountInput("1 234 567,89"), 1234567.89);
});

test("formatAmountAsRubles форматирует с пробелом и запятой", () => {
  assert.equal(formatAmountAsRubles(1234567.89), "1 234 567,89");
});

test("formatAmountAsRubles добавляет две цифры копеек", () => {
  assert.equal(formatAmountAsRubles(1000), "1 000,00");
});

test("isValidInn принимает 10 цифр", () => {
  assert.equal(isValidInn("7710929008"), true);
});

test("isValidInn принимает 12 цифр", () => {
  assert.equal(isValidInn("500100732259"), true);
});

test("isValidInn отклоняет неверную длину", () => {
  assert.equal(isValidInn("12345"), false);
});
