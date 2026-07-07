// lib.rs
// Ядро Tauri-приложения.
//
// Определяет команду send_rpc_request, которую вызывает фронтенд. Команда
// запускает Python-sidecar, передаёт ему один JSON-RPC-запрос через stdin,
// читает ответ из stdout и возвращает его фронтенду. Долгие методы могут
// присылать промежуточные строки прогресса ДО финального ответа — такие
// строки ретранслируются интерфейсу как события "rpc-progress" в реальном
// времени, не прерывая ожидание финального ответа.
//
// Подход «один запрос — один запуск sidecar» выбран намеренно (KISS):
// расчёты в приложении происходят по клику пользователя, а не потоком,
// поэтому короткоживущий процесс проще и надёжнее долгоживущего с мьютексом.

use serde_json::{json, Value};
use tauri::Emitter;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// Отправляет один JSON-RPC-запрос Python-sidecar и возвращает ответ.
///
/// Принимает имя метода и параметры от фронтенда. Собирает JSON-строку
/// запроса, запускает sidecar с этой строкой на входе, дожидается строки
/// ответа и разбирает её обратно в JSON. Возвращает объект с полем result
/// или error, как его сформировал Python.
#[tauri::command]
async fn send_rpc_request(
    app_handle: tauri::AppHandle,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let request_line = build_request_line(&method, &params);
    let response_line = run_sidecar_with_request(&app_handle, &request_line).await?;
    parse_response_line(&response_line)
}

/// Собирает строку JSON-RPC-запроса из имени метода и параметров.
///
/// Возвращает компактную JSON-строку без переводов строки внутри,
/// пригодную для передачи sidecar как одна строка (формат JSON Lines).
fn build_request_line(method: &str, params: &Value) -> String {
    let request = json!({
        "id": 1,
        "method": method,
        "params": params,
    });
    request.to_string()
}

/// Запускает sidecar с одним запросом на входе и возвращает строку ответа.
///
/// Передаёт строку запроса в stdin Python-процесса, собирает вывод stdout
/// до завершения процесса и возвращает первую непустую строку как ответ.
async fn run_sidecar_with_request(
    app_handle: &tauri::AppHandle,
    request_line: &str,
) -> Result<String, String> {
    let sidecar_command = app_handle
        .shell()
        .sidecar("legal-sidecar")
        .map_err(|error| format!("Sidecar не найден: {}", error))?;

    let (mut event_receiver, mut child) = sidecar_command
        .spawn()
        .map_err(|error| format!("Не удалось запустить sidecar: {}", error))?;

    let stdin_line = format!("{}\n", request_line);
    child
        .write(stdin_line.as_bytes())
        .map_err(|error| format!("Ошибка записи в sidecar: {}", error))?;

    collect_response_relaying_progress(app_handle, &mut event_receiver).await
}

/// Читает события sidecar, ретранслирует строки прогресса и возвращает
/// финальную строку ответа.
///
/// Каждую непустую строку stdout пытается разобрать как JSON. Строки с
/// полем "type": "progress" отправляются интерфейсу как событие
/// "rpc-progress" и не прерывают ожидание — цикл продолжается. Первая
/// строка без этого поля (финальный result/error от process_single_request)
/// возвращается как ответ. Строки, которые не удалось разобрать как JSON,
/// пропускаются (не должны встречаться при корректной работе sidecar).
async fn collect_response_relaying_progress(
    app_handle: &tauri::AppHandle,
    event_receiver: &mut tauri::async_runtime::Receiver<CommandEvent>,
) -> Result<String, String> {
    while let Some(event) = event_receiver.recv().await {
        if let CommandEvent::Stdout(line_bytes) = event {
            let line = String::from_utf8_lossy(&line_bytes).trim().to_string();
            if line.is_empty() {
                continue;
            }

            let parsed: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => continue,
            };

            let is_progress = parsed
                .get("type")
                .and_then(|value| value.as_str())
                .map(|value| value == "progress")
                .unwrap_or(false);

            if is_progress {
                let _ = app_handle.emit("rpc-progress", parsed);
                continue;
            }

            return Ok(line);
        }
    }
    Err("Sidecar не вернул ответ".to_string())
}

/// Разбирает строку ответа sidecar в JSON-значение.
///
/// Принимает строку stdout от Python и парсит её как JSON. Возвращает
/// разобранный объект или ошибку, если строка не является корректным JSON.
fn parse_response_line(response_line: &str) -> Result<Value, String> {
    serde_json::from_str(response_line)
        .map_err(|error| format!("Некорректный ответ sidecar: {}", error))
}

/// Точка входа Tauri-приложения.
///
/// Регистрирует плагин shell (нужен для запуска sidecar) и команду
/// send_rpc_request, затем запускает приложение с главным окном.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![send_rpc_request])
        .run(tauri::generate_context!())
        .expect("Ошибка запуска приложения Tauri");
}
