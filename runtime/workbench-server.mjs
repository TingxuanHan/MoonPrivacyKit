import { createServer } from 'node:http';
import { readFile, readdir, mkdir, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createLedger, ledgerStatus, listReleases, savedRelease } from './ledger.mjs';
import { publishTableRelease } from './table.mjs';

const MAX_BODY = 12_000_000;
const NAME = /^[\p{L}\p{N} _-]{1,60}$/u;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
};

class ApiError extends Error {
  constructor(code, status, message) { super(message); this.code = code; this.status = status; }
}
function reject(code, status, message) { throw new ApiError(code, status, message); }
function projectName(value) {
  if (typeof value !== 'string' || value !== value.trim() || !NAME.test(value) || RESERVED.test(value)) {
    reject('INVALID_NAME', 400, '项目名称限 1 至 60 个中文、字母、数字、空格、短横线或下划线，首尾不要留空格。');
  }
  return value;
}
function projectId(name) { return Buffer.from(name).toString('base64url'); }
function projectFile(directory, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,320}$/.test(id)) reject('INVALID_PROJECT', 400, '请选择有效的统计项目。');
  const name = Buffer.from(id, 'base64url').toString('utf8');
  if (projectId(name) !== id) reject('INVALID_PROJECT', 400, '请选择有效的统计项目。');
  return resolve(directory, `${projectName(name)}.sqlite`);
}
function shape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) {
    reject('INVALID_REQUEST', 400, '请求格式不正确，请刷新页面后重试。');
  }
}
async function body(request) {
  if (request.headers['content-type'] !== 'application/json') reject('JSON_REQUIRED', 415, '仅接受 JSON 请求。');
  if (request.headers['content-encoding']) reject('INVALID_REQUEST', 400, '不支持压缩请求。');
  if (Number(request.headers['content-length'] || 0) > MAX_BODY) reject('INPUT_TOO_LARGE', 413, '文件超过本机处理上限，请缩小输入。');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) reject('INPUT_TOO_LARGE', 413, '文件超过本机处理上限，请缩小输入。');
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { reject('INVALID_REQUEST', 400, '请求格式不正确，请检查文件后重试。'); }
}
function safeError(error) {
  if (error instanceof ApiError) return error;
  const known = {
    INVALID_BUDGET: [400, '预算格式不正确，请使用最多六位小数；总预算须在 0.01 至 1000 之间。'],
    INVALID_REQUEST: [400, '统计设置不正确，请检查类别、每人上限及本次预算。'],
    BUDGET_EXHAUSTED: [409, '项目剩余预算不足，未生成新报告。已有报告仍可查看和下载。'],
    REQUEST_CONFLICT: [409, '本次发布编号已保存其他数据或设置的结果，请先恢复该报告。'],
    RELEASE_NOT_FOUND: [404, '尚未找到这次发布的报告，请稍后恢复，或用原文件和设置重试。'],
    LEDGER_BUSY: [503, '项目正在处理另一项发布，请稍后使用同一编号重试。'],
    INVALID_LEDGER: [409, '项目账本无法通过校验。请保留原文件，不要重建或覆盖。'],
    SCOPE_MISMATCH: [409, '项目范围发生变化，请保留原账本并重新选择项目。'],
    RELEASE_FAILED: [503, '暂时无法生成受保护统计，请使用同一编号重试。'],
    LEDGER_IO: [500, '项目读写未完成。请先恢复本次报告，不要改用新编号发布。'],
  };
  if (error?.name === 'LedgerError' && known[error.code]) {
    const [status, message] = known[error.code];
    return new ApiError(error.code, status, message);
  }
  return new ApiError('LOCAL_IO', 500, '本机操作未完成，请检查目录权限并恢复本次报告。');
}

