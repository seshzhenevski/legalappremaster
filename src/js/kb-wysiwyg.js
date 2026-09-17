// kb-wysiwyg.js
// Обёртка над редактором Toast UI для режима «как в документе».
//
// Единственное место фронтенда, знающее о существовании этой библиотеки.
// Вкладка работает с ней через три операции: создать, забрать разметку,
// закрыть. Если редактор придётся заменить или убрать, меняется только
// этот файл.
//
// Наружу и внутрь ходит Markdown — тот же, что лежит в файлах на сетевом
// диске. Редактор выбран именно markdown-native: формат хранения по ТЗ
// менять нельзя, файлы должны оставаться читаемыми в проводнике и годными
// для передачи в RAG без конвертации.

// Набор кнопок ограничен тем форматированием, которое поддерживает наш
// отрисовщик: иначе в режиме «как в документе» можно было бы вставить то,
// что при просмотре статьи не отобразится.
const TOOLBAR_ITEMS = [
  ["heading", "bold", "italic"],
  ["hr", "quote"],
  ["ul", "ol", "task"],
  ["table", "link"],
  ["code", "codeblock"],
];

/**
 * Создаёт редактор в указанном контейнере.
 *
 * Принимает элемент-контейнер, начальную разметку, признак тёмной темы и
 * колбэк изменения. Возвращает объект с методами получения разметки и
 * закрытия.
 *
 * Телеметрия отключена явно: библиотека по умолчанию отправляет наружу имя
 * хоста при каждом запуске, а это внутренний инструмент юридического отдела.
 */
export function createVisualEditor({ container, markdown, isDark, onChange }) {
  const EditorConstructor = window.ToastUIEditor?.default || window.ToastUIEditor;
  if (!EditorConstructor) {
    throw new Error("Редактор не загружен");
  }

  container.classList.toggle("toastui-editor-dark", Boolean(isDark));

  const editor = new EditorConstructor({
    el: container,
    height: "100%",
    initialEditType: "wysiwyg",
    hideModeSwitch: true,
    // Предпросмотр вкладками не нужен: режим разметки у нас свой, а
    // библиотечный редактор Markdown не показывается никогда.
    previewStyle: "vertical",
    usageStatistics: false,
    language: "ru-RU",
    initialValue: markdown || "",
    toolbarItems: TOOLBAR_ITEMS,
    autofocus: false,
    events: {
      change: () => {
        if (onChange) {
          onChange();
        }
      },
    },
  });

  return {
    /**
     * Возвращает текущее содержимое статьи в Markdown.
     */
    getMarkdown() {
      return editor.getMarkdown();
    },

    /**
     * Заменяет содержимое редактора.
     */
    setMarkdown(text) {
      editor.setMarkdown(text || "", false);
    },

    /**
     * Переключает оформление редактора вслед за темой приложения.
     */
    setDark(dark) {
      container.classList.toggle("toastui-editor-dark", Boolean(dark));
    },

    /**
     * Ставит курсор в текст статьи.
     */
    focus() {
      editor.focus();
    },

    /**
     * Закрывает редактор и убирает его разметку из документа.
     *
     * Вызывается при каждом выходе из правки: оставленный экземпляр держит
     * обработчики событий и подписки, а статью открывают десятки раз за день.
     */
    destroy() {
      editor.destroy();
      container.innerHTML = "";
    },
  };
}
