import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface TestServer {
  host: string;
  url: (path: string) => string;
  requests: IncomingMessage[];
  close: () => Promise<void>;
}

/** A loopback HTTP server whose handler is chosen per test. */
export async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, n: number) => void,
): Promise<TestServer> {
  const requests: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    requests.push(req);
    handler(req, res, requests.length);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const host = `127.0.0.1:${port}`;
  return {
    host,
    url: (path) => `http://${host}${path}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
