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
) {
  return callBackendMethod("calculate_penalty", {
    debts: debts,
    payments: payments,
    period_end_date: periodEndDate,
    daily_rate_percent: dailyRatePercent,
    rate_type: rateType,
    cap_percent: capPercent,
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
