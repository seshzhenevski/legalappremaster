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


def stage_of(data, stage_name: str) -> dict:
    """Одна стадия воронки общего обзора целиком — с суммами и разбивкой."""
    return next(
        stage for stage in data["cases"]["overall"]["funnel"]
        if stage["stage"] == stage_name
    )


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
            case_row(debtor="Е", status="Невозвратная задолженность", total=100),
        ], [])
        funnel = funnel_of(data)
        self.assertEqual(funnel["подготовка иска"], 1)
        self.assertEqual(funnel["процесс"], 1)
        self.assertEqual(funnel["исполнительное пр-во"], 1)
        self.assertEqual(funnel["банкротство"], 1)
        self.assertEqual(funnel["долг погашен"], 1)
        self.assertEqual(funnel["невозвратная задолженность"], 1)
        self.assertEqual(data["warnings"]["unknown_statuses_count"], 0)

    def test_uncollectible_debt_closes_the_funnel(self):
        # Списанный долг — исход, а не этап: стадия замыкает воронку.
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", status="Невозвратная задолженность", total=100),
            case_row(debtor="Б", status="Подготовка иска", total=100),
        ], [])
        stages = [stage["stage"] for stage in data["cases"]["overall"]["funnel"]]
        self.assertEqual(stages[-1], "невозвратная задолженность")

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
        self.assertEqual(stages, [
            "подготовка иска",
            "процесс",
            "исполнительное пр-во",
            "банкротство",
            "долг погашен",
            "невозвратная задолженность",
        ])


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

    def test_recovery_percent_to_principal(self):
        # Требования 1000 (ПДЗ 800 + неустойка 200), взыскано 400: 40% к
        # требованиям, 50% к основному долгу — второй знаменатель уже.
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", principal=800, penalty=200, total=1000, recovered=400),
        ], [])
        kpi = data["cases"]["overall"]["kpi"]
        self.assertEqual(kpi["recovery_percent"], 40.0)
        self.assertEqual(kpi["recovery_percent_principal"], 50.0)

    def test_recovery_percent_to_principal_is_none_without_principal(self):
        # Основного долга нет (только неустойка) — процент к нему не существует.
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", penalty=500, total=500, recovered=100),
        ], [])
        self.assertIsNone(data["cases"]["overall"]["kpi"]["recovery_percent_principal"])

    def test_top_debtors_sorted_by_claimed_amount(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="Мелкий", total=100),
            case_row(debtor="Крупный", total=900),
        ], [])
        self.assertEqual(data["cases"]["overall"]["top_debtors"][0]["debtor"], "Крупный")

    def test_missing_debtor_shows_placeholder(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(total=100),
        ], [])
        section = data["cases"]["overall"]
        self.assertEqual(section["top_debtors"][0]["debtor"], "Не указан")
        self.assertEqual(data["warnings"]["cases_without_debtor"], 1)

    def test_cases_without_court_are_absent_from_court_distribution(self):
        # Пустой суд означает, что дело в суд не передавалось: отдельной
        # категории «Не указан» в распределении по судам быть не должно.
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", court="АСГМ", total=100),
            case_row(debtor="Б", total=100),
        ], [])
        courts = data["cases"]["overall"]["courts"]
        self.assertEqual(courts, [{"name": "АСГМ", "count": 1}])

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


