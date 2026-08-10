/**
 * Collapses the build into one self-contained HTML file.
 *
 * The game has no textures, no audio files and no fonts — every asset is
 * generated at runtime — so the whole thing fits in a single document with
 * nothing to fetch. That makes it trivial to host: drop the file anywhere, or
 * open it straight off disk.
 *
 *   node scripts/bundle-single.mjs [--body-only]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
const assets = readdirSync(join(dist, 'assets'));

const css = assets.find((f) => f.endsWith('.css'));
const js = assets.find((f) => f.endsWith('.js'));
if (!css || !js) throw new Error('No build found — run `npm run build` first.');

const styles = readFileSync(join(dist, 'assets', css), 'utf8');
// The map isn't travelling with us, so drop the reference to it.
const script = readFileSync(join(dist, 'assets', js), 'utf8').replace(
  /\n?\/\/# sourceMappingURL=.*$/,
  '',
);

const markup = readFileSync(join(dist, 'index.html'), 'utf8');
const body = markup.slice(markup.indexOf('<body>') + 6, markup.indexOf('</body>'))
  .replace(/<script[^>]*><\/script>/g, '')
  .replace(/<link[^>]*>/g, '')
  .trim();

const bodyOnly = process.argv.includes('--body-only');

const page = `<title>Ocean Surf</title>
<style>${styles}</style>
${body}
<script type="module">${script}</script>`;

const output = bodyOnly
  ? page
  : `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no" />
${page.slice(0, page.indexOf('</style>') + 8)}
</head>
<body>
${page.slice(page.indexOf('</style>') + 8)}
</body>
</html>`;

const target = bodyOnly ? join(dist, 'ocean-surf.body.html') : join(dist, 'ocean-surf.html');
writeFileSync(target, output);

const kb = (Buffer.byteLength(output) / 1024).toFixed(0);
console.log(`${target} — ${kb} kB, self-contained, zero network requests`);
