import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const styleCss=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
const previewCss=readFileSync(new URL('../src/question-preview.css',import.meta.url),'utf8');
const mainTsx=readFileSync(new URL('../src/main.tsx',import.meta.url),'utf8');

test('侧栏宽度由变量控制并支持收缩为图标栏',()=>{
 assert.match(styleCss,/\.app-shell\{--sidebar-width:230px/);
 assert.match(styleCss,/\.sidebar\{position:fixed[^}]*width:var\(--sidebar-width\)/);
 assert.match(styleCss,/\.workspace\{margin-left:var\(--sidebar-width\)/);
 assert.match(styleCss,/\.app-shell\.is-sidebar-collapsed\{--sidebar-width:72px\}/);
 assert.match(styleCss,/@media\(max-width:1100px\)\{[^}]*\.app-shell\{--sidebar-width:200px\}/);
 assert.match(styleCss,/@media\(max-width:720px\)\{\.app-shell,\.app-shell\.is-sidebar-collapsed\{--sidebar-width:65px\}/);
 const collapsedAt=styleCss.lastIndexOf('.app-shell.is-sidebar-collapsed{--sidebar-width:72px}');
 const mobileAt=styleCss.lastIndexOf('@media(max-width:720px){.app-shell,.app-shell.is-sidebar-collapsed{--sidebar-width:65px}');
 assert.ok(collapsedAt>=0&&mobileAt>collapsedAt,'移动端宽度必须覆盖桌面收缩态');
 assert.doesNotMatch(styleCss,/\.sidebar\{width:(?:230|200|65)px/);
 assert.doesNotMatch(styleCss,/\.workspace\{margin-left:(?:230|200|65)px\}/);
 assert.match(mainTsx,/localStorage\.getItem\('anime-quiz\.sidebar'\)/);
 assert.match(mainTsx,/is-sidebar-collapsed/);
 assert.match(mainTsx,/className="sidebar-toggle"/);
});

test('展开预览从内容区左边缘开始并随侧栏宽度调整',()=>{
 assert.match(previewCss,/\.question-preview\.is-expanded\{position:fixed;inset:18px 18px 18px calc\(var\(--sidebar-width,230px\) \+ 18px\)/);
 assert.match(previewCss,/@media\(max-width:700px\)\{\.question-preview\.is-expanded\{inset:6px 6px 6px calc\(var\(--sidebar-width,65px\) \+ 6px\)/);
 assert.doesNotMatch(previewCss,/\.question-preview\.is-expanded\{position:fixed;inset:18px;/);
});
