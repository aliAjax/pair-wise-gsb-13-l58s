/**
 * server.js —— 零依赖静态文件服务器（仅使用 Node 内置模块）
 * 用法：npm start  或  node server.js  ，默认 http://127.0.0.1:8931
 * 页面本身是纯静态文件，也可以直接双击 index.html 打开。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 8931;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const safePath = path
      .normalize(urlPath)
      .replace(/^(\.\.[/\\])+/, "")
      .replace(/^[/\\]+/, "");
    const filePath = path.join(ROOT, safePath || "index.html");

    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 Not Found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-cache"
      });
      fs.createReadStream(filePath).pipe(res);
    });
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log("加油站班次交接已启动：http://127.0.0.1:" + PORT);
  });