class FunnelAmountsTests(unittest.TestCase):
    """Требования и взысканное по стадиям — из них собран составной столбец."""

    def test_stage_keeps_claimed_and_recovered_apart(self):
        # Погашенное дело: требовали 1000, вернулось 700. В столбце стадии обе
        # величины живут отдельно — заявленное не подменяется взысканным.
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", status="Долг погашен / по ИЛ", total=1000, recovered=700),
        ], [])
        repaid = stage_of(data, "долг погашен")
        self.assertEqual(repaid["claimed"], 1000)
        self.assertEqual(repaid["recovered"], 700)

    def test_recovered_is_counted_on_every_stage(self):
        # Деньги приходят не только по погашенным делам: у приставов и в
        # банкротстве тоже. Стадия показывает своё взысканное.
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", status="Исполнительное пр-во", total=1000, recovered=300),
            case_row(debtor="Б", status="Банкротство", total=1000, recovered=100),
        ], [])
        self.assertEqual(stage_of(data, "исполнительное пр-во")["recovered"], 300)
        self.assertEqual(stage_of(data, "банкротство")["recovered"], 100)

    def test_recovered_over_stages_matches_recovered_total(self):
        # Ради этого взысканное и считается по всем стадиям: сумма зелёных
        # частей графика обязана сходиться с показателем «фактически взыскано».
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", status="Долг погашен / по ИЛ", total=1000, recovered=700),
            case_row(debtor="Б", status="Исполнительное пр-во", total=1000, recovered=300),
            case_row(debtor="В", status="Процесс", total=1000),
        ], [])
        section = data["cases"]["overall"]
        by_stage = sum(stage["recovered"] for stage in section["funnel"])
        self.assertEqual(by_stage, section["kpi"]["recovered_total"])

    def test_stage_without_recovery_reports_zero(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", status="Процесс", total=1000),
        ], [])
        self.assertEqual(stage_of(data, "процесс")["recovered"], 0)

    def test_recovered_may_exceed_claimed_when_amount_is_missing(self):
        # Реестр ведут руками: «Взыскано» заполнено, «Сумма» пуста. Величины
        # отдаются как есть — интерфейс покажет аномалию, а не спрячет её.
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", status="Долг погашен / по ИЛ", recovered=500),
        ], [])
        repaid = stage_of(data, "долг погашен")
        self.assertEqual(repaid["claimed"], 0)
        self.assertEqual(repaid["recovered"], 500)


class ReviewTermTests(unittest.TestCase):
    """Средний срок рассмотрения: от «В работе» до даты решения."""

    def test_average_is_counted_only_over_cases_with_both_dates(self):
        data = build_dashboard_data([
            CASE_HEADER,
            # 10 и 20 дней — идут в среднее.
            case_row(debtor="А", in_work="01.02.2026", decision="11.02.2026 - удовлетворен"),
            case_row(debtor="Б", in_work="01.02.2026", decision="21.02.2026 - удовлетворен частично"),
            # Нет даты начала работы — в среднее не идёт.
            case_row(debtor="В", decision="21.02.2026 - удовлетворен"),
            # Нет решения — тоже не идёт.
            case_row(debtor="Г", in_work="01.02.2026"),
            # В решении нет даты — считать не от чего.
            case_row(debtor="Д", in_work="01.02.2026", decision="иск оставлен без движения"),
        ], [])
        kpi = data["cases"]["overall"]["kpi"]
        self.assertEqual(kpi["average_review_days"], 15)
        self.assertEqual(kpi["review_cases_count"], 2)

    def test_no_average_without_suitable_cases(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", total=100),
        ], [])
        kpi = data["cases"]["overall"]["kpi"]
        self.assertIsNone(kpi["average_review_days"])
        self.assertEqual(kpi["review_cases_count"], 0)

    def test_decision_before_start_of_work_is_ignored(self):
        # Опечатка в реестре (решение раньше начала работы) не должна утягивать
        # среднее в минус.
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", in_work="01.03.2026", decision="11.02.2026 - удовлетворен"),
        ], [])
        self.assertIsNone(data["cases"]["overall"]["kpi"]["average_review_days"])


