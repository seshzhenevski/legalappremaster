// kb-search.js
// Поиск по статьям базы знаний.
//
// Работает по уже загруженной в память базе, без обращения к бэкенду и без
// поискового индекса: обращение к бэкенду стоит около трёх секунд, а обойти
// несколько сотен статей в памяти — доли миллисекунды. Поэтому результаты
// меняются прямо по мере набора.
//
// Здесь только вычисления над текстом — ни одна функция не трогает разметку.
// Благодаря этому поиск покрыт тестами, а вкладка занимается лишь показом.

// Сколько знаков текста показывать вокруг найденного слова.
const SNIPPET_RADIUS = 45;

// Сколько фрагментов показывать у одной статьи: список должен оставаться
// обозримым, даже если слово встречается в статье три десятка раз.
const MAX_SNIPPETS_PER_ARTICLE = 3;

/**
 * Приводит текст к виду, пригодному для сравнения.
 *
 * Принимает произвольный текст. Приводит к нижнему регистру и заменяет «ё»
 * на «е»: в документах её пишут то так, то этак, и поиск не должен от этого
 * зависеть.
 */
export function normalizeForSearch(text) {
  return String(text ?? "").toLowerCase().replace(/ё/g, "е");
}

/**
 * Отбрасывает окончание слова, оставляя основу для поиска.
 *
 * Принимает слово запроса. Возвращает его начало.
 *
 * Полноценной морфологии здесь нет и не нужно: в юридических текстах одно и
 * то же слово встречается во всех падежах («неустойка», «неустойки»,
 * «неустойкой»), и человек, набравший любую форму, ожидает найти остальные.
 * Отбрасывание одной-двух последних букв даёт это почти всегда, а ошибается
 * в сторону более широкого поиска — лишний результат заметить легче, чем
 * пропущенный.
 */
export function searchStem(word) {
  const normalized = normalizeForSearch(word).trim();
  if (normalized.length >= 6) {
    return normalized.slice(0, -2);
  }
  if (normalized.length >= 4) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Перечисляет позиции вхождений основы в тексте.
 *
 * Принимает нормализованный текст и основу. Возвращает список позиций
 * начала каждого вхождения.
 */
export function findMatches(normalizedText, stem) {
  const positions = [];
  if (!stem) {
    return positions;
  }
  let index = normalizedText.indexOf(stem);
  while (index !== -1) {
    positions.push(index);
    index = normalizedText.indexOf(stem, index + stem.length);
  }
  return positions;
}

/**
 * Собирает фрагмент текста вокруг найденного места.
 *
 * Принимает исходный текст, позицию и длину совпадения. Возвращает части
 * «до», «совпадение» и «после» отдельно, чтобы показывающий код мог
 * подсветить совпадение, ничего не разбирая заново.
 *
 * Границы фрагмента переносятся на ближайший пробел: обрывок слова посреди
 * фразы читается хуже, чем чуть более длинный фрагмент.
 */
export function buildSnippet(text, position, length) {
  const rawStart = Math.max(0, position - SNIPPET_RADIUS);
  const rawEnd = Math.min(text.length, position + length + SNIPPET_RADIUS);

  const start = rawStart === 0 ? 0 : shiftToWordBoundary(text, rawStart, 1);
  const end = rawEnd === text.length ? text.length : shiftToWordBoundary(text, rawEnd, -1);

  return {
    before: (start > 0 ? "…" : "") + text.slice(start, position).replace(/\s+/g, " "),
    match: text.slice(position, position + length),
    after: text.slice(position + length, end).replace(/\s+/g, " ")
      + (end < text.length ? "…" : ""),
  };
}

/**
 * Сдвигает позицию до ближайшего пробела в указанную сторону.
 *
 * Принимает текст, позицию и направление. Если пробела рядом нет, возвращает
 * исходную позицию — лучше обрывок, чем фрагмент во всю статью.
 */
function shiftToWordBoundary(text, position, direction) {
  const limit = 15;
  for (let shift = 0; shift < limit; shift += 1) {
    const candidate = position + shift * direction;
    if (candidate <= 0 || candidate >= text.length) {
      return candidate;
    }
    if (/\s/.test(text[candidate])) {
      return candidate + (direction > 0 ? 1 : 0);
    }
  }
  return position;
}

/**
 * Ищет статьи, подходящие под запрос.
 *
 * Принимает список статей и строку запроса. Возвращает записи с самой
 * статьёй, числом совпадений и фрагментами текста.
 *
 * Совпадения в заголовке ставятся выше совпадений в тексте: человек,
 * набравший «неустойка», скорее ищет статью про неустойку, чем статью, где
 * она упомянута вскользь.
 */
export function searchArticles(articles, query) {
  const stem = searchStem(query);
  if (!stem) {
    return [];
  }

  const byTitle = [];
  const byBody = [];

  articles.forEach((article) => {
    const titleMatches = findMatches(normalizeForSearch(article.title), stem);
    const bodyMatches = findMatches(normalizeForSearch(article.body), stem);
    if (!titleMatches.length && !bodyMatches.length) {
      return;
    }

    const result = {
      article: article,
      matchCount: titleMatches.length + bodyMatches.length,
      inTitle: titleMatches.length > 0,
      snippets: bodyMatches
        .slice(0, MAX_SNIPPETS_PER_ARTICLE)
        .map((position) => buildSnippet(article.body, position, stem.length)),
    };
    (titleMatches.length ? byTitle : byBody).push(result);
  });

  return byTitle.concat(byBody);
}
