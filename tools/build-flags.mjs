// Draws every country's flag into one image, public/flags.png, in the
// order of map/countries.json. The page samples it to paint each country.
// Needs a Playwright install somewhere (it's only used here, never by the
// server) and the 4x3 SVGs from the flag-icons package (MIT).
//
//   node tools/build-flags.mjs <flag-icons/flags/4x3> <path/to/node_modules/playwright/index.mjs>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [svgDir, playwrightPath] = process.argv.slice(2);
if (!svgDir || !playwrightPath) {
  console.error('usage: node tools/build-flags.mjs <flag-icons/flags/4x3> <playwright/index.mjs>');
  process.exit(1);
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)).href);
const { countries } = JSON.parse(readFileSync(join(ROOT, 'map', 'countries.json'), 'utf8'));

const FW = 160, FH = 120, COLS = 16;
const rows = Math.ceil(countries.length / COLS);
const imgs = countries.map((c, i) => {
  const svg = readFileSync(join(svgDir, `${c.code.toLowerCase()}.svg`)).toString('base64');
  return `<img src="data:image/svg+xml;base64,${svg}" style="left:${(i % COLS) * FW}px;top:${Math.floor(i / COLS) * FH}px">`;
}).join('');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: COLS * FW, height: rows * FH } });
await page.setContent(`<style>body{margin:0;background:#888}img{position:absolute;width:${FW}px;height:${FH}px}</style>${imgs}`);
await page.waitForFunction(() => [...document.images].every((i) => i.complete));
writeFileSync(join(ROOT, 'public', 'flags.png'), await page.screenshot({ type: 'png' }));
await browser.close();
writeFileSync(join(ROOT, 'public', 'flags.json'), JSON.stringify({ width: FW, height: FH, cols: COLS }));
console.log(`${countries.length} flags, ${COLS * FW}x${rows * FH}`);
