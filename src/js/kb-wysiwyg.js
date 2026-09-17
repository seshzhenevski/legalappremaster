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
 * Создаёт кнопку вставки ссылки на статью базы.
 *
 * У библиотеки есть своя кнопка ссылки, но она спрашивает адрес, а ссылка
 * на статью хранится идентификатором, который человек знать не обязан —
 * статью нужно выбирать из списка.
 */
function buildArticleLinkButton(onInsertArticleLink) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "toastui-editor-toolbar-icons kb-toolbar-article-link";
  // Подсказку рисует сама библиотека по полю tooltip элемента панели;
  // собственный title дал бы вторую, системную, поверх неё.
  button.textContent = "⧉";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    if (onInsertArticleLink) {
      onInsertArticleLink();
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
  { container, markdown, isDark, onChange, onInsertArticleLink },
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
      name: "kbArticleLink",
      tooltip: "Ссылка на статью базы знаний",
      el: buildArticleLinkButton(onInsertArticleLink),
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
     * Вставляет ссылку на статью в место курсора.
     *
     * Принимает идентификатор статьи и подпись. Используется штатная команда
     * редактора, а не вставка текста: вставленный текст библиотека считает
     * обычными символами и экранирует служебные знаки, из-за чего в статье
     * оказывалось «\[Заголовок\]\(kb-...\)» вместо рабочей ссылки.
     */
    insertArticleLink(articleId, label) {
      editor.exec("addLink", { linkUrl: articleId, linkText: label });
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
