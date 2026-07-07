# Python Backend (Sidecar)

Бэкенд-логика приложения. Запускается Tauri как дочерний процесс (sidecar)
и общается с интерфейсом по JSON-RPC через stdin/stdout.

## Архитектура слоёв

```
main.py                  Цикл sidecar: читает stdin → пишет stdout
└── rpc/dispatcher.py    Связывает имена методов с функциями логики
    └── logic/           Чистая бизнес-логика (не знает об интерфейсе)
        ├── state_duty_calculator.py
        ├── penalty_calculator.py
        └── company_lookup.py
            └── legal_tools/   Переиспользуемое ядро (расчёты, генераторы)
```

**Правило слоёв:** `logic/` не импортирует `rpc/` или `main.py`.
Интерфейс знает о логике, логика об интерфейсе не знает.

## Протокол JSON-RPC (JSON Lines)

Запрос:  `{"id": 1, "method": "calculate_state_duty", "params": {...}}`
Ответ:   `{"id": 1, "result": {...}}` или `{"id": 1, "error": "..."}`

### Доступные методы

| Метод | Параметры | Результат |
|-------|-----------|-----------|
| `calculate_state_duty` | `claim_amount` | сумма пошлины + прописью |
| `calculate_penalty` | `debts`, `payments`, `period_end_date`, `daily_rate_percent` | итоги + блоки расчёта |
| `find_company_by_inn` | `inn`, `api_key` | реквизиты компании |

## Запуск и тесты

```bash
pip install -r requirements.txt

# Ручная проверка sidecar:
echo '{"id":1,"method":"calculate_state_duty","params":{"claim_amount":5000000}}' | python main.py

# Юнит-тесты:
python -m unittest discover tests -v
```

## Сборка sidecar в .exe (для Tauri)

```bash
pip install pyinstaller
pyinstaller --onefile --name legal-sidecar main.py
# результат: dist/legal-sidecar.exe
```
