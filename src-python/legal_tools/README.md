# Юридический инструментарий v5.0

Настольное приложение для юристов: генерация исковых заявлений, сортировка
документов, расчёт неустойки и госпошлины.

## Запуск

```bash
pip install -r requirements.txt
python -m legal_tools
```

На Windows без консольного окна:
```bash
pythonw -m legal_tools
```

## Структура

```
legal_tools/
├── __main__.py          Точка входа (python -m legal_tools)
├── config.py            Все константы: реквизиты, шкала госпошлины
│
├── core/                Чистая бизнес-логика (тестируемая, без UI/IO)
│   ├── formatting.py    Форматирование сумм, парсинг дат, кавычки
│   ├── penalty.py       Расчёт неустойки, FIFO-распределение платежей
│   └── duty.py          Госпошлина (ст. 333.21 НК РФ), сумма прописью
│
├── generators/          Генерация выходных файлов
│   ├── lawsuit_docx.py  Исковое заявление + опись (python-docx)
│   └── payment_pdf.py   Платёжное поручение (reportlab)
│
├── importers/           Чтение входных данных
│   ├── excel.py         Реестр счетов → группировка → расчёт иска
│   └── document_sorter.py  Поиск и слияние PDF закрывающих документов
│
├── assets/
│   └── embedded.py      Встроенные шрифты DejaVu + шаблон Опись (base64)
│
└── ui/                  Слой представления (PySide6)
    ├── styles.py        Единая таблица стилей (QSS)
    ├── widgets.py       Переиспользуемые компоненты + Qt-хелперы дат
    └── app.py           Вкладки, воркеры, главное окно
```

## Правило зависимостей

```
ui ──→ generators ──→ core
ui ──→ importers  ──→ core
ui ──→ config, assets
```

`core/` не импортирует ничего из `ui/`, `generators/`, `importers/` —
это чистая логика, которую можно тестировать изолированно.

## Тестирование ядра

```python
from legal_tools.core.duty import calculate_state_duty
from legal_tools.core.penalty import fifo_allocate

assert calculate_state_duty(5_000_000) == 175_000.0
```

## Сборка в .exe

```bash
pip install pyinstaller
pyinstaller --name "Юридический инструментарий" --windowed \
    --add-data "legal_tools/assets:legal_tools/assets" \
    -m legal_tools
```

Либо через spec-файл (см. build_exe.bat).
