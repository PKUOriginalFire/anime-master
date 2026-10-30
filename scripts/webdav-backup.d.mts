export interface WebdavBackupConfig {
  dataDir: string;
  baseUrl: string;
  username: string;
  password: string;
  remotePath: string;
  keep: number;
  insecureTls: boolean;
  label: string;
  timeoutMs: number;
}

export interface WebdavBackupResult {
  skipped?: boolean;
  reason?: string;
  id?: string;
  files?: string[];
  pruned?: number;
}

export interface WebdavRestoreResult {
  id: string;
  files: string[];
  preRestoreDir: string | null;
}

export function normalizeRemotePath(value: string): string;
export function parseConfig(env?: NodeJS.ProcessEnv): WebdavBackupConfig;
export function runBackup(
  config: WebdavBackupConfig,
  options?: { logger?: (message: string) => void; now?: Date },
): Promise<WebdavBackupResult>;
export function runRestore(
  config: WebdavBackupConfig,
  options?: { confirm?: boolean; snapshot?: string; logger?: (message: string) => void; now?: Date },
): Promise<WebdavRestoreResult>;