class PrepTermTests(unittest.TestCase):
    """Срок подготовки иска: от «В работе» (D) до «Передано в суд» (E)."""

    def test_average_counts_only_cases_with_both_dates(self):
        data = build_dashboard_data([
            CASE_HEADER,
            # 10 и 30 дней — идут в среднее (итого 20).
            case_row(debtor="А", in_work="01.02.2026", court_date="11.02.2026"),
            case_row(debtor="Б", in_work="01.02.2026", court_date="03.03.2026"),
            # Нет даты передачи в суд — дело в среднее не входит.
            case_row(debtor="В", in_work="01.02.2026"),
            # Нет даты начала работы — тоже не входит.
            case_row(debtor="Г", court_date="03.03.2026"),
        ], [])
        kpi = data["cases"]["overall"]["kpi"]
        self.assertEqual(kpi["average_prep_days"], 20)
        self.assertEqual(kpi["prep_cases_count"], 2)

    def test_no_average_without_suitable_cases(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", total=100),
        ], [])
        kpi = data["cases"]["overall"]["kpi"]
        self.assertIsNone(kpi["average_prep_days"])
        self.assertEqual(kpi["prep_cases_count"], 0)

    def test_court_date_before_start_of_work_is_ignored(self):
        # Передача в суд раньше начала работы — опечатка, в среднее не идёт.
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", in_work="01.03.2026", court_date="11.02.2026"),
        ], [])
        self.assertIsNone(data["cases"]["overall"]["kpi"]["average_prep_days"])

    def test_prep_term_reacts_to_year_filter(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(section="2025 год"),
            case_row(debtor="А", in_work="01.02.2025", court_date="11.02.2025"),  # 10 дней
            case_row(section="2024 год"),
            case_row(debtor="Б", in_work="01.02.2024", court_date="02.03.2024"),  # 30 дней (2024 — високосный)
        ], [])
        self.assertEqual(data["cases"]["by_year"]["2025"]["kpi"]["average_prep_days"], 10)
        self.assertEqual(data["cases"]["by_year"]["2024"]["kpi"]["average_prep_days"], 30)


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
        self.assertEqual(data["bankruptcy"]["overall"]["kpi"]["cases_count"], 0)

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
        section = data["bankruptcy"]["overall"]
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
            ["", "Д", "", "", "что-то неведомое", 10, ""],
        ])
        stages = {stage["name"]: stage["count"] for stage in data["bankruptcy"]["overall"]["stages"]}
        self.assertEqual(stages["Конкурсное производство"], 2)
        self.assertEqual(stages["Наблюдение"], 1)
        self.assertEqual(stages["Реализация имущества"], 1)
        self.assertEqual(stages["Иное"], 1)

    def test_scheduled_hearing_stage_is_litigation(self):
        # «СЗ 23.07.2026» — назначено судебное заседание, процедура ещё не
        # введена: это «Процесс», а не «Иное».
        data = build_dashboard_data([], [
            BANKRUPTCY_HEADER,
            ["", "А", "", "", "СЗ 23.07.2026", 10, ""],
            ["", "Б", "", "", "СЗ", 10, ""],
        ])
        stages = {stage["name"]: stage["count"] for stage in data["bankruptcy"]["overall"]["stages"]}
        self.assertEqual(stages["Процесс"], 2)
        self.assertNotIn("Иное", stages)

    def test_hearing_marker_does_not_match_inside_words(self):
        # «сз» ловится как отдельный токен, а не подстрокой: «Возврат СЗ-заявления»
        # не должен ошибочно стать «Процессом» из-за keyword-провала — здесь
        # проверяем, что случайное слово с «сз» внутри уходит в «Иное».
        data = build_dashboard_data([], [
            BANKRUPTCY_HEADER,
            ["", "А", "", "", "рассзюжет", 10, ""],
        ])
        stages = {stage["name"]: stage["count"] for stage in data["bankruptcy"]["overall"]["stages"]}
        self.assertEqual(stages.get("Иное"), 1)
        self.assertNotIn("Процесс", stages)

    def test_bankruptcy_row_without_stage_gets_placeholder(self):
        data = build_dashboard_data([], [
            BANKRUPTCY_HEADER,
            ["", "ООО Должник", "", "", "", "", ""],
        ])
        self.assertEqual(data["bankruptcy"]["overall"]["stages"][0]["name"], "Не указан")

    def test_bankruptcy_dynamics_takes_year_from_case_number(self):
        data = build_dashboard_data([], [
            BANKRUPTCY_HEADER,
            ["", "А", "А60-67691/2024", "", "Наблюдение", 1000, ""],
            ["", "Б", "А40-9014/2022", "", "Наблюдение", 2000, ""],
            ["", "В", "А40-1/2024", "", "Наблюдение", 500, ""],
        ])
        dynamics = {row["year"]: row for row in data["bankruptcy"]["dynamics"]}
        self.assertEqual([row["year"] for row in data["bankruptcy"]["dynamics"]], ["2024", "2022"])
        self.assertEqual(dynamics["2024"]["cases_count"], 2)
        self.assertEqual(dynamics["2024"]["claimed"], 1500.0)
        self.assertEqual(dynamics["2022"]["cases_count"], 1)

    def test_case_with_two_numbers_counts_in_both_years(self):
        # У РИНС в реестре два номера дела с разными годами — дело идёт в оба.
        data = build_dashboard_data([], [
            BANKRUPTCY_HEADER,
            ["", "РИНС", "А40-147731/2025 А75-5252/2026", "", "СЗ", 3000, ""],
        ])
        dynamics = {row["year"]: row for row in data["bankruptcy"]["dynamics"]}
        self.assertEqual(dynamics["2025"]["cases_count"], 1)
        self.assertEqual(dynamics["2025"]["claimed"], 3000.0)
        self.assertEqual(dynamics["2026"]["cases_count"], 1)
        self.assertEqual(dynamics["2026"]["claimed"], 3000.0)

    def test_bankruptcy_case_without_year_in_number_goes_to_unknown(self):
        data = build_dashboard_data([], [
            BANKRUPTCY_HEADER,
            ["", "Без номера", "нет данных", "", "Наблюдение", 100, ""],
        ])
        self.assertEqual(data["bankruptcy"]["dynamics"][0]["year"], "Без года")

    def test_bankruptcy_court_distribution(self):
        data = build_dashboard_data([], [
            BANKRUPTCY_HEADER,
            ["", "А", "А40-1/2025", "АС города Москвы", "Наблюдение", 100, ""],
            ["", "Б", "А40-2/2025", "АС города Москвы", "Наблюдение", 100, ""],
            ["", "В", "А07-3/2025", "АС Республики Башкортостан", "Наблюдение", 100, ""],
            ["", "Г", "А07-4/2025", "", "Наблюдение", 100, ""],
        ])
        courts = data["bankruptcy"]["overall"]["courts"]
        self.assertEqual(courts[0], {"name": "АС города Москвы", "count": 2})
        # Дело без суда в распределение не попадает.
        self.assertNotIn("", [c["name"] for c in courts])

    def test_multiline_court_split_in_distribution_but_joined_in_top(self):
        data = build_dashboard_data([], [
            BANKRUPTCY_HEADER,
            ["", "РИНС", "А40-1/2025", "АС города Москвы\nАС Ханты-Мансийского АО",
             "Наблюдение", 1000, ""],
            ["", "Прочий", "А40-2/2025", "АС города Москвы", "Наблюдение", 500, ""],
        ])
        courts = {c["name"]: c["count"] for c in data["bankruptcy"]["overall"]["courts"]}
        # Составной суд разложен: Москва учтена дважды, Ханты — один раз.
        self.assertEqual(courts["АС города Москвы"], 2)
        self.assertEqual(courts["АС Ханты-Мансийского АО"], 1)
        # В таблице топа тот же должник показан со складкой через « / ».
        self.assertEqual(
            data["bankruptcy"]["overall"]["top_debtors"][0]["court"],
            "АС города Москвы / АС Ханты-Мансийского АО",
        )

    def test_long_court_name_shortened_in_distribution(self):
        data = build_dashboard_data([], [
            BANKRUPTCY_HEADER,
            ["", "А", "А56-1/2025", "АС города Санкт-Петербурга и Ленинградской области",
             "Наблюдение", 100, ""],
        ])
        self.assertEqual(data["bankruptcy"]["overall"]["courts"][0]["name"], "АС города Санкт-Петербурга")


