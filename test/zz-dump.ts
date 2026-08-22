import { renderPage } from '../src/render.ts';
import { health, row } from './fleet-fixtures.ts';
const css = /<style>([\s\S]*?)<\/style>/.exec(renderPage({ rows: [row()], health: health() }, 'map'))![1].replace(/\/\*[\s\S]*?\*\//g, '');
const start = css.indexOf('@media (max-width: 46rem)');
let depth = 0; let out = '';
for (let i = css.indexOf('{', start); i < css.length; i++) { if (css[i]==='{') depth++; else if (css[i]==='}' && --depth===0) { out = css.slice(start, i); break; } }
console.log(out);
