/** @type {import('tailwindcss').Config} */
// Дизайн-система «графит на белом» (design_new/DESIGN.md) с акцентом #0055FE.
// Цвета вынесены в CSS-переменные (каналы «R G B») — см. src/css/input.css.
// Значения токенов меняются одним классом `dark` на <html>, а классы в разметке
// (slate/blue/white/…) остаются прежними и переключаются автоматически.
//
// Формат rgb(var(--c-*) / <alpha-value>) сохраняет работу модификаторов
// прозрачности Tailwind (bg-black/50, bg-blue-600/… и т. п.).
const ch = (name) => `rgb(var(${name}) / <alpha-value>)`;

module.exports = {
  // Библиотеки из vendor/ исключены: сканировать минифицированный Chart.js
  // незачем — своих классов там нет, а строки из его кода Tailwind принимает
  // за имена классов и раздувает сборку.
  content: ["./src/**/*.{html,js}", "!./src/js/vendor/**"],
  theme: {
    extend: {
      colors: {
        // Поверхность карточек. text-white заменён на text-oncolor, поэтому
        // «white» отвечает только за фоны и корректно темнеет в тёмной теме.
        white: ch("--c-white"),
        // Подпись на цветной кнопке (всегда светлая) и нейтральная тёмная кнопка.
        oncolor: ch("--c-oncolor"),
        graphite: ch("--c-graphite"),

        slate: {
          50: ch("--c-slate-50"),
          100: ch("--c-slate-100"),
          200: ch("--c-slate-200"),
          300: ch("--c-slate-300"),
          400: ch("--c-slate-400"),
          500: ch("--c-slate-500"),
          600: ch("--c-slate-600"),
          700: ch("--c-slate-700"),
          800: ch("--c-slate-800"),
          900: ch("--c-slate-900"),
        },
        blue: {
          50: ch("--c-blue-50"),
          100: ch("--c-blue-100"),
          400: ch("--c-blue-400"),
          500: ch("--c-blue-500"),
          600: ch("--c-blue-600"),
          700: ch("--c-blue-700"),
        },
        red: {
          50: ch("--c-red-50"),
          100: ch("--c-red-100"),
          200: ch("--c-red-200"),
          500: ch("--c-red-500"),
          600: ch("--c-red-600"),
          800: ch("--c-red-800"),
          900: ch("--c-red-900"),
        },
        amber: {
          50: ch("--c-amber-50"),
          200: ch("--c-amber-200"),
          600: ch("--c-amber-600"),
          800: ch("--c-amber-800"),
          900: ch("--c-amber-900"),
        },
        green: {
          100: ch("--c-green-100"),
          600: ch("--c-green-600"),
          700: ch("--c-green-700"),
        },
        emerald: {
          50: ch("--c-emerald-50"),
        },
      },
      // Радиусы референса: контролы и карточки 10px, крупные поверхности 16px
      borderRadius: {
        lg: "10px",
        xl: "10px",
        "2xl": "16px",
      },
    },
  },
  plugins: [],
};
