// date-picker.js
// Кастомный минималистичный календарь взамен нативного input[type="date"].
//
// Каждое поле даты — пара инпутов: скрытый <input type="hidden"> хранит
// ISO-значение (ГГГГ-ММ-ДД), видимый текстовый инпут (readonly) показывает
// дату в формате ДД.ММ.ГГГГ и открывает один общий на всё приложение
// всплывающий календарь. createDateField() возвращает готовый DOM-узел —
// вкладки вставляют его в разметку вместо прежнего <input type="date">.

const MONTH_NAMES = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];
const WEEKDAY_LABELS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

let popupElement = null;
let activeHiddenInput = null;
let activeDisplayInput = null;
let viewYear = 0;
let viewMonth = 0;
let globalListenersAttached = false;

/**
 * Инициализирует общий всплывающий календарь (один на всё приложение).
 *
 * Создаёт DOM попапа и вешает глобальные обработчики закрытия по клику вне
 * попапа и по Escape. Безопасно вызывать один раз при старте приложения,
 * до создания самих полей даты.
 */
export function initDatePickers() {
  ensurePopup();
  if (globalListenersAttached) {
    return;
  }
  globalListenersAttached = true;

  document.addEventListener("click", (event) => {
    if (!popupElement || popupElement.classList.contains("hidden")) {
      return;
    }
    const clickedInsidePopup = popupElement.contains(event.target);
    const clickedActiveDisplay = event.target === activeDisplayInput;
    if (!clickedInsidePopup && !clickedActiveDisplay) {
      closePopup();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closePopup();
    }
  });
}

/**
 * Создаёт готовое поле даты и возвращает его корневой DOM-элемент.
 *
 * Принимает необязательные id (для полей, к которым обращается остальной
 * код по фиксированному id, — обычные статичные поля формы) и
 * extraHiddenClass (для динамически создаваемых строк, которые находят
 * своё поле даты через querySelector по классу, а не по id, — как строки
 * задолженностей/платежей в калькуляторе неустойки). Значение по умолчанию
 * — пустое; проставить исходное значение можно через параметр value (ISO).
 */
export function createDateField({ id = "", extraHiddenClass = "", value = "", compact = false } = {}) {
  ensurePopup();

  const wrapper = document.createElement("div");
  wrapper.className = "relative";
  const paddingClass = compact ? "px-2 py-1.5" : "px-3 py-2";
  wrapper.innerHTML = `
    <input type="hidden" ${id ? `id="${id}"` : ""} class="${extraHiddenClass}" value="${value}" />
    <input type="text" readonly placeholder="дд.мм.гггг"
      class="date-field-display w-full ${paddingClass} border border-slate-300 rounded-lg
             text-sm cursor-pointer bg-white hover:border-slate-400" />
  `;

  const hiddenInput = wrapper.querySelector("input[type=hidden]");
  const displayInput = wrapper.querySelector(".date-field-display");
  displayInput.value = formatIsoToDisplay(value);

  displayInput.addEventListener("click", () => {
    openPopup(hiddenInput, displayInput);
  });

  displayInput.addEventListener("paste", (event) => {
    event.preventDefault();
    const pastedText = (event.clipboardData || window.clipboardData).getData("text");
    const iso = parseFlexibleDateString(pastedText);
    if (!iso) {
      return;
    }
    hiddenInput.value = iso;
    hiddenInput.dispatchEvent(new Event("change"));
    displayInput.value = formatIsoToDisplay(iso);
    closePopup();
  });

  return wrapper;
}

/**
 * Разбирает дату из вставленного текста в разных распространённых форматах.
 *
 * Принимает произвольный текст из буфера обмена (например, скопированный
 * из Excel, документа или другого поля приложения). Понимает форматы
 * ДД.ММ.ГГГГ, ДД.ММ.ГГ, ДД/ММ/ГГГГ и ГГГГ-ММ-ДД. Возвращает ISO-строку
 * (ГГГГ-ММ-ДД) или null, если формат не распознан.
 */
