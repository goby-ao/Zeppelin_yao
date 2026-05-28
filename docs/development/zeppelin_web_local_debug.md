# Zeppelin Web 本地联调

本文记录 `zeppelin-web` 在本机预览 UI、通过本地反向代理连接线上 Zeppelin 后端的操作方式。

## 目标链路

```text
浏览器
  -> http://localhost:9000/mgwh/zeppelin/
  -> zeppelin-web dev server
  -> http://127.0.0.1:18080/mgwh/zeppelin/api/... 或 /mgwh/zeppelin/ws
  -> https://dc.migu.cn
```

本地页面地址固定使用：

```text
http://localhost:9000/mgwh/zeppelin/
```

不要直接打开 `http://localhost:9000/`，否则前端路由和后端 API 前缀容易不一致。

## 前置条件

1. 已连接公司 VPN。
2. 浏览器里通过 4A 可以正常访问线上入口。
3. 本机已安装 Node.js 12.22.12。`zeppelin-web` 是老前端工程，优先使用 Node 12，不建议用 Node 18/20/24 直接开发。
4. 依赖已安装。如果没有安装，先执行一次 `yarn install`；如果 Yarn 被上层 `packageManager` 配置干扰，优先不要纠缠，先确认 `node_modules` 是否已经存在。

## 启动前端

最近一次验证成功的方式是：Node 12.22.12 + `npm run dev`。原因是本机 `/Users/yao/package.json` 里有 `packageManager: pnpm@...`，会污染 `zeppelin-web` 子目录下的 Yarn/Corepack 行为，导致 `yarn run dev` 报类似下面的错误：

```text
This project's package.json defines "packageManager": "yarn@pnpm@9.15.2".
However the current global version of Yarn is 1.22.22.
```

推荐直接用下面这组命令启动：

```bash
cd /Users/yao/.codex/worktrees/4fa4/Zeppelin_yao/zeppelin-web
source ~/.nvm/nvm.sh
nvm use 12.22.12
WEB_PORT=9000 SERVER_PORT=18080 COREPACK_ENABLE_PROJECT_SPEC=0 npm run dev
```

说明：

- `WEB_PORT=9000`：本地前端页面端口。
- `SERVER_PORT=18080`：本地代理端口，前端 API/WebSocket 会转到这里。
- `COREPACK_ENABLE_PROJECT_SPEC=0`：避免上层目录的 `packageManager` 配置继续影响子进程。

如果依赖已经安装过，后续通常不需要重复执行 `yarn install`。

## 启动 18080 线上反向代理

推荐使用已经验证过的代理脚本 `/tmp/zeppelin-online-proxy.js`。注意必须在 `zeppelin-web` 目录下执行，因为脚本通过 `process.cwd() + '/node_modules/http-proxy'` 加载依赖：

```bash
/Users/yao/.nvm/versions/node/v12.22.12/bin/node /tmp/zeppelin-online-proxy.js

# 这里有一份：/Users/yao/.codex/worktrees/4fa4/Zeppelin_yao/scripts/zeppelin-online-proxy.js
```

如果不想占用当前终端，可以后台启动：

```bash
nohup node /tmp/zeppelin-online-proxy.js > /tmp/zeppelin-online-proxy.log 2>&1 &
sleep 1
lsof -nP -iTCP:18080 -sTCP:LISTEN
```

当前脚本需要包含这几个关键点：

- `target: 'https://dc.migu.cn'`
- `changeOrigin: true`
- `ws: true`
- 请求转发时把 `Origin` 改成 `https://dc.migu.cn`
- 响应时把 CORS 改回本地来源，允许 `http://localhost:9000` 和 `http://127.0.0.1:9000`
- 单独处理 `OPTIONS` 预检请求
- `proxyReqWs` 里也设置 WebSocket 的 `Origin`

可用下面命令查看当前脚本内容：

```bash
sed -n '1,220p' /tmp/zeppelin-online-proxy.js
```

如果脚本丢失，可以重新写入下面这个版本：

```bash
cat > /tmp/zeppelin-online-proxy.js <<'NODE'
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
NODE
```

旧版代理脚本只改了请求侧 `Origin`，但没有改回响应侧 CORS，容易出现：

```text
Access-Control-Allow-Origin has a value 'https://dc.migu.cn' that is not equal to the supplied origin.
```

代理逻辑保持请求路径原样透传。例如本地 `/mgwh/zeppelin/api/version` 会转到线上 `https://dc.migu.cn/mgwh/zeppelin/api/version`，本地 `/mgwh/zeppelin/ws` 会转到线上 `wss://dc.migu.cn/mgwh/zeppelin/ws`。
`socket.on('error')` 和 `clientError` 只用于防止页面刷新、WebSocket 断开时本地代理进程退出，不改变转发路径和请求头逻辑。

## 验证

检查两个端口是否启动：

```bash
lsof -nP -iTCP:9000 -sTCP:LISTEN
lsof -nP -iTCP:18080 -sTCP:LISTEN
```

验证代理连通性：

```bash
curl -x "" -sS -D - http://127.0.0.1:18080/mgwh/zeppelin/api/version -o -
```

如果返回 `authentication failed, please login`，说明代理链路是通的，但当前终端请求没有浏览器登录态。浏览器里按正常登录流程继续即可。

## 本地构建

正常构建使用 Node 12：

```bash
cd /Users/yao/.codex/worktrees/4fa4/Zeppelin_yao/zeppelin-web
source ~/.nvm/nvm.sh
nvm use 12.22.12
COREPACK_ENABLE_PROJECT_SPEC=0 yarn build:dist
```

如果误用了 Node 17+，可能遇到 OpenSSL 兼容错误，例如 `ERR_OSSL_EVP_UNSUPPORTED`。优先切回 Node 12；临时兜底才使用：

```bash
NODE_OPTIONS=--openssl-legacy-provider COREPACK_ENABLE_PROJECT_SPEC=0 yarn build:dist
```

## 常见问题

### 页面打不开或一直登录失败

先确认 VPN 和 4A 是否可用，再确认本地地址是：

```text
http://localhost:9000/mgwh/zeppelin/
```

### 18080 没有启动

`lsof` 没有监听时，重新执行上面的代理脚本。

### API 请求路径不对

观察代理终端输出。正常情况下会看到类似：

```text
[zeppelin-online-proxy] http://127.0.0.1:18080 -> https://dc.migu.cn
```

以及浏览器触发的 `/mgwh/zeppelin/api/...`、`/mgwh/zeppelin/ws` 请求。不要在代理里额外拼接 `/mgwh/zeppelin`，否则容易变成重复路径。

### WebSocket 不通

确认代理脚本里保留了：

```js
ws: true
```

以及：

```js
server.on('upgrade', function(req, socket, head) {
  socket.on('error', function(err) {
    console.error('[zeppelin-online-proxy] socket error:', err.message);
  });
  proxy.ws(req, socket, head);
});
```

### Yarn 被 Corepack 拦截

如果出现 `This project is configured to use pnpm because ... packageManager`，先加：

```bash
COREPACK_ENABLE_PROJECT_SPEC=0
```

如果仍然出现 `packageManager: yarn@pnpm@...` 这类异常，直接切到已验证的启动方式：

```bash
WEB_PORT=9000 SERVER_PORT=18080 COREPACK_ENABLE_PROJECT_SPEC=0 npm run dev
```
