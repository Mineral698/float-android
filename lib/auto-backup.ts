// lib/auto-backup.ts
// 自动本地备份:每 6 小时把全量备份 zip 静默写到系统「文档」目录,保留最近 3 份。
//
// 背景:全部数据都在 WebView IndexedDB 里,没开持久化保护时系统会整库回收;
// 卸载重装更是直接清空。公共 Documents 目录不受应用数据清理/卸载影响,
// 是唯一无需 root 的容灾位置。
//
// 关键约束:
// - 仅原生端:网页端没有静默落盘能力(下载要用户手势)
// - 空库不备份:库被清空时绝不能拿空快照把最后一份好备份轮换掉
// - 复用 backup.ts 的流式打包 + download-utils 的分块原生写入,不重复造轮子

import { Capacitor } from "@capacitor/core";
import { hydrateKvDb, isKvHydrated, kvGet, kvSet } from "./kv-db";
import { loadCharacters } from "./character-storage";
import { hasPublicDocumentsAccess } from "./storage-access";

const PERMISSION_BLOCKED_KEY = "ai_phone_autobackup_perm_blocked";

const LAST_RUN_KEY = "ai_phone_autobackup_last_at";
export const AUTOBACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TICK_MS = 30 * 60 * 1000;
const STARTUP_DELAY_MS = 30_000;
const RETAIN = 3;
const FILE_PREFIX = "ai-phone-autobackup-";

export function getLastAutoBackupAt(): string | null {
  return kvGet(LAST_RUN_KEY);
}

/** 自动备份曾因缺「所有文件访问」被跳过（数据管理页据此显示权限警告）。 */
export function isAutoBackupPermissionBlocked(): boolean {
  return kvGet(PERMISSION_BLOCKED_KEY) === "1";
}

/** 旧备份轮换:Documents 下按文件名(内嵌 ISO 时间戳)排序,删最老的。 */
async function rotateOldBackups(): Promise<void> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  try {
    const res = await Filesystem.readdir({ path: "", directory: Directory.Documents });
    const names = res.files
      .map((f) => (typeof f === "string" ? f : f.name))
      .filter((n): n is string => typeof n === "string" && n.startsWith(FILE_PREFIX) && n.endsWith(".zip"))
      .sort();
    const excess = names.length - RETAIN;
    for (let i = 0; i < excess; i++) {
      await Filesystem.deleteFile({ path: names[i], directory: Directory.Documents }).catch(() => {});
    }
  } catch {
    // 列目录失败不阻塞备份本身
  }
}

let _running = false;

export async function maybeRunAutoBackup(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (_running) return;
  _running = true;
  try {
    await hydrateKvDb();
    if (!isKvHydrated()) return;

    const last = Date.parse(kvGet(LAST_RUN_KEY) ?? "") || 0;
    if (Date.now() - last < AUTOBACKUP_INTERVAL_MS) return;

    // 没有「所有文件访问」权限时写公共 Documents 必 EACCES——跳过这轮并
    // 记旗标，数据管理页会显示「需要权限」提示；打包很贵，别白跑。
    if (!(await hasPublicDocumentsAccess())) {
      kvSet(PERMISSION_BLOCKED_KEY, "1");
      return;
    }
    if (kvGet(PERMISSION_BLOCKED_KEY)) kvSet(PERMISSION_BLOCKED_KEY, "0");

    // 空库保护:没有角色 = 全新安装或数据刚被清空,此时备份既没意义
    // 又会把好备份轮换掉。loadCharacters 走 kv 缓存,已水合才可信。
    if (loadCharacters().length === 0) return;

    const { createBackupBlob } = await import("./data-management/backup");
    const { blob, manifest } = await createBackupBlob();
    if (manifest.totalRecords === 0) return;

    const filename = `${FILE_PREFIX}${manifest.createdAt.replace(/[:.]/g, "-").slice(0, 19)}.zip`;
    const { downloadFile } = await import("./download-utils");
    await downloadFile(blob, filename);

    kvSet(LAST_RUN_KEY, manifest.createdAt);
    await rotateOldBackups();
  } catch (err) {
    console.warn("[auto-backup] failed:", err);
  } finally {
    _running = false;
  }
}

let _started = false;

/** App 启动时调用一次。启动后 30s 首检(避开开机资源争抢),运行中每 30min 轮询。 */
export function startAutoBackupLoop(): void {
  if (_started || typeof window === "undefined") return;
  _started = true;
  if (!Capacitor.isNativePlatform()) return;
  window.setTimeout(() => void maybeRunAutoBackup(), STARTUP_DELAY_MS);
  window.setInterval(() => void maybeRunAutoBackup(), TICK_MS);
}
