// Builds the Netlify site: the landing page at / and the game at /play/.
// Usage: npm run build:site  (output in dist/)
import { execSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
execSync('npx tsc --noEmit', { stdio: 'inherit' });
execSync('npx vite build --base=/play/ --outDir dist/play --emptyOutDir', { stdio: 'inherit' });
mkdirSync('dist', { recursive: true });
cpSync('site/index.html', 'dist/index.html');
cpSync('site/media', 'dist/media', { recursive: true });
console.log('Site built: dist/index.html (landing) and dist/play/ (game)');
