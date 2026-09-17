// toastui-entry.js
// Точка входа для сборки редактора Toast UI в один файл.
//
// В проекте нет сборщика для собственного кода — вкладки подключаются как
// модули напрямую. Но этот редактор в готовом виде подключить нельзя: его
// файл из npm ожидает восемь модулей ProseMirror снаружи и при подключении
// тегом script получает вместо них пустоту. Поэтому esbuild собирает его
// вместе с зависимостями в src/js/vendor/toastui-editor.js — результат
// коммитится, как и chart.umd.js, чтобы сборка приложения не зависела от
// доступности реестра npm.
//
// Пересобрать: npm run build:vendor
//
// Лицензия редактора — MIT, автор NHN Cloud FE Development Lab.

import Editor from "@toast-ui/editor";
import "@toast-ui/editor/dist/i18n/ru-ru";

export default Editor;
