# Юридический инструментарий — Tauri 2 + Python

Десктопное приложение: генерация исков, расчёт неустойки и госпошлины.
Интерфейс на HTML/Tailwind/JS, логика на Python, оболочка на Tauri 2.

> 📦 **Никогда не собирали приложение?** Пошаговая инструкция с нуля —
> в файле **[BUILD_INSTRUCTIONS.md](BUILD_INSTRUCTIONS.md)**. Она проведёт
> от чистой Windows до готового установщика без опыта программирования.

## Архитектура

```
┌─────────────────────────────────────────────┐
│  Фронтенд (src/)                             │
│  HTML + Tailwind + JS                        │
│  index.html, js/tab-*.js                     │
│         │ invoke("send_rpc_request")         │
│         ▼                                     │
│  Tauri-оболочка (src-tauri/)                 │
│  Rust: команда send_rpc_request              │
│         │ запуск sidecar, stdin/stdout       │
│         ▼                                     │
│  Python-sidecar (src-python/)                │
│  main.py → rpc/ → logic/ → legal_tools/      │
└─────────────────────────────────────────────┘
```

**Правило слоёв:** интерфейс знает о логике, логика об интерфейсе — нет.
- `src/js/backend-api.js` — единственный мост фронтенда к бэкенду
- `src-python/logic/` — чистая логика, не знает о Tauri, RPC или HTML

## Требования для сборки

| Инструмент | Назначение |
|-----------|-----------|
| Rust + Cargo | компиляция Tauri-оболочки |
| Node.js + npm | Tauri CLI |
| Python 3.10+ | сборка sidecar |
| PyInstaller | упаковка Python в .exe |

Установка Tauri CLI:
```bash
npm install
```

## Сборка (на Windows)

```bash
# 1. Собрать Python-sidecar в бинарник
npm run build:sidecar

# 2. Собрать всё приложение в .exe-установщик
npm run build
```

Результат: `src-tauri/target/release/bundle/` — установщик (.msi / .exe).

## Разработка

```bash
npm run build:sidecar   # один раз, чтобы sidecar появился
npm run dev             # запуск с горячей перезагрузкой
```

## Тесты

```bash
npm run test:backend    # 26 тестов Python (логика + RPC-контракт)
npm run test:frontend   # 8 тестов JS (форматирование)
```

## Методы JSON-RPC

| Метод | Назначение |
|-------|-----------|
| `calculate_state_duty` | расчёт госпошлины |
| `calculate_penalty` | расчёт неустойки (FIFO) |
| `find_company_by_inn` | поиск реквизитов по ИНН (DaData) |
| `generate_lawsuit` | генерация пакета: иск + опись + платёжка |
| `sort_documents` | сборка пакетов Счёт + Акт + УПД |

Добавление метода: функция в `logic/`, строка в `rpc/dispatcher.py`,
обёртка в `src/js/backend-api.js`.
