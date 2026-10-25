// Builds a single self-contained HTML page (JS, CSS and terrain inlined) for
// hosts that only serve one file and allow no external requests.
// Usage: npm run build && tsx tools/build-artifact.ts [out.html]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');
const out = process.argv[2] ?? join(dist, 'artifact.html');
const assets = readdirSync(join(dist, 'assets'));
const js = readFileSync(join(dist, 'assets', assets.find((f) => f.endsWith('.js'))!), 'utf8');
const css = readFileSync(join(dist, 'assets', assets.find((f) => f.endsWith('.css'))!), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script type="module"'));
const t = (f: string) => join(root, 'public', 'terrain', f);
const terrain = {
  meta: JSON.parse(readFileSync(t('everest.json'), 'utf8')),
  bin: readFileSync(t('everest.bin')).toString('base64'),
  route: JSON.parse(readFileSync(t('route.json'), 'utf8')),
  farMeta: JSON.parse(readFileSync(t('far.json'), 'utf8')),
  far: readFileSync(t('far.bin')).toString('base64'),
};
const safe = (s: string) => s.replace(/<\/script/gi, '<\\/script');
const page = `<title>The Mountain</title>
<style>${css}</style>
${body}
<script>window.__TERRAIN__ = ${JSON.stringify(terrain)};</script>
<script type="module">${safe(js)}</script>
`;
writeFileSync(out, page);
console.log(`${out}: ${(page.length / 1e6).toFixed(2)} MB`);
