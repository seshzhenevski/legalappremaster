# -*- coding: utf-8 -*-
"""
Тесты аналитики дашборда по судебным делам.

Работают на данных-заглушках: сеть и реальная Google-таблица здесь не нужны —
проверяется чистая функция build_dashboard_data, которая получает сырые строки
листов ровно в том виде, в каком их отдаёт Sheets API.

Заголовки и статусы в тестах — те же, что в рабочем реестре («ПДЗ», «Истец» в
колонке-разделителе, «Взыскание» с номером исполнительного производства,
статусы вида «Долг погашен /Досудебное урег-е»).

Главный акцент — устойчивость к пропускам: реестр ведут руками, и пустая
ячейка в любом столбце должна быть нормальной рабочей ситуацией, а не поводом
уронить расчёт или молча выбросить дело из статистики.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import unittest

from logic.court_cases_dashboard import build_dashboard_data


CASE_HEADER = [
    "Истец", "Должник", "ИНН", "В работе", "Передано в суд", "Номер дела",
    "Суд", "ПДЗ", "Неустойка", "Суд расходы", "Решение", "Сумма", "Взыскание",
    "Долг погашен", "Комментарии", "Статус",
]

BANKRUPTCY_HEADER = [
    "Кредитор", "Должник", "Номер дела", "Суд", "Стадия", "Сумма", "Комментарии",
]


def case_row(**fields) -> list:
    """Собирает строку листа «СУДЫ»: указываются только нужные колонки."""
    by_title = {
        "section": "Истец", "debtor": "Должник", "inn": "ИНН",
        "in_work": "В работе", "court_date": "Передано в суд",
        "case_number": "Номер дела", "court": "Суд", "principal": "ПДЗ",
        "penalty": "Неустойка", "court_costs": "Суд расходы", "decision": "Решение",
        "total": "Сумма", "enforcement": "Взыскание", "recovered": "Долг погашен",
        "comments": "Комментарии", "status": "Статус",
    }
    row = [""] * len(CASE_HEADER)
    for name, value in fields.items():
        row[CASE_HEADER.index(by_title[name])] = value
    return row


def funnel_of(data) -> dict:
    """Воронка общего обзора в виде «стадия → количество дел»."""
    return {stage["stage"]: stage["count"] for stage in data["cases"]["overall"]["funnel"]}


class YearSeparatorTests(unittest.TestCase):
    """Строки-разделители «2026 год» в колонке «Истец» задают год делам под собой."""

    def test_separator_row_is_not_counted_as_case(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(section="2026 год"),
            case_row(debtor="ООО Ромашка", total=1000),
        ], [])
        self.assertEqual(data["cases"]["overall"]["kpi"]["cases_count"], 1)

    def test_case_takes_year_of_separator_above_it(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(section="2025 год"),
            case_row(debtor="ООО Ромашка", total=1000),
            case_row(section="2026 год"),
            case_row(debtor="ООО Василёк", total=2000),
            case_row(debtor="ООО Пион", total=3000),
        ], [])
        self.assertEqual(data["cases"]["years"], ["2026", "2025"])
        self.assertEqual(data["cases"]["by_year"]["2026"]["kpi"]["cases_count"], 2)
        self.assertEqual(data["cases"]["by_year"]["2025"]["kpi"]["claimed_total"], 1000.0)

    def test_ordinary_row_with_plaintiff_name_is_not_a_separator(self):
        # В колонке-разделителе у обычных строк стоит истец — «АО "Тривио"».
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(section='АО "Тривио"', debtor="ООО Ромашка", total=1000),
        ], [])
        self.assertEqual(data["cases"]["overall"]["kpi"]["cases_count"], 1)

    def test_case_above_first_separator_keeps_its_place_in_statistics(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="ООО Без года", total=500),
            case_row(section="2026 год"),
            case_row(debtor="ООО Ромашка", total=1000),
        ], [])
        self.assertEqual(data["cases"]["overall"]["kpi"]["cases_count"], 2)
        self.assertEqual(data["cases"]["years"], ["2026", "Без года"])


class AmountParsingTests(unittest.TestCase):
    """Суммы в реестре пишут по-разному — разбор должен быть терпимым."""

    def test_amount_formats_are_normalized(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", total="1 234 567,89"),
            case_row(debtor="Б", total="1234.11"),
            case_row(debtor="В", total="1 000 руб."),
        ], [])
        self.assertEqual(data["cases"]["overall"]["kpi"]["claimed_total"], 1_236_802.0)

    def test_total_is_summed_from_parts_when_empty(self):
        # Частый случай в реестре: заполнен только ПДЗ, итоговая «Сумма» пуста.
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", principal=1000, penalty=200, court_costs=50),
        ], [])
        self.assertEqual(data["cases"]["overall"]["kpi"]["claimed_total"], 1250.0)

    def test_row_without_any_amounts_counts_as_zero(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А"),
        ], [])
        kpi = data["cases"]["overall"]["kpi"]
        self.assertEqual(kpi["cases_count"], 1)
        self.assertEqual(kpi["claimed_total"], 0.0)

    def test_unrecognized_amount_counts_as_zero_and_warns(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", total="н/д"),
        ], [])
        self.assertEqual(data["cases"]["overall"]["kpi"]["claimed_total"], 0.0)
        warnings = data["warnings"]
        self.assertEqual(warnings["unparsed_amounts_count"], 1)
        self.assertEqual(warnings["unparsed_amounts"][0]["value"], "н/д")
        self.assertEqual(warnings["unparsed_amounts"][0]["row"], 2)

    def test_enforcement_number_is_not_mistaken_for_money(self):
        # «Взыскание» — это номер исполнительного производства, а не сумма:
        # в суммы он попасть не должен и предупреждением тоже не считается.
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", principal=1000, enforcement="344136/24/77006-ИП от 31.10.2024"),
        ], [])
        self.assertEqual(data["cases"]["overall"]["kpi"]["claimed_total"], 1000.0)
        self.assertEqual(data["warnings"]["unparsed_amounts_count"], 0)


class StatusTests(unittest.TestCase):
    """Стадия берётся из колонки «Статус», а при пропуске выводится из данных."""

    def test_statuses_are_recognized_by_keyword(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", status="Подготовка иска", total=100),
            case_row(debtor="Б", status="Процесс", total=100),
            case_row(debtor="В", status="Исполнительное пр-во", total=100),
            case_row(debtor="Г", status="Банкротство", total=100),
            case_row(debtor="Д", status="Долг погашен / по ИЛ", total=100, recovered=100),
        ], [])
        funnel = funnel_of(data)
        self.assertEqual(funnel["подготовка иска"], 1)
        self.assertEqual(funnel["процесс"], 1)
        self.assertEqual(funnel["исполнительное пр-во"], 1)
        self.assertEqual(funnel["банкротство"], 1)
        self.assertEqual(funnel["долг погашен"], 1)
        self.assertEqual(data["warnings"]["unknown_statuses_count"], 0)

    def test_both_repayment_kinds_share_one_stage_but_keep_breakdown(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", status="Долг погашен /Досудебное урег-е", total=100),
            case_row(debtor="Б", status="Долг погашен / по ИЛ", total=100),
            case_row(debtor="В", status="Долг погашен / по ИЛ", total=100),
        ], [])
        repaid = next(
            stage for stage in data["cases"]["overall"]["funnel"]
            if stage["stage"] == "долг погашен"
        )
        self.assertEqual(repaid["count"], 3)
        self.assertEqual(repaid["breakdown"], [
            {"name": "по ИЛ", "count": 2},
            {"name": "досудебно", "count": 1},
        ])

    def test_empty_status_without_court_date_means_claim_preparation(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", total=100),
        ], [])
        self.assertEqual(funnel_of(data)["подготовка иска"], 1)
        self.assertEqual(data["warnings"]["cases_without_status"], 1)

    def test_empty_status_with_enforcement_number_means_enforcement(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", court_date="01.02.2026", total=100,
                     enforcement="344136/24/77006-ИП"),
        ], [])
        self.assertEqual(funnel_of(data)["исполнительное пр-во"], 1)

    def test_empty_status_with_recovered_amount_means_debt_repaid(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", court_date="01.02.2026", total=100, recovered=100),
        ], [])
        self.assertEqual(funnel_of(data)["долг погашен"], 1)

    def test_row_without_status_and_without_clues_goes_to_separate_category(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", court_date="01.02.2026", total=100),
        ], [])
        self.assertEqual(funnel_of(data)["Статус не указан"], 1)

    def test_typo_in_status_goes_to_unrecognized_and_warns(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", status="прцесс", total=100),
        ], [])
        self.assertEqual(funnel_of(data)["Статус не распознан"], 1)
        self.assertEqual(data["warnings"]["unknown_statuses"][0]["value"], "прцесс")

    def test_funnel_keeps_process_order(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", status="Долг погашен / по ИЛ", total=100),
            case_row(debtor="Б", status="Подготовка иска", total=100),
        ], [])
        stages = [stage["stage"] for stage in data["cases"]["overall"]["funnel"]]
        self.assertEqual(stages[0], "подготовка иска")
        self.assertEqual(stages[-1], "долг погашен")


class MetricsTests(unittest.TestCase):
    """Показатели: процент взыскания, структура требований, топ, суды."""

    def test_recovery_percent(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", total=1000, recovered=250),
        ], [])
        self.assertEqual(data["cases"]["overall"]["kpi"]["recovery_percent"], 25.0)

    def test_recovery_percent_is_none_when_no_claims(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А"),
        ], [])
        self.assertIsNone(data["cases"]["overall"]["kpi"]["recovery_percent"])

    def test_top_debtors_sorted_by_claimed_amount(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="Мелкий", total=100),
            case_row(debtor="Крупный", total=900),
        ], [])
        self.assertEqual(data["cases"]["overall"]["top_debtors"][0]["debtor"], "Крупный")

    def test_missing_debtor_and_court_show_placeholder(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(total=100),
        ], [])
        section = data["cases"]["overall"]
        self.assertEqual(section["top_debtors"][0]["debtor"], "Не указан")
        self.assertEqual(section["courts"][0]["name"], "Не указан")
        self.assertEqual(data["warnings"]["cases_without_debtor"], 1)

    def test_overall_equals_sum_of_years(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(section="2025 год"),
            case_row(debtor="А", total=1000, recovered=100),
            case_row(section="2026 год"),
            case_row(debtor="Б", total=2000, recovered=500),
        ], [])
        overall = data["cases"]["overall"]["kpi"]
        by_year = data["cases"]["by_year"]
        self.assertEqual(
            overall["claimed_total"],
            by_year["2025"]["kpi"]["claimed_total"] + by_year["2026"]["kpi"]["claimed_total"],
        )
        self.assertEqual(
            overall["cases_count"],
            by_year["2025"]["kpi"]["cases_count"] + by_year["2026"]["kpi"]["cases_count"],
        )
        self.assertEqual(
            overall["recovered_total"],
            sum(year["recovered"] for year in data["cases"]["dynamics"]),
        )


class RobustnessTests(unittest.TestCase):
    """Сводная проверка: в каждой строке чего-то не хватает — дашборд считается."""

    def test_dashboard_survives_rows_with_gaps_everywhere(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(section="2026 год"),
            case_row(debtor="Только должник"),
            case_row(total=500),
            case_row(debtor="Без ИНН", inn="", status="Процесс", total="—"),
            case_row(debtor="Только сумма и статус", status="Долг погашен / по ИЛ", recovered=300),
            [],
            case_row(),
        ], [])
        kpi = data["cases"]["overall"]["kpi"]
        self.assertEqual(kpi["cases_count"], 4)
        self.assertEqual(kpi["recovered_total"], 300.0)

    def test_empty_sheets_produce_empty_dashboard(self):
        data = build_dashboard_data([], [])
        self.assertEqual(data["cases"]["years"], [])
        self.assertEqual(data["cases"]["overall"]["kpi"]["cases_count"], 0)
        self.assertIsNone(data["cases"]["overall"]["kpi"]["recovery_percent"])
        self.assertEqual(data["bankruptcy"]["kpi"]["cases_count"], 0)

    def test_short_rows_without_trailing_cells_are_handled(self):
        # Sheets API обрезает хвостовые пустые ячейки — строка приходит короче заголовка.
        data = build_dashboard_data([
            CASE_HEADER,
            ['АО "Тривио"', "ООО Ромашка", "7700000000"],
        ], [])
        self.assertEqual(data["cases"]["overall"]["kpi"]["cases_count"], 1)
        self.assertEqual(data["cases"]["overall"]["kpi"]["claimed_total"], 0.0)


class BankruptcyTests(unittest.TestCase):
    """Секция «Банкротство»: показатели, свёртка стадий и топ должников."""

    def test_bankruptcy_metrics(self):
        data = build_dashboard_data([], [
            BANKRUPTCY_HEADER,
            ["АО Тривио", "ЛАДЕСОЛ", "А64-8362/2021", "АС Тамбовской области",
             "Конкурсное производство до 25.05.2026", 1000, ""],
            ["АО Тривио", "ГЕМОНТ", "А65-19059/2022", "АС Республики Татарстан",
             "Наблюдение до 08.05.2026", "2 000,50", ""],
        ])
        section = data["bankruptcy"]
        self.assertEqual(section["kpi"]["cases_count"], 2)
        self.assertEqual(section["kpi"]["claimed_total"], 3000.5)
        self.assertEqual(section["top_debtors"][0]["debtor"], "ГЕМОНТ")
        # В таблице стадия показывается как записана — вместе с датой.
        self.assertEqual(section["top_debtors"][0]["stage"], "Наблюдение до 08.05.2026")

    def test_free_text_stages_are_grouped_by_procedure(self):
        data = build_dashboard_data([], [
            BANKRUPTCY_HEADER,
            ["", "А", "", "", "Конкурсное производство до 25.05.2026", 10, ""],
            ["", "Б", "", "", "09.02.2026 - конкурсное производство до 09.08.2026", 10, ""],
            ["", "В", "", "", "Наблюдение до 18.03.2026 (СЗ отложено до 10.06.2026)", 10, ""],
            ["", "Г", "", "", "Реализация имущества до 21.07.2026", 10, ""],
            ["", "Д", "", "", "СЗ 23.07.2026", 10, ""],
        ])
        stages = {stage["name"]: stage["count"] for stage in data["bankruptcy"]["stages"]}
        self.assertEqual(stages["Конкурсное производство"], 2)
        self.assertEqual(stages["Наблюдение"], 1)
        self.assertEqual(stages["Реализация имущества"], 1)
        self.assertEqual(stages["Иное"], 1)

    def test_bankruptcy_row_without_stage_gets_placeholder(self):
        data = build_dashboard_data([], [
            BANKRUPTCY_HEADER,
            ["", "ООО Должник", "", "", "", "", ""],
        ])
        self.assertEqual(data["bankruptcy"]["stages"][0]["name"], "Не указан")


if __name__ == "__main__":
    unittest.main()
