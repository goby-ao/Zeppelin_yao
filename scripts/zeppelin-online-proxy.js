const http = require('http');
const path = require('path');
const httpProxy = require(path.join(__dirname, '..', 'zeppelin-web', 'node_modules', 'http-proxy'));

const proxy = httpProxy.createProxyServer({
  target: 'https://dc.migu.cn',
  changeOrigin: true,
  secure: true,
  ws: true,
  timeout: 120000,
  proxyTimeout: 120000,
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

function closeSocket(socket) {
  if (!socket || socket.destroyed) {
    return;
  }
  if (typeof socket.end === 'function') {
    socket.end();
  }
  if (typeof socket.destroy === 'function') {
    socket.destroy();
  }
}

function writeProxyError(res, message) {
  if (!res) {
    return;
  }

  if (typeof res.writeHead === 'function') {
    if (!res.headersSent) {
      res.writeHead(502, {'Content-Type': 'text/plain'});
    }
    if (typeof res.end === 'function') {
      res.end(message);
    }
    return;
  }

  // In websocket proxy errors http-proxy passes the raw socket as the third arg.
  closeSocket(res);
}

proxy.on('error', function(err, req, res) {
  const message = '[zeppelin-online-proxy] proxy error: ' + err.message;
  console.error(message);
  writeProxyError(res, 'Proxy error: ' + err.message);
});

process.on('uncaughtException', function(err) {
  console.error('[zeppelin-online-proxy] uncaught exception:', err && err.stack ? err.stack : err);
});

process.on('unhandledRejection', function(reason) {
  console.error('[zeppelin-online-proxy] unhandled rejection:', reason);
});

const server = http.createServer(function(req, res) {
  if (req.method === 'OPTIONS') {
    const headers = {};
    setCors(headers, getAllowedOrigin(req));
    res.writeHead(204, headers);
    res.end();
    return;
  }
  try {
    proxy.web(req, res);
  } catch (err) {
    console.error('[zeppelin-online-proxy] proxy.web failed:', err.message);
    writeProxyError(res, 'Proxy error: ' + err.message);
  }
});

server.on('upgrade', function(req, socket, head) {
  socket.on('error', function(err) {
    console.error('[zeppelin-online-proxy] socket error:', err.message);
  });
  try {
    proxy.ws(req, socket, head);
  } catch (err) {
    console.error('[zeppelin-online-proxy] proxy.ws failed:', err.message);
    closeSocket(socket);
  }
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