export function createWorkbenchServer({ root, dataDir }) {
  const directory = resolve(dataDir);
  const token = randomBytes(32).toString('hex');
  const routes = new Map([
    ['/', ['web/index.html', 'text/html; charset=utf-8']],
    ['/web/app.mjs', ['web/app.mjs', 'text/javascript; charset=utf-8']],
    ['/web/statistics.mjs', ['web/statistics.mjs', 'text/javascript; charset=utf-8']],
    ['/web/style.css', ['web/style.css', 'text/css; charset=utf-8']],
    ['/runtime/client.mjs', ['runtime/client.mjs', 'text/javascript; charset=utf-8']],
    ['/dist/core.js', ['dist/core.js', 'text/javascript; charset=utf-8']],
  ]);
  async function existing(id) {
    const file = projectFile(directory, id);
    let info;
    try { info = await lstat(file); }
    catch { reject('PROJECT_NOT_FOUND', 404, '找不到该项目，请刷新项目列表。'); }
    if (!info.isFile() || info.isSymbolicLink()) reject('INVALID_PROJECT', 400, '请选择正常的本地项目账本。');
    return file;
  }
  async function projects() {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const items = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      if (!entry.isFile() || !entry.name.endsWith('.sqlite')) continue;
      const name = entry.name.slice(0, -7);
      if (!NAME.test(name) || name !== name.trim() || RESERVED.test(name)) continue;
      const id = projectId(name);
      try { items.push({ id, name, status: ledgerStatus(projectFile(directory, id)) }); }
      catch { items.push({ id, name, error: '项目账本无法读取，请保留原文件并检查。' }); }
    }
    return items;
  }
  const server = createServer(async (request, response) => {
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { ...HEADERS, 'Content-Type': type });
      response.end(request.method === 'HEAD' ? undefined : type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      const port = server.address().port;
      const host = request.headers.host;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) reject('INVALID_HOST', 400, '无效的本机地址。');
      if (!request.url.startsWith('/') || request.url.startsWith('//')) reject('INVALID_REQUEST', 400, '无效的请求地址。');
      const url = new URL(request.url, `http://${host}`);
      if (!url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(request.method)) reject('METHOD_NOT_ALLOWED', 405, '此地址不接受写入请求。');
        const route = routes.get(url.pathname);
        if (!route) reject('NOT_FOUND', 404, '找不到该资源。');
        let data;
        try { data = await readFile(resolve(root, route[0])); }
        catch { reject('BUILD_MISSING', 503, '请先构建本地工作台。'); }
        send(200, data, route[1]);
        return;
      }
      const origin = `http://${host}`;
      if ((request.headers.origin && request.headers.origin !== origin) ||
          (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) {
        reject('ORIGIN_REJECTED', 403, '请从本机工作台页面操作。');
      }
      if (url.pathname === '/api/session' && request.method === 'GET' && !url.search) {
        send(200, { ok: true, data: { token } });
        return;
      }
      const supplied = request.headers['x-moonprivacykit-token'];
      if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) reject('SESSION_REQUIRED', 401, '本机会话已失效，请重新连接。');
      if (request.method === 'POST' && request.headers.origin !== origin) reject('ORIGIN_REJECTED', 403, '请从本机工作台页面操作。');
      if (url.pathname === '/api/projects' && !url.search) {
        if (request.method === 'GET') { send(200, { ok: true, data: await projects() }); return; }
        if (request.method === 'POST') {
          const input = await body(request); shape(input, ['name', 'totalEpsilon']);
          const name = projectName(input.name);
          const id = projectId(name);
          const file = projectFile(directory, id);
          await mkdir(directory, { recursive: true, mode: 0o700 });
          try { await lstat(file); reject('PROJECT_EXISTS', 409, '同名项目已存在，请选择已有项目继续。'); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          const status = createLedger(file, { scope: randomUUID(), totalEpsilon: input.totalEpsilon });
          send(201, { ok: true, data: { id, name, status } }); return;
        }
      }
      const match = /^\/api\/projects\/([A-Za-z0-9_-]+)\/(status|releases|publish)(?:\/([A-Za-z0-9._:-]+))?$/.exec(url.pathname);
      if (!match) reject('NOT_FOUND', 404, '找不到该操作。');
      const [, id, operation, requestId] = match;
      const file = await existing(id);
      if (request.method === 'GET' && operation === 'status' && !requestId && !url.search) {
        send(200, { ok: true, data: ledgerStatus(file) }); return;
      }
      if (request.method === 'GET' && operation === 'releases') {
        if (requestId && !url.search) { send(200, { ok: true, data: savedRelease(file, requestId) }); return; }
        if (!requestId && [...url.searchParams.keys()].every(k => k === 'offset')) {
          const offset = url.searchParams.get('offset') || '0';
          if (!/^\d{1,8}$/.test(offset)) reject('INVALID_REQUEST', 400, '无效的历史页码。');
          send(200, { ok: true, data: listReleases(file, { offset: Number(offset) }) }); return;
        }
      }
      if (request.method === 'POST' && operation === 'publish' && !requestId && !url.search) {
        const input = await body(request); shape(input, ['format', 'input', 'plan']);
        const fields = ['requestId', 'query', 'epsilon', 'maxContributions', 'unitField'];
        if (input.plan?.query === 'histogram') fields.push('categoryField', 'categories');
        shape(input.plan, fields);
        const plan = { ...input.plan, schemaVersion: 1, scope: ledgerStatus(file).scope };
        let result;
        try { result = publishTableRelease(file, input.format, input.input, plan); }
        catch (error) {
          if (error.name === 'LedgerError') throw error;
          let message = '文件或字段设置不正确，请检查格式、列名、人员标识和预设类别。';
          if (/predefined public domain/.test(error.message)) message = '存在不属于预设类别的值，请复核文件与公开类别设置。未生成报告。';
          else if (/unit identifiers|mapped JSON field|unit field/.test(error.message)) message = '人员标识或类别字段缺失、类型不正确，或含首尾空白，请修正后重试。';
          else if (/duplicate keys/.test(error.message)) message = 'JSON 存在重复字段名，请修正后重试。';
          reject('INVALID_TABLE', 400, message);
        }
        send(200, { ok: true, data: result }); return;
      }
      reject('METHOD_NOT_ALLOWED', 405, '此操作不支持当前请求方式。');
    } catch (error) {
      const safe = safeError(error);
      if (!response.headersSent && !response.destroyed) send(safe.status, { ok: false, code: safe.code, message: safe.message });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
