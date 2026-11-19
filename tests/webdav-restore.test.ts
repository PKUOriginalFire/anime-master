import test from 'node:test';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runRestore } from '../scripts/webdav-backup.mjs';
import type { WebdavBackupConfig } from '../scripts/webdav-backup.mjs';
import { createDavServer } from './webdav-mock.ts';
import type { Entry } from './webdav-mock.ts';

function sha256(data: Buffer) {
  return createHash('sha256').update(data).digest('hex');
}

function makeDatabase(label: string) {
  const dir = mkdtempSync(join(tmpdir(), 'anime-quiz-restore-db-'));
  const path = join(dir, 'quiz.sqlite');
  const database = new DatabaseSync(path);
  database.exec('CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE questions (id TEXT PRIMARY KEY, text TEXT); CREATE TABLE shows (id TEXT PRIMARY KEY);');
  database.prepare('INSERT INTO questions VALUES (?, ?)').run('q1', label);
  database.close();
  const data = readFileSync(path);
  rmSync(dir, { recursive: true, force: true });
  return data;
}

function makeMediaArchive(name: string, content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'anime-quiz-restore-media-'));
  mkdirSync(join(dir, 'media'));
  writeFileSync(join(dir, 'media', name), content);
  const archive = join(dir, 'media.tgz');
  execFileSync('tar', ['-czf', archive, '-C', dir, 'media']);
  const data = readFileSync(archive);
  rmSync(dir, { recursive: true, force: true });
  return data;
}

function makeManifest(id: string, database: Buffer, media?: Buffer, overrides: Record<string, unknown> = {}) {
  const files = [{ name: 'quiz.sqlite', size: database.length, sha256: sha256(database) }];
  if (media) files.push({ name: 'media.tgz', size: media.length, sha256: sha256(media) });
  return Buffer.from(JSON.stringify({ schema: 1, id, createdAt: new Date().toISOString(), label: 'test', files, ...overrides }));
}

function addSnapshot(
  entries: Map<string, Entry>,
  id: string,
  database: Buffer,
  media: Buffer | undefined,
  manifest = makeManifest(id, database, media),
) {
  const base = '/backups/test';
  entries.set('/backups', { directory: true });
  entries.set(base, { directory: true });
  entries.set(`${base}/${id}`, { directory: true });
  entries.set(`${base}/${id}/manifest.json`, { directory: false, data: manifest });
  entries.set(`${base}/${id}/quiz.sqlite`, { directory: false, data: database });
  if (media) entries.set(`${base}/${id}/media.tgz`, { directory: false, data: media });
}

function makeExistingDataDir() {
  const dataDir = mkdtempSync(join(tmpdir(), 'anime-quiz-restore-data-'));
  const database = new DatabaseSync(join(dataDir, 'quiz.sqlite'));
  database.exec("CREATE TABLE questions (id INTEGER PRIMARY KEY, text TEXT); INSERT INTO questions (text) VALUES ('old');");
  database.close();
  writeFileSync(join(dataDir, 'quiz.sqlite-wal'), 'stale-wal');
  mkdirSync(join(dataDir, 'media'));
  writeFileSync(join(dataDir, 'media', 'old.txt'), 'old-media');
  return dataDir;
}

function makeConfig(url: string, dataDir: string): WebdavBackupConfig {
  return {
    dataDir,
    baseUrl: url,
    username: 'tester',
    password: 'secret',
    remotePath: 'backups/test',
    keep: 7,
    insecureTls: false,
    label: 'test',
    timeoutMs: 30000,
  };
}

test('恢复最新快照，并在覆盖前保存现有数据', async t => {
  const dav = await createDavServer();
  t.after(() => dav.close());
  const dataDir = makeExistingDataDir();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  addSnapshot(dav.entries, '20260101T000000Z', makeDatabase('older'), undefined);
  addSnapshot(dav.entries, '20260102T000000Z', makeDatabase('restored'), makeMediaArchive('new.txt', 'new-media'));

  const result = await runRestore(makeConfig(dav.url, dataDir), { confirm: true, logger: () => {} });

  assert.equal(result.id, '20260102T000000Z');
  assert.deepEqual(result.files, ['quiz.sqlite', 'media.tgz']);
  const database = new DatabaseSync(join(dataDir, 'quiz.sqlite'), { readOnly: true });
  assert.equal((database.prepare('SELECT text FROM questions').get() as { text: string }).text, 'restored');
  database.close();
  assert.equal(readFileSync(join(dataDir, 'media', 'new.txt'), 'utf8'), 'new-media');
  assert.ok(!existsSync(join(dataDir, 'media', 'old.txt')));
  assert.ok(!existsSync(join(dataDir, 'quiz.sqlite-wal')));

  const preRestoreDir = result.preRestoreDir;
  assert.ok(preRestoreDir);
  assert.equal(readFileSync(join(preRestoreDir, 'media', 'old.txt'), 'utf8'), 'old-media');
  const oldDatabase = new DatabaseSync(join(preRestoreDir, 'quiz.sqlite'), { readOnly: true });
  assert.equal((oldDatabase.prepare('SELECT text FROM questions').get() as { text: string }).text, 'old');
  oldDatabase.close();

  assert.deepEqual(readdirSync(join(dataDir, 'backups')).filter(name => name.startsWith('.webdav-restore-')), []);
  assert.ok(!existsSync(join(dataDir, 'backups', '.webdav-backup.lock')));
});

