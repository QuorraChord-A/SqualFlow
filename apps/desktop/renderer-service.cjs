const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { Module } = require("node:module");

const runtimeModulesPath = path.join(__dirname, "runtime_modules");
process.env.NODE_PATH = [runtimeModulesPath, process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter);
Module._initPaths();

// The standalone Next build bakes its rewrite targets in at build time, so a
// runtime-chosen backend port cannot flow through them. This proxy keeps the
// browser on a single origin: backend routes go straight to the local service,
// everything else goes to the Next server listening on the internal port.
const publicPort = Number(process.env.SQUADFLOW_RENDERER_PUBLIC_PORT || "");
const nextInternalPort = Number(process.env.SQUADFLOW_NEXT_INTERNAL_PORT || "");
const backendUrl = process.env.SQUADFLOW_BACKEND_URL || "";

if (publicPort && nextInternalPort && backendUrl) {
  const backend = new URL(backendUrl);
  const backendTarget = { host: backend.hostname, port: Number(backend.port) };
  const nextTarget = { host: "127.0.0.1", port: nextInternalPort };

  function targetFor(requestUrl) {
    const pathname = String(requestUrl || "").split("?")[0];
    return pathname === "/health" || pathname === "/api" || pathname.startsWith("/api/")
      ? backendTarget
      : nextTarget;
  }

  const proxy = http.createServer((req, res) => {
    const target = targetFor(req.url);
    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("upstream unavailable");
    });
    req.pipe(upstream);
  });

  proxy.on("upgrade", (req, socket, head) => {
    const target = targetFor(req.url);
    const upstream = net.connect(target.port, target.host, () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      raw += "\r\n";
      upstream.write(raw);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  proxy.listen(publicPort, "127.0.0.1");
}

require(path.join(__dirname, "server.js"));
