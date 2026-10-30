import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export type Entry = { directory: boolean; data?: Buffer };

function keyOf(pathname: string) {
  const decoded = decodeURIComponent(pathname).replace(/\/+$/, '');
  return decoded || '/';
}

function parentOf(key: string) {
  return key.slice(0, key.lastIndexOf('/')) || '/';
}

function xmlEscape(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function createDavServer(username = 'tester', password = 'secret') {
  const entries = new Map<string, Entry>([['/', { directory: true }]]);
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

  async function readBody(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.authorization !== authorization) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Restricted"', 'Content-Type': 'text/plain' });
      res.end('Not Authorized');
      return;
    }
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    const key = keyOf(pathname);
    if (req.method === 'OPTIONS') {
      res.writeHead(200, { DAV: '1, 2' });
      res.end();
      return;
    }
    if (req.method === 'MKCOL') {
      if (entries.has(key)) {
        res.writeHead(405);
        res.end();
        return;
      }
      if (!entries.get(parentOf(key))?.directory) {
        res.writeHead(409);
        res.end();
        return;
      }
      entries.set(key, { directory: true });
      res.writeHead(201);
      res.end();
      return;
    }
    if (req.method === 'PUT') {
      if (!entries.get(parentOf(key))?.directory) {
        res.writeHead(409);
        res.end();
        return;
      }
      entries.set(key, { directory: false, data: await readBody(req) });
      res.writeHead(201);
      res.end();
      return;
    }
    const entry = entries.get(key);
    if (!entry) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method === 'PROPFIND') {
      const depth = req.headers.depth === '1' ? 1 : 0;
      const items = [{ key, entry }];
      if (entry.directory && depth === 1) {
        for (const [childKey, childEntry] of entries) {
          if (childKey !== key && parentOf(childKey) === key) items.push({ key: childKey, entry: childEntry });
        }
      }
      const responses = items.map(({ key: itemKey, entry: itemEntry }) => {
        const href = itemKey === '/' ? '/' : encodeURI(itemKey + (itemEntry.directory ? '/' : ''));
        const type = itemEntry.directory ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>';
        const length = itemEntry.directory ? '' : `<D:getcontentlength>${itemEntry.data?.length ?? 0}</D:getcontentlength>`;
        return `<D:response><D:href>${xmlEscape(href)}</D:href><D:propstat><D:prop>${type}${length}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
      });
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`);
      return;
    }
    if (req.method === 'GET') {
      if (entry.directory) {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Length': entry.data?.length ?? 0 });
      res.end(entry.data);
      return;
    }
    if (req.method === 'DELETE') {
      for (const itemKey of [...entries.keys()]) {
        if (itemKey === key || itemKey.startsWith(`${key}/`)) entries.delete(itemKey);
      }
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      res.writeHead(500);
      res.end(String(error));
    });
  });

  return new Promise<{
    url: string;
    entries: Map<string, Entry>;
    request: (method: string, path: string, body?: string) => Promise<{ status: number }>;
    close: () => Promise<void>;
  }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('无法获取测试端口'));
        return;
      }
      const url = `http://127.0.0.1:${address.port}/`;
      resolve({
        url,
        entries,
        async request(method, path, body) {
          const response = await fetch(`${url}${path.replace(/^\//, '')}`, {
            method,
            headers: { Authorization: authorization },
            body,
          });
          await response.arrayBuffer();
          return { status: response.status };
        },
        close: () => new Promise<void>((done, fail) => server.close(error => (error ? fail(error) : done()))),
      });
    });
  });
}