class ConversionTests(unittest.TestCase):
    """Конверсия судебных дел в банкротство: плитка «% от судебных дел»."""

    def test_conversion_percentages_over_court_cases(self):
        # 4 судебных дела на 1000 ₽ каждое (сумма 4000). Из них двое дошли до
        # банкротства с долгом 1000 + 500 = 1500. В должниках 2/4 = 50 %, в сумме
        # 1500/4000 = 37,5 %. Знаменатель — судебные дела, не банкротные.
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", total=1000),
            case_row(debtor="Б", total=1000),
            case_row(debtor="В", total=1000),
            case_row(debtor="Г", total=1000),
        ], [
            BANKRUPTCY_HEADER,
            ["", "А", "А40-1/2025", "", "Наблюдение", 1000, ""],
            ["", "Б", "А40-2/2025", "", "Конкурсное производство", 500, ""],
        ])
        conversion = data["bankruptcy"]["overall"]["conversion"]
        self.assertEqual(conversion["debtors_percent"], 50.0)
        self.assertEqual(conversion["amount_percent"], 37.5)

    def test_process_stage_excluded_from_conversion(self):
        # «СЗ …» — банкротство ещё не введено: такой должник и его сумма в
        # числитель не входят. Из двух банкротных дел засчитывается одно.
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="А", total=1000),
            case_row(debtor="Б", total=1000),
        ], [
            BANKRUPTCY_HEADER,
            ["", "А", "А40-1/2025", "", "Наблюдение", 1000, ""],
            ["", "Б", "А40-2/2025", "", "СЗ 23.07.2026", 1000, ""],
        ])
        conversion = data["bankruptcy"]["overall"]["conversion"]
        self.assertEqual(conversion["debtors_percent"], 50.0)
        self.assertEqual(conversion["amount_percent"], 50.0)
        self.assertEqual(conversion["bankrupt_count"], 1)

    def test_conversion_is_none_without_court_cases(self):
        # Судебных дел нет — конверсии не существует, а не ноль или деление на ноль.
        data = build_dashboard_data([], [
            BANKRUPTCY_HEADER,
            ["", "А", "А40-1/2025", "", "Наблюдение", 1000, ""],
        ])
        conversion = data["bankruptcy"]["overall"]["conversion"]
        self.assertIsNone(conversion["debtors_percent"])
        self.assertIsNone(conversion["amount_percent"])

    def test_conversion_reacts_to_year_filter(self):
        # Судебный год — из разделителя, банкротный — из номера дела. За 2025:
        # одно судебное дело и один банкрот того же года → 100 %.
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(section="2025 год"),
            case_row(debtor="А", total=1000),
            case_row(section="2024 год"),
            case_row(debtor="Б", total=1000),
            case_row(debtor="В", total=1000),
        ], [
            BANKRUPTCY_HEADER,
            ["", "А", "А40-1/2025", "", "Наблюдение", 1000, ""],
        ])
        by_year = data["bankruptcy"]["by_year"]
        self.assertEqual(by_year["2025"]["conversion"]["debtors_percent"], 100.0)
        self.assertEqual(by_year["2024"]["conversion"]["debtors_percent"], 0.0)

    def test_bankruptcy_section_filters_by_year(self):
        # Весь блок банкротства реагирует на год: показатели, стадии и суммы
        # берутся по банкротным делам этого года (год — из номера дела).
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(section="2025 год"),
            case_row(debtor="Судебный", total=1000),
        ], [
            BANKRUPTCY_HEADER,
            ["", "А", "А40-1/2025", "", "Наблюдение", 1000, ""],
            ["", "Б", "А40-2/2025", "", "Конкурсное производство", 500, ""],
            ["", "В", "А40-3/2024", "", "Наблюдение", 700, ""],
        ])
        section_2025 = data["bankruptcy"]["by_year"]["2025"]
        self.assertEqual(section_2025["kpi"]["cases_count"], 2)
        self.assertEqual(section_2025["kpi"]["claimed_total"], 1500.0)
        stages_2025 = {stage["name"] for stage in section_2025["stages"]}
        self.assertEqual(stages_2025, {"Наблюдение", "Конкурсное производство"})
        # Общий обзор по-прежнему видит все дела всех лет.
        self.assertEqual(data["bankruptcy"]["overall"]["kpi"]["cases_count"], 3)


