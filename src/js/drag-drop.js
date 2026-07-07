// drag-drop.js
// Поддержка перетаскивания файлов (drag-and-drop) поверх зон выбора Excel.
//
// Единственное место, где фронтенд подписывается на событие перетаскивания
// файлов Tauri. Вкладки регистрируют зону и колбэк, не зная деталей API.
//
// Доступ к Tauri API — только внутри функции (лениво), а не на верхнем
// уровне модуля: если API недоступен или называется иначе в установленной
// версии Tauri, это не должно ломать импорт модуля и, как следствие, всю
// остальную инициализацию приложения (drag-and-drop — необязательное
// удобство, а не критичная функция).

/**
 * Регистрирует зону перетаскивания Excel-файла.
 *
 * Принимает id DOM-элемента зоны и колбэк, который получает путь к файлу.
 * Подсвечивает зону при наведении перетаскиваемого файла и вызывает колбэк
 * с путём первого файла с расширением .xlsx/.xlsm/.xls при сбросе. Файлы
 * с другим расширением игнорируются без ошибки. Если API перетаскивания
 * недоступен в этой версии Tauri, тихо ничего не делает (не бросает
 * исключение наружу).
 */
export function registerExcelDropZone(zoneElementId, onFilePath) {
  try {
    const webviewApi = window.__TAURI__ && window.__TAURI__.webview;
    if (!webviewApi || typeof webviewApi.getCurrentWebview !== "function") {
      console.warn("Drag-and-drop недоступен: window.__TAURI__.webview не найден.");
      return;
    }

    const zoneElement = document.getElementById(zoneElementId);
    webviewApi.getCurrentWebview().onDragDropEvent((event) => {
      try {
        const paths = event.payload.paths || [];
        const isOverZone = isPointerOverElement(zoneElement, event.payload.position);

        if (event.payload.type === "over") {
          zoneElement.classList.toggle("drop-zone-active", isOverZone);
          return;
        }

        zoneElement.classList.remove("drop-zone-active");
        if (event.payload.type !== "drop" || !isOverZone) {
          return;
        }

        const excelPath = paths.find((path) => /\.(xlsx|xlsm|xls)$/i.test(path));
        if (excelPath) {
          onFilePath(excelPath);
        }
      } catch (error) {
        console.warn("Ошибка обработки drag-and-drop:", error);
      }
    }).catch((error) => {
      console.warn("Не удалось подписаться на drag-and-drop:", error);
    });
  } catch (error) {
    console.warn("Drag-and-drop недоступен:", error);
  }
}

/**
 * Проверяет, находится ли точка курсора в границах элемента.
 *
 * Принимает DOM-элемент и позицию курсора (объект с полями x/y в физических
 * пикселях окна). Возвращает true, если точка попадает в прямоугольник
 * элемента.
 */
function isPointerOverElement(element, position) {
  if (!position) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const x = position.x / scale;
  const y = position.y / scale;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
