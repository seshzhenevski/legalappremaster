/** @type {import('tailwindcss').Config} */
module.exports = {
  // Библиотеки из vendor/ исключены: сканировать минифицированный Chart.js
  // незачем — своих классов там нет, а строки из его кода Tailwind принимает
  // за имена классов и раздувает сборку.
  content: ["./src/**/*.{html,js}", "!./src/js/vendor/**"],
  theme: {
    extend: {},
  },
  plugins: [],
};
