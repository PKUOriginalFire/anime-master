#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtempSync, rmdirSync, lstatSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PREFIX = '[webdav-backup]';
const SNAPSHOT_RE = /^\d{8}T\d{6}Z$/;
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getcontentlength/></D:prop></D:propfind>';

export function normalizeRemotePath(value) {
  const parts = String(value || '').split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) throw new Error('WEBDAV_PATH 不能包含 . 或 ..');
  return parts.map(part => encodeURIComponent(part)).join('/');
}

export function parseConfig(env = process.env) {
  const rawUrl = String(env.WEBDAV_URL || '').trim();
  if (!rawUrl) throw new Error('缺少 WEBDAV_URL');
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('WEBDAV_URL 不是合法 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('WEBDAV_URL 仅支持 http/https');
  if (url.username || url.password) throw new Error('不要把凭证写进 WEBDAV_URL，请使用 WEBDAV_USERNAME 和 WEBDAV_PASSWORD');
  if (url.search || url.hash) throw new Error('WEBDAV_URL 不能包含查询参数或锚点');
  const username = String(env.WEBDAV_USERNAME || '');
  const password = String(env.WEBDAV_PASSWORD || '');
  if (!username || !password) throw new Error('缺少 WEBDAV_USERNAME 或 WEBDAV_PASSWORD');
  const remotePath = normalizeRemotePath(env.WEBDAV_PATH);
  if (!remotePath) throw new Error('缺少 WEBDAV_PATH');
  const keep = Number(env.WEBDAV_BACKUP_KEEP || 7);
  if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw new Error('WEBDAV_BACKUP_KEEP 必须是 1-365 的整数');
  const timeoutMs = Number(env.WEBDAV_TIMEOUT_MS || 600000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5000) throw new Error('WEBDAV_TIMEOUT_MS 不能小于 5000');
  const baseUrl = url.href.endsWith('/') ? url.href : `${url.href}/`;
  return {
    dataDir: String(env.DATA_DIR || 'runtime'),
    baseUrl,
    username,
    password,
    remotePath,
    keep,
    insecureTls: /^(1|true|yes)$/i.test(String(env.WEBDAV_INSECURE_TLS || '')),
    label: String(env.WEBDAV_BACKUP_LABEL || 'anime-quiz'),
    timeoutMs,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function rawRequest(config, url, method, options = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers = {
      Authorization: basicAuth(config.username, config.password),
      ...(options.headers || {}),
    };
    if (options.contentType) headers['Content-Type'] = options.contentType;
    const req = request(target, {
      method,
      headers,
      timeout: config.timeoutMs,
      rejectUnauthorized: target.protocol === 'https:' ? !config.insecureTls : undefined,
    }, response => {
      const chunks = [];
      let received = 0;
      response.on('data', chunk => {
        received += chunk.length;
        if (received <= 64 * 1024) chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
        received,
      }));
    });
    req.on('timeout', () => req.destroy(new Error('WebDAV 请求超时')));
    req.on('error', reject);
    if (options.filePath) {
      req.setHeader('Content-Length', statSync(options.filePath).size);
      pipeline(createReadStream(options.filePath), req).catch(reject);
    } else if (options.body !== undefined) {
      const body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
      req.setHeader('Content-Length', body.length);
      req.end(body);
    } else {
      req.end();
    }
  });
}

async function requestWithRetry(config, url, method, options, logger) {
  const attempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await rawRequest(config, url, method, options);
      if (response.status >= 500 && attempt < attempts) {
        logger(`${method} 返回 ${response.status}，重试 ${attempt}/${attempts - 1}`);
        await sleep(1000 * attempt);
        continue;
      }
      return response;
    } catch (error) {
      if (attempt >= attempts) throw error;
      logger(`${method} 请求失败，重试 ${attempt}/${attempts - 1}：${error.message}`);
      await sleep(1000 * attempt);
    }
  }
}

