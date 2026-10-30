import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeRemotePath, parseConfig, runBackup } from '../scripts/webdav-backup.mjs';
import type { WebdavBackupConfig } from '../scripts/webdav-backup.mjs';
import { createDavServer } from './webdav-mock.ts';

function makeDataDir() {
  const dataDir = mkdtempSync(join(tmpdir(), 'anime-quiz-backup-'));
  const database = new DatabaseSync(join(dataDir, 'quiz.sqlite'));
  database.exec("CREATE TABLE questions (id INTEGER PRIMARY KEY, text TEXT); INSERT INTO questions (text) VALUES ('hello');");
  database.close();
  mkdirSync(join(dataDir, 'media'));
  writeFileSync(join(dataDir, 'media', 'clip.txt'), 'media-bytes');
  return dataDir;
}

function makeConfig(url: string, dataDir: string, password = 'secret'): WebdavBackupConfig {
  return {
    dataDir,
    baseUrl: url,
    username: 'tester',
    password,
    remotePath: 'backups/test',
    keep: 2,
    insecureTls: false,
    label: 'test',
    timeoutMs: 30000,
  };
}

test('上传数据库与媒体快照，并按保留数清理旧备份', async t => {
  const dav = await createDavServer();
  t.after(() => dav.close());
  const dataDir = makeDataDir();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  assert.equal((await dav.request('MKCOL', '/backups/')).status, 201);
  assert.equal((await dav.request('MKCOL', '/backups/test/')).status, 201);
  for (const id of ['20260101T000000Z', '20260102T000000Z', '20260103T000000Z']) {
    assert.equal((await dav.request('MKCOL', `/backups/test/${id}/`)).status, 201);
    assert.equal((await dav.request('PUT', `/backups/test/${id}/manifest.json`, '{}')).status, 201);
  }

  const result = await runBackup(makeConfig(dav.url, dataDir), {
    logger: () => {},
    now: new Date('2026-10-30T03:30:00Z'),
  });

  assert.equal(result.id, '20261030T033000Z');
  assert.deepEqual([...(result.files ?? [])].sort(), ['manifest.json', 'media.tgz', 'quiz.sqlite']);
  assert.equal(result.pruned, 2);

  const manifestEntry = dav.entries.get('/backups/test/20261030T033000Z/manifest.json');
  assert.ok(manifestEntry?.data);
  const manifest = JSON.parse(manifestEntry.data.toString('utf8')) as { files: { name: string; size: number; sha256: string }[] };
  assert.deepEqual(manifest.files.map(file => file.name), ['quiz.sqlite', 'media.tgz']);
  assert.ok(manifest.files.every(file => file.size > 0 && /^[a-f0-9]{64}$/.test(file.sha256)));

  const remaining = [...dav.entries.keys()].filter(key => /^\/backups\/test\/\d{8}T\d{6}Z$/.test(key)).sort();
  assert.deepEqual(remaining, ['/backups/test/20260103T000000Z', '/backups/test/20261030T033000Z']);
  assert.ok(!existsSync(join(dataDir, 'backups', '.webdav-backup.lock')));
  assert.deepEqual(readdirSync(join(dataDir, 'backups')).filter(name => name.startsWith('.webdav-tmp-')), []);
});

test('认证失败时不留下锁和临时文件', async t => {
  const dav = await createDavServer();
  t.after(() => dav.close());
  const dataDir = makeDataDir();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  await assert.rejects(runBackup(makeConfig(dav.url, dataDir, 'wrong'), { logger: () => {} }), /401/);

  assert.ok(!existsSync(join(dataDir, 'backups', '.webdav-backup.lock')));
  assert.deepEqual(readdirSync(join(dataDir, 'backups')).filter(name => name.startsWith('.webdav-tmp-')), []);
});

test('远程路径和配置校验', () => {
  assert.equal(normalizeRemotePath('/Backup/example/'), 'Backup/example');
  assert.throws(() => normalizeRemotePath('Backup/../secret'), /不能包含/);
  assert.throws(
    () => parseConfig({ WEBDAV_URL: 'https://user:pass@example.com/', WEBDAV_USERNAME: 'u', WEBDAV_PASSWORD: 'p', WEBDAV_PATH: 'backups' }),
    /凭证/,
  );
  const config = parseConfig({
    WEBDAV_URL: 'https://example.com/dav',
    WEBDAV_USERNAME: 'u',
    WEBDAV_PASSWORD: 'p',
    WEBDAV_PATH: '/Backup/example folder/',
    DATA_DIR: '/data',
  });
  assert.equal(config.baseUrl, 'https://example.com/dav/');
  assert.equal(config.remotePath, 'Backup/example%20folder');
  assert.equal(config.keep, 7);
  assert.equal(config.insecureTls, false);
});
