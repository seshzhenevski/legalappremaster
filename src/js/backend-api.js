// backend-api.js
// Слой связи с Python-бэкендом.
//
// Это единственный модуль фронтенда, который знает о существовании sidecar
// и протоколе Tauri. Все вкладки вызывают функции отсюда и не знают, как
// именно данные попадают в Python. Интерфейс знает о логике через этот слой,
// но логика ничего не знает об интерфейсе.

/**
 * Отправляет один RPC-запрос Python-бэкенду и возвращает результат.
 *
 * Принимает имя метода, объект параметров и необязательный колбэк
 * onProgress(payload). Если колбэк передан, подписывается на событие
 * "rpc-progress" (промежуточные сообщения, которые sidecar присылает до
 * финального ответа для долгих методов) на время вызова и отписывается
 * сразу после. Если подписка недоступна в этой версии Tauri — молча
 * работает без промежуточных сообщений (не ломает сам вызов). Бросает
 * исключение с текстом ошибки, если бэкенд вернул поле error.
 */
async function callBackendMethod(methodName, params, onProgress) {
  const { invoke } = window.__TAURI__.core;

  let unlisten = null;
  if (onProgress) {
    try {
      const { listen } = window.__TAURI__.event;
      unlisten = await listen("rpc-progress", (event) => onProgress(event.payload));
    } catch (error) {
      console.warn("Подписка на rpc-progress недоступна:", error);
    }
  }

  try {
    const response = await invoke("send_rpc_request", {
      method: methodName,
      params: params,
    });
    if (response.error) {
      throw new Error(response.error);
    }
    return response.result;
  } finally {
    if (unlisten) {
      unlisten();
    }
  }
}

/**
 * Запрашивает у бэкенда расчёт государственной пошлины.
 *
 * Принимает цену иска в рублях и возвращает объект с суммой пошлины
 * числом и суммой прописью.
 */
export async function requestStateDutyCalculation(claimAmount) {
  return callBackendMethod("calculate_state_duty", {
    claim_amount: claimAmount,
  });
}

/**
 * Запрашивает у бэкенда расчёт неустойки по задолженностям.
 *
 * Принимает массив задолженностей, массив платежей, дату окончания периода,
 * ставку в процентах, тип ставки ("day"/"year") и необязательное
 * ограничение неустойки в процентах. Возвращает итоговый долг, неустойку,
 * блоки расчёта и информацию об ограничении, если оно сработало.
 */
export async function requestPenaltyCalculation(
  debts,
  payments,
  periodEndDate,
  dailyRatePercent,
  rateType,
  capPercent,
  penaltyType = "contractual",
) {
  return callBackendMethod("calculate_penalty", {
    debts: debts,
    payments: payments,
    period_end_date: periodEndDate,
    daily_rate_percent: dailyRatePercent,
    rate_type: rateType,
    cap_percent: capPercent,
    penalty_type: penaltyType,
  });
}

/**
 * Запрашивает у бэкенда импорт задолженностей и платежей из Excel.
 *
 * Принимает путь к Excel-файлу. Возвращает списки долгов и платежей,
 * готовые для подстановки в форму расчёта неустойки.
 */
export async function requestPenaltyExcelImport(excelPath) {
  return callBackendMethod("import_penalty_excel", { excel_path: excelPath });
}

/**
 * Запрашивает у бэкенда реквизиты компании по ИНН.
 *
 * Принимает ИНН и API-ключ DaData. Возвращает объект с наименованием,
 * ОГРН, ИНН, КПП и адресом компании или null, если не найдена.
 */
export async function requestCompanyLookup(inn, apiKey) {
  return callBackendMethod("find_company_by_inn", {
    inn: inn,
    api_key: apiKey,
  });
}

/**
 * Запрашивает у бэкенда генерацию пакета документов по иску.
 *
 * Принимает объект запроса с реквизитами ответчика, путями к файлам и
 * параметрами расчёта, а также необязательный колбэк onProgress для живого
 * лога хода формирования. Возвращает итоговые пути и суммы.
 */
export async function requestLawsuitGeneration(lawsuitRequest, onProgress) {
  return callBackendMethod("generate_lawsuit", lawsuitRequest, onProgress);
}

/**
 * Запрашивает у бэкенда сборку пакетов документов из папки.
 *
 * Принимает объект запроса и необязательный колбэк onProgress для живого
 * лога хода обработки. Возвращает статистику созданных пакетов.
 */
export async function requestDocumentSorting(sortingRequest, onProgress) {
  return callBackendMethod("sort_documents", sortingRequest, onProgress);
}

