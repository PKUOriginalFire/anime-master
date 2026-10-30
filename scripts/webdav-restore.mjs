#!/usr/bin/env node
import { parseConfig, runRestore } from './webdav-backup.mjs';

const PREFIX = '[webdav-restore]';

async function main() {
  const config = parseConfig();
  const confirm = process.argv.includes('--yes') || /^(1|true|yes)$/i.test(String(process.env.RESTORE_CONFIRM || ''));
  const snapshot = String(process.env.WEBDAV_RESTORE_SNAPSHOT || '').trim() || undefined;
  const result = await runRestore(config, { confirm, snapshot });
  console.log(`${PREFIX} 已恢复 ${result.id}：${result.files.join('、')}`);
  if (result.preRestoreDir) console.log(`${PREFIX} 恢复前数据：${result.preRestoreDir}`);
}

main().catch(error => {
  console.error(`${PREFIX} 失败：${error.message}`);
  process.exitCode = 1;
});
