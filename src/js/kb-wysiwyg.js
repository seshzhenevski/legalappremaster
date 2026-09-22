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
  ["table"],
  ["code", "codeblock"],
];

/**
 * Создаёт кнопку вставки ссылки.
 *
 * Заменяет штатную кнопку библиотеки: та умеет только адрес сайта, а нам
 * нужен выбор между сайтом и статьёй базы, причём статью человек выбирает
 * из списка — её идентификатор он знать не обязан.
 */
function buildArticleLinkButton(onInsertLink) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "toastui-editor-toolbar-icons kb-toolbar-article-link";
  // Подсказку рисует сама библиотека по полю tooltip элемента панели;
  // собственный title дал бы вторую, системную, поверх неё.
  button.textContent = "⧉";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    if (onInsertLink) {
      onInsertLink();
    }
  });
  return button;
}

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
export function createVisualEditor(
  { container, markdown, isDark, onChange, onInsertLink },
) {
  const EditorConstructor = window.ToastUIEditor?.default || window.ToastUIEditor;
  if (!EditorConstructor) {
    throw new Error("Редактор не загружен");
  }

  const editor = new EditorConstructor({
    el: container,
    theme: isDark ? "dark" : "light",
    height: "100%",
    initialEditType: "wysiwyg",
    hideModeSwitch: true,
    // Предпросмотр вкладками не нужен: режим разметки у нас свой, а
    // библиотечный редактор Markdown не показывается никогда.
    previewStyle: "vertical",
    usageStatistics: false,
    language: "ru-RU",
    initialValue: markdown || "",
    toolbarItems: TOOLBAR_ITEMS.concat([[{
      name: "kbLink",
      tooltip: "Ссылка на сайт или статью базы знаний",
      el: buildArticleLinkButton(onInsertLink),
    }]]),
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
     *
     * Класс тёмной темы вешается на корень самого редактора, а не на внешний
     * контейнер: главное правило её стилей требует, чтобы оба класса стояли
     * на одном элементе (.toastui-editor-dark.toastui-editor-defaultUI).
     * На контейнере срабатывала лишь часть правил, и поле оставалось светлым.
     */
    setDark(dark) {
      const root = container.querySelector(".toastui-editor-defaultUI");
      if (root) {
        root.classList.toggle("toastui-editor-dark", Boolean(dark));
      }
    },

    /**
     * Возвращает выделенный пользователем текст.
     *
     * Читается до открытия диалога: пока человек выбирает, куда ведёт
     * ссылка, выделение в редакторе успевает сброситься.
     */
    getSelectedText() {
      return editor.getSelectedText() || "";
    },

    /**
     * Вставляет ссылку в место курсора, оставляя подпись как есть.
     *
     * Принимает адрес (или идентификатор статьи) и текст ссылки.
     * Используется штатная команда редактора, а не вставка текста:
     * вставленный текст библиотека считает обычными символами и экранирует
     * служебные знаки, из-за чего получалось «\[Заголовок\]\(kb-...\)»
     * вместо рабочей ссылки.
     */
    insertLink(url, label) {
      editor.exec("addLink", { linkUrl: url, linkText: label });
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