function parseFlexibleDateString(text) {
  const trimmed = (text || "").trim();

  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return buildIsoIfValid(Number(year), Number(month), Number(day));
  }

  const dottedOrSlashMatch = trimmed.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})$/);
  if (dottedOrSlashMatch) {
    const [, day, month, yearRaw] = dottedOrSlashMatch;
    const year = yearRaw.length === 2 ? Number(yearRaw) + 2000 : Number(yearRaw);
    return buildIsoIfValid(year, Number(month), Number(day));
  }

  return null;
}

/**
 * Собирает ISO-строку даты из компонентов, если они образуют реальную дату.
 *
 * Проверяет диапазоны и то, что итоговая дата не "переносится" на другой
 * месяц (защита от значений вроде 31.02). Возвращает null при некорректных
 * компонентах.
 */
function buildIsoIfValid(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return formatDateToIso(date);
}

/**
 * Программно устанавливает значение поля даты по его id.
 *
 * Обновляет и скрытый ISO-инпут, и видимый форматированный текст рядом с
 * ним. Используется формами очистки/значений по умолчанию (например,
 * простановка сегодняшней даты), которые раньше писали в .value напрямую.
 */
export function setDateFieldValue(fieldId, isoValue) {
  const hiddenInput = document.getElementById(fieldId);
  if (!hiddenInput) {
    return;
  }
  hiddenInput.value = isoValue || "";
  const displayInput = hiddenInput.nextElementSibling;
  if (displayInput && displayInput.classList.contains("date-field-display")) {
    displayInput.value = formatIsoToDisplay(isoValue || "");
  }
}

/**
 * Строит DOM-элемент попапа календаря один раз и добавляет его в body.
 */