async function downloadWithRetry(config, url, targetPath, logger) {
  const attempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await new Promise((resolve, reject) => {
        const target = new URL(url);
        const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
        const req = request(target, {
          method: 'GET',
          headers: { Authorization: basicAuth(config.username, config.password) },
          timeout: config.timeoutMs,
          rejectUnauthorized: target.protocol === 'https:' ? !config.insecureTls : undefined,
        }, response => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`下载 ${decodeURIComponent(target.pathname)} 失败（HTTP ${response.statusCode}）`));
            return;
          }
          const expected = Number(response.headers['content-length'] || 0);
          const output = createWriteStream(targetPath, { mode: 0o600 });
          pipeline(response, output).then(() => {
            const actual = statSync(targetPath).size;
            if (expected && actual !== expected) reject(new Error(`下载 ${decodeURIComponent(target.pathname)} 不完整：${actual}/${expected} 字节`));
            else resolve();
          }).catch(reject);
        });
        req.on('timeout', () => req.destroy(new Error('WebDAV 下载超时')));
        req.on('error', reject);
        req.end();
      });
      return;
    } catch (error) {
      rmSync(targetPath, { force: true });
      if (attempt >= attempts) throw error;
      logger(`下载失败，重试 ${attempt}/${attempts - 1}：${error.message}`);
      await sleep(1000 * attempt);
    }
  }
}

async function ensureCollection(config, remotePath, logger) {
  let current = config.baseUrl;
  for (const segment of remotePath.split('/').filter(Boolean)) {
    current = new URL(`${segment}/`, current).href;
    const response = await requestWithRetry(config, current, 'MKCOL', {}, logger);
    if (response.status === 200 || response.status === 201) {
      logger(`已创建远程目录 ${decodeURIComponent(segment)}`);
      continue;
    }
    if (response.status === 405 || response.status === 409) {
      const probe = await requestWithRetry(config, current, 'PROPFIND', {
        headers: { Depth: '0' },
        body: PROPFIND_BODY,
        contentType: 'application/xml',
      }, logger);
      if (probe.status === 207) continue;
    }
    throw new Error(`无法创建远程目录 ${decodeURIComponent(segment)}（HTTP ${response.status}）`);
  }
  return current.endsWith('/') ? current : `${current}/`;
}

function decodeXml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function verifyDatabase(filePath) {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const row = database.prepare('PRAGMA quick_check').get();
    const result = row ? String(Object.values(row)[0]) : '';
    if (result !== 'ok') throw new Error(`数据库完整性检查失败：${result || '无结果'}`);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','questions','shows')").all();
    if (tables.length !== 3) throw new Error('备份数据库缺少 users、questions 或 shows 表');
  } finally {
    database.close();
  }
}

