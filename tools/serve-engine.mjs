import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';

// A deliberately separate static host: it cannot serve application source/WASM.
const root = resolve(import.meta.dirname, '../dist-engine'), prefix = '/nested/renderer/';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.map': 'application/json' };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1:4175').pathname);
    if (!path.startsWith(prefix)) { response.writeHead(404).end(); return; }
    const file = resolve(root, path.slice(prefix.length) + (path.endsWith('/') ? 'index.html' : ''));
    const within = relative(root, file);
    if (isAbsolute(within) || within.startsWith('..')) { response.writeHead(404).end(); return; }
    const bytes = await readFile(file);
    response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'" }).end(bytes);
  } catch { response.writeHead(404).end(); }
});
server.listen(4175, '127.0.0.1', () => console.log('Standalone renderer: http://127.0.0.1:4175/nested/renderer/example/'));