/**
 * Запрашивает у бэкенда генерацию платёжного поручения на госпошлину.
 *
 * Принимает путь сохранения, сумму пошлины, наименование ответчика, сумму
 * иска и дату платежа. Возвращает путь к созданному PDF-файлу.
 */
export async function requestPaymentOrderPdf(paymentOrderRequest) {
  return callBackendMethod("generate_payment_order_pdf", paymentOrderRequest);
}

/**
 * Запрашивает у бэкенда генерацию досудебной претензии.
 *
 * Принимает объект запроса (реквизиты должника, номер/дата претензии,
 * номер/дата договора, сумма долга, папка с реестром) и необязательный
 * колбэк onProgress для живого лога. Возвращает пути к временным файлам
 * (DOCX, PDF, опись) и сводку для скачивания.
 */
export async function requestClaimGeneration(claimRequest, onProgress) {
  return callBackendMethod("generate_claim", claimRequest, onProgress);
}

/**
 * Запрашивает у бэкенда подсчёт итогов из загруженного Excel со счетами.
 *
 * Принимает путь к файлу. Возвращает общую сумму и реквизиты договора
 * (номер и дату) для автоподстановки в поля формы претензии.
 */
export async function requestClaimExcelSummary(excelPath) {
  return callBackendMethod("summarize_claim_excel", { excel_path: excelPath });
}

/**
 * Запрашивает у бэкенда сохранение готовой претензии в выбранное место.
 *
 * Принимает путь к временному файлу претензии, путь сохранения, путь к
 * временной описи и безопасное имя должника. Возвращает список сохранённых
 * файлов (претензия + опись рядом).
 */
export async function requestClaimExport(exportRequest) {
  return callBackendMethod("export_claim_document", exportRequest);
}

/**
 * Запрашивает у бэкенда претензию должника по ИНН из реестра.
 *
 * Принимает ИНН. Путь к реестру не передаётся — бэкенд берёт папку по
 * умолчанию из конфига. Возвращает номер и дату (ISO) последней претензии
 * этого должника или null, если строк с таким ИНН в реестре нет.
 */
export async function requestClaimByInn(inn) {
  return callBackendMethod("find_claim_by_inn", { inn: inn });
}

/**
 * Запрашивает у бэкенда показатели дашборда из Google-таблицы.
 *
 * Принимает путь к JSON-ключу сервисного аккаунта и идентификатор таблицы.
 * Возвращает посчитанные показатели сразу по всем годам и по каждому году
 * отдельно — интерфейс переключает годы без повторного запроса. Таблица
 * только читается.
 */
export async function requestDashboardData(credentialsPath, spreadsheetId) {
  return callBackendMethod("load_dashboard_data", {
    credentials_path: credentialsPath,
    spreadsheet_id: spreadsheetId,
  });
}

/**
 * Запрашивает у бэкенда базу знаний целиком.
 *
 * Принимает путь к корневой папке на сетевом диске. Возвращает признак
 * доступности папки, дерево разделов и все статьи с текстом. Загрузка идёт
 * одним вызовом намеренно: каждое обращение к бэкенду стоит около трёх
 * секунд, поэтому вкладка платит это один раз при открытии, а дальше
 * открывает статьи и ищет по ним из памяти.
 */
export async function requestKnowledgeBase(rootPath) {
  return callBackendMethod("load_knowledge_base", { root_path: rootPath });
}

/**
 * Запрашивает у бэкенда одну статью базы знаний заново.
 *
 * Принимает путь к корневой папке и относительный путь статьи. Нужен, когда
 * статью изменил коллега и её надо обновить, не перечитывая базу целиком.
 */
export async function requestKnowledgeBaseArticle(rootPath, relativePath) {
  return callBackendMethod("read_kb_article", {
    root_path: rootPath,
    relative_path: relativePath,
  });
}

/**
 * Сохраняет статью базы знаний.
 *
 * Принимает корень базы, относительный путь, свойства, текст и отпечаток
 * содержимого, полученный при открытии. Возвращает признак conflict, если
 * статью тем временем правил кто-то другой: в этом случае файл не
 * перезаписывается, а чужая версия приходит в ответе.
 */
export async function requestKnowledgeBaseSave(request) {
  return callBackendMethod("save_kb_article", request);
}

/**
 * Создаёт статью базы знаний.
 *
 * Принимает корень базы, раздел, заголовок, автора и необязательный готовый
 * текст. Возвращает карточку созданной статьи.
 */
export async function requestKnowledgeBaseCreate(request) {
  return callBackendMethod("create_kb_article", request);
}

/**
 * Захватывает статью на редактирование.
 *
 * Принимает корень базы, идентификатор статьи и признак перехвата брошенного
 * замка. Возвращает признак успеха и сведения о том, кто держит статью.
 */
