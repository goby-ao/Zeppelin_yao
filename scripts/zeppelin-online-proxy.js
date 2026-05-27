const http = require('http');
const httpProxy = require(process.cwd() + '/node_modules/http-proxy');

const proxy = httpProxy.createProxyServer({
  target: 'https://dc.migu.cn',
  changeOrigin: true,
  secure: true,
  ws: true,
});

function getAllowedOrigin(req) {
  const origin = req && req.headers && req.headers.origin;
  if (origin === 'http://localhost:9000' || origin === 'http://127.0.0.1:9000') {
    return origin;
  }
  return 'http://localhost:9000';
}

function setCors(headers, origin) {
  headers['access-control-allow-origin'] = origin;
  headers['access-control-allow-credentials'] = 'true';
  headers['access-control-allow-headers'] = 'authorization,Content-Type,X-Requested-With';
  headers['access-control-allow-methods'] = 'POST, GET, OPTIONS, PUT, HEAD, DELETE';
}

proxy.on('proxyReq', function(proxyReq) {
  proxyReq.setHeader('Origin', 'https://dc.migu.cn');
  proxyReq.setHeader('Referer', 'https://dc.migu.cn/mgwh/zeppelin/');
});

proxy.on('proxyReqWs', function(proxyReq) {
  proxyReq.setHeader('Origin', 'https://dc.migu.cn');
});

proxy.on('proxyRes', function(proxyRes, req) {
  setCors(proxyRes.headers, getAllowedOrigin(req));
});

proxy.on('error', function(err, req, res) {
  console.error('[zeppelin-online-proxy] proxy error:', err.message);
  if (res && !res.headersSent) {
    res.writeHead(502, {'Content-Type': 'text/plain'});
  }
  if (res) {
    res.end('Proxy error: ' + err.message);
  }
});

const server = http.createServer(function(req, res) {
  if (req.method === 'OPTIONS') {
    const headers = {};
    setCors(headers, getAllowedOrigin(req));
    res.writeHead(204, headers);
    res.end();
    return;
  }
  proxy.web(req, res);
});

server.on('upgrade', function(req, socket, head) {
  socket.on('error', function(err) {
    console.error('[zeppelin-online-proxy] socket error:', err.message);
  });
  proxy.ws(req, socket, head);
});

server.on('clientError', function(err, socket) {
  console.error('[zeppelin-online-proxy] client error:', err.message);
  if (socket && socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

server.listen(18080, '127.0.0.1', function() {
  console.log('[zeppelin-online-proxy] http://127.0.0.1:18080 -> https://dc.migu.cn');
});
