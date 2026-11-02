// Read-only local preview; never proxies requests to the appointment website.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.wav':'audio/wav','.txt':'text/plain; charset=utf-8'};
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') { res.writeHead(302, {Location:'/extension/options.html'}); res.end(); return; }
    const relative = decodeURIComponent(url.pathname === '/' ? '/extension/options.html' : url.pathname);
    const file = path.resolve(root, '.' + relative);
    if (!file.startsWith(root + path.sep) || !['extension','tests'].includes(path.relative(root, file).split(path.sep)[0])) { res.writeHead(403); res.end(); return; }
    let content = fs.readFileSync(file);
    if (file.endsWith(path.join('extension', 'options.html'))) content = Buffer.from(content.toString('utf8').replace('<script defer src="core.js">', '<script src="/tests/demo-chrome.js"></script><script defer src="core.js">'));
    res.writeHead(200, {'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store'}); res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(8765, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:8765/  DOM tests: http://127.0.0.1:8765/tests/browser.html'));
