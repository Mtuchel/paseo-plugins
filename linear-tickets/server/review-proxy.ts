import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { pipeline } from "node:stream";
import { constants, createBrotliCompress, createGzip } from "node:zlib";

// Plannotator serves its review page as one ~25 MB uncompressed HTML file. A phone outside the
// Mac's network reaches it through a Tailscale relay (DERP), where a transfer that size breaks
// off ("network connection lost"); compressed it is ~7 MB and loads. Every review's tailnet route
// therefore points at this proxy, which picks the review by the port the request came in on
// (`tailscale serve` keeps it in the Host header) and compresses text responses on the fly.
// Event streams, WebSocket upgrades and binary responses pass through untouched.

// Not text/event-stream: an event stream must reach the page as each event is written.
const COMPRESSIBLE = /^(?:text\/(?!event-stream)|application\/(?:json|javascript|xml|manifest\+json)|image\/svg\+xml)/i;
// About 0.4 s for the 25 MB page; higher levels save little and cost seconds per load.
const BROTLI_QUALITY = 5;

// The local port of the open review published on tailnet port `port`, or null for any other port.
export type ResolveBackend = (port: number) => Promise<number | null>;

function requestPort(request: IncomingMessage): number | null {
  const match = /:(\d{1,5})$/.exec(request.headers.host ?? "");
  return match ? Number(match[1]) : null;
}

function encodingFor(accept: string | undefined): "br" | "gzip" | null {
  if (!accept) return null;
  if (/\bbr\b/i.test(accept)) return "br";
  if (/\bgzip\b/i.test(accept)) return "gzip";
  return null;
}

async function backendOf(request: IncomingMessage, resolve: ResolveBackend): Promise<number | null> {
  const port = requestPort(request);
  return port === null ? null : resolve(port);
}

export function createReviewProxy(resolve: ResolveBackend): Server {
  const server = createServer((request, response) => {
    void backendOf(request, resolve).then((backend) => {
      if (backend === null) {
        request.resume();
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("No open plan review on this port.\n");
        return;
      }
      // Identity from the review server, so the encoding is always this proxy's choice.
      const upstream = httpRequest({ host: "127.0.0.1", port: backend, method: request.method, path: request.url, headers: { ...request.headers, "accept-encoding": "identity" } }, (reply) => {
        const status = reply.statusCode ?? 502;
        const bodyless = request.method === "HEAD" || status === 204 || status === 304;
        const encoding = bodyless || reply.headers["content-encoding"] || !COMPRESSIBLE.test(String(reply.headers["content-type"] ?? ""))
          ? null
          : encodingFor(request.headers["accept-encoding"]);
        if (!encoding) {
          response.writeHead(status, reply.headers);
          pipeline(reply, response, () => {});
          return;
        }
        const size = Number(reply.headers["content-length"]) || 0;
        const { "content-length": _length, ...headers } = reply.headers;
        response.writeHead(status, { ...headers, "content-encoding": encoding, vary: reply.headers.vary ? `${reply.headers.vary}, Accept-Encoding` : "Accept-Encoding" });
        const compress = encoding === "br"
          ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, ...(size ? { [constants.BROTLI_PARAM_SIZE_HINT]: size } : {}) } })
          : createGzip();
        pipeline(reply, compress, response, () => {});
      });
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end("The plan review is not answering.\n");
        else response.destroy();
      });
      pipeline(request, upstream, () => {});
    }, (error: unknown) => {
      console.error(`[linear-tickets] review proxy failed: ${error instanceof Error ? error.message : error}`);
      if (!response.headersSent) response.writeHead(500).end();
    });
  });

  // WebSockets: the upgrade request is replayed to the review server and both sockets are joined.
  server.on("upgrade", (request: IncomingMessage, socket, head: Buffer) => {
    void backendOf(request, resolve).then((backend) => {
      if (backend === null) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const upstream = connect(backend, "127.0.0.1", () => {
        const lines = [`${request.method} ${request.url} HTTP/1.1`];
        for (let index = 0; index < request.rawHeaders.length; index += 2) lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      // Upgraded sockets are half-open (the HTTP server's allowHalfOpen), so a hang-up on one
      // side would leave the tunnel open: either side ending or failing closes both.
      const close = () => { upstream.destroy(); socket.destroy(); };
      upstream.on("error", close);
      socket.on("error", close);
      upstream.on("end", close);
      socket.on("end", close);
      upstream.on("close", close);
      socket.on("close", close);
    }, () => socket.destroy());
  });
  return server;
}
