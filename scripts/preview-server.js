const fs = require('fs');
const http = require('http');
const path = require('path');

const port = Number(process.argv[2] || 4173);
const root = path.resolve(__dirname, '..', 'dist');
const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp'
};

function sendFile(request, response, filePath) {
    response.writeHead(200, {
        'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
    });
    if (request.method === 'HEAD') return response.end();
    fs.createReadStream(filePath).on('error', () => {
        if (!response.headersSent) response.writeHead(500);
        response.end('Preview error');
    }).pipe(response);
}

http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch (error) { pathname = '/'; }

    if (pathname.startsWith('/api/')) {
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'API chỉ hoạt động trên môi trường Netlify.' }));
        return;
    }

    const relativePath = pathname.replace(/^\/+/, '');
    const requestedPath = path.resolve(root, relativePath || 'index.html');
    const insideRoot = requestedPath === root || requestedPath.startsWith(root + path.sep);
    const fallbackPath = path.join(root, 'index.html');
    if (!insideRoot) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
    }

    fs.stat(requestedPath, (error, stats) => {
        if (!error && stats.isFile()) return sendFile(request, response, requestedPath);
        if (!error && stats.isDirectory()) {
            const indexPath = path.join(requestedPath, 'index.html');
            if (fs.existsSync(indexPath)) return sendFile(request, response, indexPath);
        }
        sendFile(request, response, fallbackPath);
    });
}).listen(port, '127.0.0.1', () => {
    console.log(`Preview: http://127.0.0.1:${port}/`);
});