CLAIM_HEADER = [
    "КОНТРАГЕНТ", "ИНН", "№претензии", "Дата претензии", "Сумма долга",
    "Идентификатор почтового отправления",
]


def claim_row(debtor="", inn="", number="", date="", amount="", ident=""):
    """Строка реестра претензий в порядке колонок файла."""
    return [debtor, inn, number, date, amount, ident]


class ClaimsParsingTests(unittest.TestCase):
    """Разбор реестра претензий: суммы, даты, пустые строки."""

    def test_claims_unavailable_without_registry(self):
        data = build_dashboard_data([CASE_HEADER], [])
        self.assertFalse(data["claims"]["available"])

    def test_claims_error_is_passed_through(self):
        data = build_dashboard_data([CASE_HEADER], [], claim_rows=None,
                                    claim_error="Диск Z: недоступен")
        self.assertFalse(data["claims"]["available"])
        self.assertEqual(data["claims"]["error"], "Диск Z: недоступен")

    def test_basic_claim_metrics(self):
        data = build_dashboard_data([CASE_HEADER], [], claim_rows=[
            CLAIM_HEADER,
            claim_row(debtor="ООО Ромашка", number="60", date="01.11.2025", amount="1 000,50"),
            claim_row(debtor="ООО Василёк", number="61", date="02.11.2025", amount="2000"),
        ])
        kpi = data["claims"]["overall"]["kpi"]
        self.assertEqual(kpi["claims_count"], 2)
        self.assertEqual(kpi["claimed_total"], 3000.5)

    def test_empty_rows_skipped_and_missing_amount_is_zero(self):
        data = build_dashboard_data([CASE_HEADER], [], claim_rows=[
            CLAIM_HEADER,
            claim_row(debtor="ООО Ромашка", number="60"),
            claim_row(),
            [None, None, None, None, None, None],
        ])
        kpi = data["claims"]["overall"]["kpi"]
        self.assertEqual(kpi["claims_count"], 1)
        self.assertEqual(kpi["claimed_total"], 0.0)

    def test_date_taken_from_number_when_column_empty(self):
        data = build_dashboard_data([CASE_HEADER], [], claim_rows=[
            CLAIM_HEADER,
            claim_row(debtor="ООО Ромашка", number="65 (от 01.11.2024)", amount="100"),
        ])
        self.assertEqual(data["claims"]["years"], ["2024"])

    def test_claims_split_by_year(self):
        data = build_dashboard_data([CASE_HEADER], [], claim_rows=[
            CLAIM_HEADER,
            claim_row(debtor="А", number="1", date="01.03.2025", amount="100"),
            claim_row(debtor="Б", number="2", date="01.03.2026", amount="200"),
            claim_row(debtor="В", number="3", date="02.03.2026", amount="300"),
        ])
        self.assertEqual(data["claims"]["years"], ["2026", "2025"])
        self.assertEqual(data["claims"]["by_year"]["2026"]["kpi"]["claims_count"], 2)
        self.assertEqual(data["claims"]["by_year"]["2025"]["kpi"]["claimed_total"], 100.0)