export async function requestKnowledgeBaseLock(rootPath, articleId, force = false) {
  return callBackendMethod("acquire_kb_lock", {
    root_path: rootPath, article_id: articleId, force: force,
  });
}

/**
 * Снимает замок со статьи. Чужой замок не снимается.
 */
export async function requestKnowledgeBaseUnlock(rootPath, articleId) {
  return callBackendMethod("release_kb_lock", {
    root_path: rootPath, article_id: articleId,
  });
}

/**
 * Перечисляет снимки предыдущих версий статьи, новые первыми.
 */
export async function requestKnowledgeBaseVersions(rootPath, articleId) {
  return callBackendMethod("list_kb_versions", {
    root_path: rootPath, article_id: articleId,
  });
}

/**
 * Читает содержимое одного снимка версии — показать до восстановления.
 */
export async function requestKnowledgeBaseVersion(rootPath, articleId, versionName) {
  return callBackendMethod("read_kb_version", {
    root_path: rootPath, article_id: articleId, version_name: versionName,
  });
}

/**
 * Восстанавливает статью из снимка версии.
 *
 * Восстановление идёт обычным сохранением, поэтому текущая версия сама
 * попадает в снимки и откат можно отменить.
 */
export async function requestKnowledgeBaseVersionRestore(request) {
  return callBackendMethod("restore_kb_version", request);
}

/**
 * Удаляет статью базы знаний в корзину.
 *
 * Принимает корень базы и относительный путь. Статья не стирается, а
 * переносится в служебную папку вместе с записью об исходном пути.
 */
export async function requestKnowledgeBaseDelete(rootPath, relativePath) {
  return callBackendMethod("delete_kb_article", {
    root_path: rootPath, relative_path: relativePath,
  });
}

/**
 * Перечисляет содержимое корзины, недавно удалённые первыми.
 */
export async function requestKnowledgeBaseTrash(rootPath) {
  return callBackendMethod("list_kb_trash", { root_path: rootPath });
}

/**
 * Возвращает статью из корзины на исходное место.
 */
export async function requestKnowledgeBaseTrashRestore(rootPath, entryId) {
  return callBackendMethod("restore_kb_trash_entry", {
    root_path: rootPath, entry_id: entryId,
  });
}

/**
 * Удаляет запись корзины окончательно.
 */
export async function requestKnowledgeBaseTrashPurge(rootPath, entryId) {
  return callBackendMethod("purge_kb_trash_entry", {
    root_path: rootPath, entry_id: entryId,
  });
}

/**
 * Переносит статью в другой раздел.
 *
 * Принимает корень базы, относительный путь статьи и раздел назначения.
 * Содержимое файла не меняется, идентификатор сохраняется.
 */
export async function requestKnowledgeBaseMove(rootPath, relativePath, targetFolder) {
  return callBackendMethod("move_kb_article", {
    root_path: rootPath,
    relative_path: relativePath,
    target_folder_relative_path: targetFolder,
  });
}

/**
 * Создаёт раздел базы знаний внутри указанного.
 */
export async function requestKnowledgeBaseFolderCreate(rootPath, parentPath, name) {
  return callBackendMethod("create_kb_folder", {
    root_path: rootPath, parent_relative_path: parentPath, folder_name: name,
  });
}

/**
 * Переименовывает раздел базы знаний.
 */
export async function requestKnowledgeBaseFolderRename(rootPath, folderPath, newName) {
  return callBackendMethod("rename_kb_folder", {
    root_path: rootPath, folder_relative_path: folderPath, new_name: newName,
  });
}

/**
 * Удаляет пустой раздел базы знаний.
 *
 * Раздел со статьями не удаляется — в ответе приходит их количество.
 */
export async function requestKnowledgeBaseFolderDelete(rootPath, folderPath) {
  return callBackendMethod("delete_kb_folder", {
    root_path: rootPath, folder_relative_path: folderPath,
  });
}

/**
 * Вкладывает документ в статью базы знаний.
 *
 * Принимает корень базы, идентификатор статьи и путь к исходному файлу.
 * Файл копируется в служебную папку рядом с базой; возвращается цель для
 * ссылки и имя файла.
 */
export async function requestKnowledgeBaseAttach(rootPath, articleId, sourcePath) {
  return callBackendMethod("attach_kb_document", {
    root_path: rootPath, article_id: articleId, source_path: sourcePath,
  });
}

/**
 * Проверяет, доступен ли файл по ссылке.
 *
 * Нужна перед открытием: база была прочитана раньше, и документ могли
 * удалить или отключить сетевой диск.
 */
export async function requestKnowledgeBaseDocumentCheck(rootPath, target) {
  return callBackendMethod("check_kb_document", {
    root_path: rootPath, target: target,
  });
}