test('未确认时拒绝恢复且不改动现有数据', async t => {
  const dataDir = makeExistingDataDir();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  await assert.rejects(runRestore(makeConfig('http://127.0.0.1:1/', dataDir), { logger: () => {} }), /--yes/);

  const database = new DatabaseSync(join(dataDir, 'quiz.sqlite'), { readOnly: true });
  assert.equal((database.prepare('SELECT text FROM questions').get() as { text: string }).text, 'old');
  database.close();
  assert.ok(existsSync(join(dataDir, 'quiz.sqlite-wal')));
  assert.ok(existsSync(join(dataDir, 'media', 'old.txt')));
});

test('sha256 不匹配时保留现有数据', async t => {
  const dav = await createDavServer();
  t.after(() => dav.close());
  const dataDir = makeExistingDataDir();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const remoteDatabase = makeDatabase('tampered');
  const manifest = JSON.parse(makeManifest('20260103T000000Z', remoteDatabase).toString('utf8'));
  manifest.files[0].sha256 = '0'.repeat(64);
  addSnapshot(dav.entries, '20260103T000000Z', remoteDatabase, undefined, Buffer.from(JSON.stringify(manifest)));

  await assert.rejects(runRestore(makeConfig(dav.url, dataDir), { confirm: true, logger: () => {} }), /sha256/);

  const database = new DatabaseSync(join(dataDir, 'quiz.sqlite'), { readOnly: true });
  assert.equal((database.prepare('SELECT text FROM questions').get() as { text: string }).text, 'old');
  database.close();
  assert.ok(existsSync(join(dataDir, 'quiz.sqlite-wal')));
  assert.ok(existsSync(join(dataDir, 'media', 'old.txt')));
  assert.deepEqual(readdirSync(join(dataDir, 'backups')).filter(name => name.startsWith('pre-restore-')), []);
  assert.ok(!existsSync(join(dataDir, 'backups', '.webdav-backup.lock')));
});

test('备份标签不一致时拒绝恢复', async t => {
  const dav = await createDavServer();
  t.after(() => dav.close());
  const dataDir = makeExistingDataDir();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const remoteDatabase = makeDatabase('preview-data');
  addSnapshot(
    dav.entries,
    '20260104T000000Z',
    remoteDatabase,
    undefined,
    makeManifest('20260104T000000Z', remoteDatabase, undefined, { label: 'preview' }),
  );

  await assert.rejects(runRestore(makeConfig(dav.url, dataDir), { confirm: true, logger: () => {} }), /标签/);

  const database = new DatabaseSync(join(dataDir, 'quiz.sqlite'), { readOnly: true });
  assert.equal((database.prepare('SELECT text FROM questions').get() as { text: string }).text, 'old');
  database.close();
});


for(const failure of ['move-media','install-media','rollback-db']){
 test(`恢复失败只逆转本次成功的改动：${failure}`,async t=>{
  const dav=await createDavServer();t.after(()=>dav.close());
  const dir=makeExistingDataDir();t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const databasePath=join(dir,'quiz.sqlite');
  const oldDatabase=readFileSync(databasePath);
  const media=join(dir,'media');
  addSnapshot(dav.entries,'20260101T000000Z',makeDatabase('new'),makeMediaArchive('new.txt','new'));
  const rename=fs.renameSync;
  const mock=t.mock.method(fs,'renameSync',(from:string,to:string)=>{
   if((failure!=='install-media'&&from===media)||(failure==='install-media'&&to===media&&from.includes('/unpacked/'))||
      (failure==='rollback-db'&&to===databasePath&&from.includes('/pre-restore-')))throw new Error('测试搬移失败');
   return rename(from,to);
  });
  syncBuiltinESMExports();
  try {
   await assert.rejects(runRestore(makeConfig(dav.url,dir),{confirm:true,logger:()=>{}}),failure==='rollback-db'?/回滚未完成/:/测试搬移失败/);
  } finally {mock.mock.restore();syncBuiltinESMExports();}
  assert.equal(readFileSync(join(media,'old.txt'),'utf8'),'old-media');
  assert.equal(readFileSync(join(dir,'quiz.sqlite-wal'),'utf8'),'stale-wal');
  const saved=readdirSync(join(dir,'backups')).filter(name=>name.startsWith('pre-restore-'));
  if(failure==='rollback-db'){
   assert.equal(saved.length,1);
   assert.deepEqual(readFileSync(join(dir,'backups',saved[0],'quiz.sqlite')),oldDatabase);
  }else{
   assert.deepEqual(saved,[]);
   assert.deepEqual(readFileSync(databasePath),oldDatabase);
  }
 });
}