class ClaimsMatchingTests(unittest.TestCase):
    """Сопоставление претензий с судебными делами: ИНН, наименование, срок."""

    def test_match_by_inn(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="ООО «Ромашка-Торг»", inn="7700000001", total=5000),
        ], [], claim_rows=[
            CLAIM_HEADER,
            claim_row(debtor="Ромашка", inn="7700000001", number="1", date="01.01.2025", amount="1000"),
        ])
        kpi = data["claims"]["overall"]["kpi"]
        self.assertEqual(kpi["transferred_count"], 1)
        self.assertEqual(kpi["transferred_total"], 1000.0)

    def test_match_by_name_ignoring_legal_form(self):
        # ИНН в претензии нет — матч по наименованию без ОПФ и кавычек.
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor='ООО "ГИТИ"', total=5000),
        ], [], claim_rows=[
            CLAIM_HEADER,
            claim_row(debtor="ГИТИ ООО", number="1", date="01.01.2025", amount="1000"),
        ])
        self.assertEqual(data["claims"]["overall"]["kpi"]["transferred_count"], 1)

    def test_unmatched_claim_not_transferred(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="ООО Другой", total=5000),
        ], [], claim_rows=[
            CLAIM_HEADER,
            claim_row(debtor="ООО Ромашка", number="1", date="01.01.2025", amount="1000"),
        ])
        self.assertEqual(data["claims"]["overall"]["kpi"]["transferred_count"], 0)

    def test_average_days_to_transfer(self):
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="ГИТИ", in_work="20.01.2025", total=5000),
        ], [], claim_rows=[
            CLAIM_HEADER,
            claim_row(debtor="ГИТИ", number="1", date="01.01.2025", amount="1000"),
        ])
        kpi = data["claims"]["overall"]["kpi"]
        self.assertEqual(kpi["average_days_to_transfer"], 19)
        self.assertEqual(kpi["transfer_term_count"], 1)

    def test_transfer_percent_counts_unique_debtors(self):
        # Два должника: у одного (с двумя претензиями) есть суд.дело, у второго нет.
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="ГИТИ", total=5000),
        ], [], claim_rows=[
            CLAIM_HEADER,
            claim_row(debtor="ГИТИ", number="1", date="01.01.2025", amount="1000"),
            claim_row(debtor="ООО ГИТИ", number="2", date="02.01.2025", amount="500"),
            claim_row(debtor="ООО Прочий", number="3", date="03.01.2025", amount="700"),
        ], )
        kpi = data["claims"]["overall"]["kpi"]
        # Уникальных должников 2 (ГИТИ и Прочий), передан 1 → 50 %.
        self.assertEqual(kpi["transfer_percent"], 50.0)
        # Претензий передано 2 (обе по ГИТИ).
        self.assertEqual(kpi["transferred_count"], 2)

    def test_negative_transfer_term_ignored(self):
        # Дело в работе раньше претензии — аномалия, в средний срок не идёт.
        data = build_dashboard_data([
            CASE_HEADER,
            case_row(debtor="ГИТИ", in_work="01.01.2025", total=5000),
        ], [], claim_rows=[
            CLAIM_HEADER,
            claim_row(debtor="ГИТИ", number="1", date="01.03.2025", amount="1000"),
        ])
        kpi = data["claims"]["overall"]["kpi"]
        self.assertEqual(kpi["transferred_count"], 1)
        self.assertIsNone(kpi["average_days_to_transfer"])


if __name__ == "__main__":
    unittest.main()
