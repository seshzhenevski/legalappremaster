// main.rs
// Исполняемая точка входа приложения.
//
// Прячет консольное окно на Windows в релизной сборке и передаёт
// управление в библиотечную функцию run() (см. lib.rs).

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

/// Запускает приложение.
///
/// Вызывает основную функцию run() из библиотечного крейта, где собрано
/// всё приложение Tauri.
fn main() {
    trivio_legal_lib::run();
}