function ensurePopup() {
  if (popupElement) {
    return;
  }
  popupElement = document.createElement("div");
  popupElement.id = "date-picker-popup";
  popupElement.className =
    "hidden fixed z-50 bg-white rounded-2xl shadow-lg border border-slate-200 p-4 w-72";
  popupElement.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <button type="button" class="date-picker-prev w-7 h-7 flex items-center justify-center
                                    rounded-full hover:bg-slate-100 text-slate-500">‹</button>
      <div class="date-picker-month-label text-sm font-medium text-slate-700"></div>
      <button type="button" class="date-picker-next w-7 h-7 flex items-center justify-center
                                    rounded-full hover:bg-slate-100 text-slate-500">›</button>
    </div>
    <div class="grid grid-cols-7 gap-1 text-center text-xs text-slate-400 mb-1">
      ${WEEKDAY_LABELS.map((day) => `<div>${day}</div>`).join("")}
    </div>
    <div class="date-picker-days grid grid-cols-7 gap-1"></div>
    <div class="flex justify-between mt-3 pt-3 border-t border-slate-100">
      <button type="button" class="date-picker-today text-xs text-blue-600 hover:text-blue-700">
        Сегодня
      </button>
      <button type="button" class="date-picker-done px-3 py-1 bg-blue-600 hover:bg-blue-700
                                    text-white text-xs rounded-lg">
        Готово
      </button>
    </div>
  `;
  document.body.appendChild(popupElement);

  popupElement.querySelector(".date-picker-prev").addEventListener("click", () => {
    viewMonth -= 1;
    if (viewMonth < 0) {
      viewMonth = 11;
      viewYear -= 1;
    }
    renderCalendar();
  });
  popupElement.querySelector(".date-picker-next").addEventListener("click", () => {
    viewMonth += 1;
    if (viewMonth > 11) {
      viewMonth = 0;
      viewYear += 1;
    }
    renderCalendar();
  });
  popupElement.querySelector(".date-picker-today").addEventListener("click", () => {
    selectDate(new Date());
  });
  popupElement.querySelector(".date-picker-done").addEventListener("click", closePopup);
}

/**
 * Открывает попап календаря для указанного поля и позиционирует его под ним.
 *
 * Разбирает текущее ISO-значение скрытого инпута (или берёт сегодняшнюю
 * дату), устанавливает отображаемый месяц/год и рисует календарь.
 */
function openPopup(hiddenInput, displayInput) {
  activeHiddenInput = hiddenInput;
  activeDisplayInput = displayInput;

  const currentDate = parseIsoDate(hiddenInput.value) || new Date();
  viewYear = currentDate.getFullYear();
  viewMonth = currentDate.getMonth();

  renderCalendar();

  const rect = displayInput.getBoundingClientRect();
  popupElement.style.top = `${rect.bottom + 6}px`;
  popupElement.style.left = `${rect.left}px`;
  popupElement.classList.remove("hidden");
}

/**
 * Закрывает попап календаря и сбрасывает активное поле.
 */
function closePopup() {
  if (popupElement) {
    popupElement.classList.add("hidden");
  }
  activeHiddenInput = null;
  activeDisplayInput = null;
}

/**
 * Перерисовывает сетку дней текущего отображаемого месяца.
 *
 * Показывает серым дни соседних месяцев, обводкой — сегодняшний день,
 * заливкой — выбранную дату.
 */
function renderCalendar() {
  popupElement.querySelector(".date-picker-month-label").textContent =
    `${MONTH_NAMES[viewMonth]} ${viewYear}`;

  const selectedIso = activeHiddenInput ? activeHiddenInput.value : "";
  const today = new Date();
  const todayIso = formatDateToIso(today);

  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  // Понедельник = 0 ... воскресенье = 6 (JS getDay() возвращает 0 = воскресенье).
  const leadingBlankDays = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < leadingBlankDays; i++) {
    cells.push("<div></div>");
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const cellDate = new Date(viewYear, viewMonth, day);
    const iso = formatDateToIso(cellDate);
    const isToday = iso === todayIso;
    const isSelected = iso === selectedIso;

    let buttonClass = "w-8 h-8 rounded-full text-sm hover:bg-slate-100";
    if (isSelected) {
      buttonClass = "w-8 h-8 rounded-full text-sm bg-blue-600 text-white hover:bg-blue-700";
    } else if (isToday) {
      buttonClass = "w-8 h-8 rounded-full text-sm border-2 border-blue-600 text-blue-600 hover:bg-blue-50";
    }
    cells.push(
      `<button type="button" data-iso="${iso}" class="date-picker-day ${buttonClass}">${day}</button>`,
    );
  }

  const daysContainer = popupElement.querySelector(".date-picker-days");
  daysContainer.innerHTML = cells.join("");
  daysContainer.querySelectorAll(".date-picker-day").forEach((button) => {
    button.addEventListener("click", () => {
      selectDate(parseIsoDate(button.dataset.iso));
    });
  });
}

/**
 * Устанавливает выбранную дату в активное поле и закрывает попап.
 *
 * Принимает объект Date, записывает ISO-значение в скрытый инпут (совместимо
 * со всем остальным кодом, который читает .value) и форматированную дату —
 * в видимый инпут.
 */
function selectDate(date) {
  if (!activeHiddenInput || !activeDisplayInput) {
    return;
  }
  const iso = formatDateToIso(date);
  activeHiddenInput.value = iso;
  activeHiddenInput.dispatchEvent(new Event("change"));
  activeDisplayInput.value = formatIsoToDisplay(iso);
  closePopup();
}

/**
 * Форматирует объект Date в строку ГГГГ-ММ-ДД.
 */
function formatDateToIso(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Разбирает строку ГГГГ-ММ-ДД в объект Date. Возвращает null для пустой строки.
 */
function parseIsoDate(iso) {
  if (!iso) {
    return null;
  }
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Форматирует ISO-строку даты в формат ДД.ММ.ГГГГ для отображения.
 * Возвращает пустую строку, если значение не задано.
 */
function formatIsoToDisplay(iso) {
  if (!iso) {
    return "";
  }
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}