function verifyArchive(filePath) {
  const listing = execFileSync('tar', ['-tzf', filePath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  for (const name of listing.split('\n')) {
    if (!name) continue;
    const normalized = name.replaceAll('\\', '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) throw new Error(`媒体归档包含不安全路径：${name}`);
  }
}

async function createSnapshot(config, id, tempDir, logger) {
  mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  const databaseSource = join(config.dataDir, 'quiz.sqlite');
  if (!existsSync(databaseSource)) throw new Error(`数据库不存在：${databaseSource}`);
  const databaseTarget = join(tempDir, 'quiz.sqlite');
  const database = new DatabaseSync(databaseSource);
  try {
    database.exec(`VACUUM INTO '${databaseTarget.replaceAll("'", "''")}'`);
  } finally {
    database.close();
  }
  logger(`已生成数据库快照（${formatBytes(statSync(databaseTarget).size)}）`);

  const files = [{ name: 'quiz.sqlite', path: databaseTarget }];
  const mediaSource = join(config.dataDir, 'media');
  if (existsSync(mediaSource)) {
    const mediaTarget = join(tempDir, 'media.tgz');
    execFileSync('tar', ['-czf', mediaTarget, '-C', config.dataDir, 'media'], { stdio: ['ignore', 'ignore', 'pipe'] });
    files.push({ name: 'media.tgz', path: mediaTarget });
    logger(`已打包媒体（${formatBytes(statSync(mediaTarget).size)}）`);
  } else {
    logger('数据目录没有 media/，仅备份数据库');
  }

  const manifestFiles = [];
  for (const file of files) {
    manifestFiles.push({ name: file.name, size: statSync(file.path).size, sha256: await hashFile(file.path) });
  }
  const manifest = {
    schema: 1,
    id,
    createdAt: new Date().toISOString(),
    label: config.label,
    files: manifestFiles,
    restore: '恢复前停止应用并备份当前数据；用 quiz.sqlite 覆盖数据目录中的数据库，并将 media.tgz 解包到数据目录。',
  };
  const manifestPath = join(tempDir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  files.push({ name: 'manifest.json', path: manifestPath });
  return { files, manifestPath, manifest };
}

async function verifyRemoteFile(config, url, expectedSize, name, logger) {
  const response = await requestWithRetry(config, url, 'PROPFIND', {
    headers: { Depth: '0' },
    body: PROPFIND_BODY,
    contentType: 'application/xml',
  }, logger);
  if (response.status !== 207) throw new Error(`校验 ${name} 失败（HTTP ${response.status}）`);
  const match = response.body.toString('utf8').match(/<(?:[A-Za-z0-9]+:)?getcontentlength>(\d+)<\//);
  if (!match) {
    logger(`警告：服务器未返回 ${name} 的大小，跳过尺寸校验`);
    return;
  }
  if (Number(match[1]) !== expectedSize) throw new Error(`校验 ${name} 失败：远端 ${match[1]} 字节，本地 ${expectedSize} 字节`);
}

async function listSnapshots(config, baseDirUrl, logger) {
  const response = await requestWithRetry(config, baseDirUrl, 'PROPFIND', {
    headers: { Depth: '1' },
    body: PROPFIND_BODY,
    contentType: 'application/xml',
  }, logger);
  if (response.status !== 207) throw new Error(`列出远程目录失败（HTTP ${response.status}）`);
  const basePath = decodeURIComponent(new URL(baseDirUrl).pathname).replace(/\/+$/, '');
  const snapshots = new Map();
  for (const match of response.body.toString('utf8').matchAll(/<(?:[A-Za-z0-9]+:)?href>([^<]*)<\/(?:[A-Za-z0-9]+:)?href>/g)) {
    const href = decodeXml(match[1]);
    let url;
    try {
      url = new URL(href, baseDirUrl);
    } catch {
      continue;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '');
    } catch {
      continue;
    }
    const slash = pathname.lastIndexOf('/');
    if (slash < 0 || pathname.slice(0, slash) !== basePath) continue;
    const name = pathname.slice(slash + 1);
    if (!SNAPSHOT_RE.test(name)) continue;
    snapshots.set(name, url.href.endsWith('/') ? url.href : `${url.href}/`);
  }
  return [...snapshots.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([name, url]) => ({ name, url }));
}

async function pruneSnapshots(config, baseDirUrl, logger) {
  const snapshots = await listSnapshots(config, baseDirUrl, logger);
  let pruned = 0;
  for (const snapshot of snapshots.slice(config.keep)) {
    try {
      const response = await requestWithRetry(config, snapshot.url, 'DELETE', {}, logger);
      if (response.status === 200 || response.status === 204 || response.status === 404) {
        logger(`已清理旧备份 ${snapshot.name}`);
        pruned += 1;
      } else {
        logger(`清理旧备份 ${snapshot.name} 失败（HTTP ${response.status}）`);
      }
    } catch (error) {
      logger(`清理旧备份 ${snapshot.name} 失败：${error.message}`);
    }
  }
  return pruned;
}

function tryCreateLock(lockDir) {
  mkdirSync(lockDir, { mode: 0o700 });
  writeFileSync(join(lockDir, 'pid'), String(process.pid));
}

function acquireLock(lockDir) {
  try {
    tryCreateLock(lockDir);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let stale = false;
    try {
      stale = Date.now() - statSync(lockDir).mtimeMs > 6 * 60 * 60 * 1000;
    } catch {
      stale = false;
    }
    if (!stale) return false;
    try {
      rmSync(lockDir, { recursive: true, force: true });
      tryCreateLock(lockDir);
      return true;
    } catch (retryError) {
      if (retryError.code === 'EEXIST') return false;
      throw retryError;
    }
  }
}

function releaseLock(lockDir) {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // 锁目录清理失败不应覆盖备份结果
  }
}

function formatId(now) {
  return now.toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z');
}

export async function runBackup(input, options = {}) {
  const config = {
    label: 'anime-quiz',
    timeoutMs: 600000,
    ...input,
  };
  const logger = options.logger || (message => console.log(`${PREFIX} ${message}`));
  const id = formatId(options.now || new Date());
  const backupRoot = join(config.dataDir, 'backups');
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const lockDir = join(backupRoot, '.webdav-backup.lock');
  if (!acquireLock(lockDir)) {
    logger('已有备份任务在运行，本次跳过');
    return { skipped: true, reason: 'locked' };
  }
  const tempDir = join(backupRoot, `.webdav-tmp-${id}-${process.pid}`);
  let snapshotUrl = null;
  let createdRemote = false;
  try {
    logger(`开始备份 ${id}，目标 ${config.baseUrl}${config.remotePath}/`);
    const baseDirUrl = await ensureCollection(config, config.remotePath, logger);
    const snapshot = await createSnapshot(config, id, tempDir, logger);
    snapshotUrl = new URL(`${encodeURIComponent(id)}/`, baseDirUrl).href;
    const created = await requestWithRetry(config, snapshotUrl, 'MKCOL', {}, logger);
    if (created.status !== 200 && created.status !== 201) {
      throw new Error(`创建快照目录失败（HTTP ${created.status}）`);
    }
    createdRemote = true;
    for (const file of snapshot.files) {
      const response = await requestWithRetry(config, new URL(file.name, snapshotUrl).href, 'PUT', {
        filePath: file.path,
        contentType: file.name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      }, logger);
      if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
        throw new Error(`上传 ${file.name} 失败（HTTP ${response.status}）`);
      }
      logger(`已上传 ${file.name}（${formatBytes(statSync(file.path).size)}）`);
    }
    for (const file of snapshot.files) {
      await verifyRemoteFile(config, new URL(file.name, snapshotUrl).href, statSync(file.path).size, file.name, logger);
    }
    let pruned = 0;
    try {
      pruned = await pruneSnapshots(config, baseDirUrl, logger);
    } catch (error) {
      logger(`清理旧备份失败：${error.message}`);
    }
    logger(`备份完成：${id}，保留 ${config.keep} 份，清理 ${pruned} 份`);
    return { id, files: snapshot.files.map(file => file.name), pruned };
  } catch (error) {
    if (createdRemote && snapshotUrl) {
      try {
        await requestWithRetry(config, snapshotUrl, 'DELETE', {}, logger);
        logger('已删除未完成的远程快照');
      } catch (cleanupError) {
        logger(`删除未完成快照失败：${cleanupError.message}`);
      }
    }
    throw error;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    releaseLock(lockDir);
  }
}

export async function runRestore(input, options = {}) {
  const config = {
    label: 'anime-quiz',
    timeoutMs: 600000,
    ...input,
  };
  const logger = options.logger || (message => console.log(`${PREFIX} ${message}`));
  if (!options.confirm) throw new Error('恢复会覆盖数据库与媒体，请确认后传入 --yes');
  const backupRoot = join(config.dataDir, 'backups');
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const lockDir = join(backupRoot, '.webdav-backup.lock');
  if (!acquireLock(lockDir)) throw new Error('已有备份或恢复任务在运行');
  const baseDirUrl = new URL(`${config.remotePath}/`, config.baseUrl).href;
  const tempDir = join(backupRoot, `.webdav-restore-${process.pid}-${Date.now()}`);
  let preRestoreDir = null;
  try {
    const snapshots = await listSnapshots(config, baseDirUrl, logger);
    if (!snapshots.length) throw new Error('远端没有可用备份');
    const target = options.snapshot ? snapshots.find(item => item.name === options.snapshot) : snapshots[0];
    if (!target) throw new Error(`找不到备份 ${options.snapshot}`);
    logger(`选择备份 ${target.name}`);
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    const manifestPath = join(tempDir, 'manifest.json');
    await downloadWithRetry(config, new URL('manifest.json', target.url).href, manifestPath, logger);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      throw new Error('manifest.json 不是合法 JSON');
    }
    if (manifest?.schema !== 1 || !Array.isArray(manifest.files)) throw new Error('manifest.json 格式不受支持');
    if (manifest.id && manifest.id !== target.name) throw new Error('manifest.json 与备份目录名不一致');
    if (manifest.label && config.label && manifest.label !== config.label) throw new Error(`备份标签为 ${manifest.label}，当前配置为 ${config.label}；请确认恢复目标`);
    const databaseEntry = manifest.files.find(file => file?.name === 'quiz.sqlite');
    if (!databaseEntry) throw new Error('备份缺少 quiz.sqlite');
    const mediaEntry = manifest.files.find(file => file?.name === 'media.tgz');
    const selected = [databaseEntry, ...(mediaEntry ? [mediaEntry] : [])];
    for (const entry of selected) {
      if (!entry.sha256 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`manifest.json 缺少 ${entry.name} 的 sha256`);
      if (!Number.isInteger(entry.size) || entry.size < 1) throw new Error(`manifest.json 缺少 ${entry.name} 的大小`);
      const filePath = join(tempDir, entry.name);
      logger(`下载 ${entry.name}（${formatBytes(entry.size)}）`);
      await downloadWithRetry(config, new URL(entry.name, target.url).href, filePath, logger);
      const size = statSync(filePath).size;
      if (size !== entry.size) throw new Error(`${entry.name} 大小不符：${size}/${entry.size}`);
      const sha256 = await hashFile(filePath);
      if (sha256 !== entry.sha256) throw new Error(`${entry.name} sha256 校验失败`);
    }
    verifyDatabase(join(tempDir, 'quiz.sqlite'));
    const incoming = [join(tempDir, 'quiz.sqlite')];
    if (mediaEntry) {
      logger('校验媒体归档');
      const archive = join(tempDir, 'media.tgz');
      verifyArchive(archive);
      const unpacked = join(tempDir, 'unpacked');
      mkdirSync(unpacked);
      execFileSync('tar', ['-xzf', archive, '-C', unpacked, '--no-same-owner']);
      const media = join(unpacked, 'media');
      if (!lstatSync(media).isDirectory()) throw new Error('媒体归档缺少 media 目录');
      incoming.push(media);
    }
    const existing = ['quiz.sqlite', 'quiz.sqlite-wal', 'quiz.sqlite-shm']
      .map(name => join(config.dataDir, name))
      .filter(path => existsSync(path));
    const existingMedia = join(config.dataDir, 'media');
    if (existsSync(existingMedia)) existing.push(existingMedia);
    if (existing.length) {
      preRestoreDir = mkdtempSync(join(backupRoot, `pre-restore-${formatId(options.now || new Date())}-`));
    }
    const moved = [];
    const installed = [];
    try {
      for (const source of existing) {
        const targetPath = join(preRestoreDir, basename(source));
        renameSync(source, targetPath);
        moved.push({ source, targetPath });
      }
      for (const source of incoming) {
        const targetPath = join(config.dataDir, basename(source));
        renameSync(source, targetPath);
        installed.push({ source, targetPath });
      }
      logger(`恢复完成：${target.name}`);
      if (preRestoreDir) logger(`恢复前数据已保存到 ${preRestoreDir}`);
      return { id: target.name, files: selected.map(entry => entry.name), preRestoreDir };
    } catch (error) {
      logger('恢复失败，回滚恢复前数据');
      // 只逆转成功的搬移；保留未搬走的原件和无法回搬的备份。
      const failures = [];
      for (const { source, targetPath } of [...installed.reverse(), ...moved.reverse()]) {
        try {
          if (existsSync(source)) throw new Error(`回滚目标已存在：${source}`);
          renameSync(targetPath, source);
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      if (failures.length) throw new AggregateError([error, ...failures], `回滚未完成，请保留并检查 ${preRestoreDir || config.dataDir}`);
      if (preRestoreDir) rmdirSync(preRestoreDir);
      throw error;
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    releaseLock(lockDir);
  }
}

async function main() {
  const config = parseConfig();
  const result = await runBackup(config);
  if (result.skipped) console.log(`${PREFIX} 已跳过：${result.reason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`${PREFIX} 失败：${error.message}`);
    process.exitCode = 1;
  });
}
