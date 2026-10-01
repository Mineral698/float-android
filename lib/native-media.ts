// lib/native-media.ts
// 原生媒体文件存储的 JS 侧封装：Android 上媒体字节落在应用文件目录，
// media-store:// 协议不变，调用方无感知。浏览器环境 isNativeMediaAvailable()
// 恒为 false，media-cache-storage 自动回落 IndexedDB。

import { Capacitor, registerPlugin } from "@capacitor/core";

type NativeMediaPluginDef = {
    store(options: { id: string; base64: string; mime?: string; dedupe?: boolean }): Promise<{ id: string; bytes: number; existed?: boolean }>;
    readBase64(options: { id: string }): Promise<{ data: string }>;
    resolve(options: { id: string }): Promise<{ path: string; bytes: number; thumbPath?: string }>;
    delete(options: { id: string }): Promise<void>;
    list(): Promise<{ entries: { id: string; ext: string; bytes: number; modified: number }[] }>;
    clear(): Promise<{ removed: number }>;
};

const plugin: NativeMediaPluginDef | null = Capacitor.isNativePlatform()
    ? registerPlugin<NativeMediaPluginDef>("NativeMedia")
    : null;

export function isNativeMediaAvailable(): boolean {
    return plugin !== null;
}

// ext → mime/类别（与插件侧 extForMime 互逆，bin 兜底）
const EXT_MIME: Record<string, { mime: string; category: "image" | "audio" | "video" | "file" }> = {
    png: { mime: "image/png", category: "image" },
    jpg: { mime: "image/jpeg", category: "image" },
    jpeg: { mime: "image/jpeg", category: "image" },
    gif: { mime: "image/gif", category: "image" },
    webp: { mime: "image/webp", category: "image" },
    svg: { mime: "image/svg+xml", category: "image" },
    mp3: { mime: "audio/mpeg", category: "audio" },
    ogg: { mime: "audio/ogg", category: "audio" },
    flac: { mime: "audio/flac", category: "audio" },
    wav: { mime: "audio/wav", category: "audio" },
    m4a: { mime: "audio/m4a", category: "audio" },
    mp4: { mime: "video/mp4", category: "video" },
    webm: { mime: "video/webm", category: "video" },
    pdf: { mime: "application/pdf", category: "file" },
};

export type NativeMediaEntry = {
    id: string;
    mime: string;
    category: "image" | "audio" | "video" | "file";
    bytes: number;
    createdAt: number;
    /** resolve 过的显示 URL 缓存：列表滚动反复渲染时不再每次过桥 */
    displayUrl?: string;
};

// 原生条目索引：list() 惰性建一次，store/delete/clear 就地维护。
// 是"这条 media-store:// ref 在原生还是 IDB"的唯一判据，mime/类别也走它。
let nativeIndex: Map<string, NativeMediaEntry> | null = null;
let nativeIndexLoading: Promise<Map<string, NativeMediaEntry>> | null = null;

function toEntry(e: { id: string; ext: string; bytes: number; modified: number }): NativeMediaEntry {
    const info = EXT_MIME[e.ext] ?? { mime: "application/octet-stream", category: "file" as const };
    return { id: e.id, mime: info.mime, category: info.category, bytes: e.bytes, createdAt: e.modified };
}

async function ensureNativeIndex(): Promise<Map<string, NativeMediaEntry>> {
    if (nativeIndex) return nativeIndex;
    if (!plugin) return new Map();
    if (!nativeIndexLoading) {
        const p = plugin;
        nativeIndexLoading = p.list()
            .then(({ entries }) => {
                nativeIndex = new Map(entries.map(e => [e.id, toEntry(e)]));
                return nativeIndex;
            })
            .catch(() => {
                nativeIndexLoading = null;
                return new Map<string, NativeMediaEntry>();
            });
    }
    return nativeIndexLoading;
}

function categoryOf(mime: string): NativeMediaEntry["category"] {
    return mime.startsWith("image/") ? "image"
        : mime.startsWith("audio/") ? "audio"
        : mime.startsWith("video/") ? "video" : "file";
}

/** ref/纯 id 是否落在原生文件存储。 */
export async function isNativeMediaId(id: string): Promise<boolean> {
    return (await ensureNativeIndex()).has(id);
}

export async function getNativeMediaEntry(id: string): Promise<NativeMediaEntry | null> {
    return (await ensureNativeIndex()).get(id) ?? null;
}

export async function nativeMediaStoreBase64(id: string, base64: string, mime?: string, category?: NativeMediaEntry["category"]): Promise<void> {
    if (!plugin) throw new Error("NativeMedia not available");
    const { bytes } = await plugin.store({ id, base64, mime });
    const resolvedMime = mime ?? "application/octet-stream";
    (await ensureNativeIndex()).set(id, {
        id, mime: resolvedMime, category: category ?? categoryOf(resolvedMime), bytes, createdAt: Date.now(),
    });
}

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("read failed"));
        reader.onload = () => {
            const url = String(reader.result ?? "");
            const comma = url.indexOf(",");
            resolve(comma >= 0 ? url.slice(comma + 1) : url);
        };
        reader.readAsDataURL(blob);
    });
}

export async function nativeMediaStoreBlob(id: string, blob: Blob, mime?: string, category?: NativeMediaEntry["category"]): Promise<void> {
    await nativeMediaStoreBase64(id, await blobToBase64(blob), mime ?? blob.type, category);
}

/** 内容寻址写入：原生侧 sha256 决定 id，同字节命中既有文件返回 existed=true。
 *  返回真实 id（调用方据此拼 media-store:// ref）。 */
export async function nativeMediaStoreDedupeBase64(
    base64: string,
    mime?: string,
    category?: NativeMediaEntry["category"],
): Promise<{ id: string; bytes: number }> {
    if (!plugin) throw new Error("NativeMedia not available");
    const { id, bytes } = await plugin.store({ id: "", base64, mime, dedupe: true });
    const resolvedMime = mime ?? "application/octet-stream";
    (await ensureNativeIndex()).set(id, {
        id, mime: resolvedMime, category: category ?? categoryOf(resolvedMime), bytes, createdAt: Date.now(),
    });
    return { id, bytes };
}

export async function nativeMediaStoreDedupeBlob(
    blob: Blob,
    mime?: string,
    category?: NativeMediaEntry["category"],
): Promise<{ id: string; bytes: number }> {
    return nativeMediaStoreDedupeBase64(await blobToBase64(blob), mime ?? blob.type, category);
}

/** 显示用 URL：_capacitor_file_ 让 WebView 直接读盘；大图自动吃到缩略图。 */
export async function nativeMediaDisplayUrl(id: string): Promise<string | null> {
    if (!plugin) return null;
    const cached = (await ensureNativeIndex()).get(id);
    if (cached?.displayUrl) return cached.displayUrl;
    try {
        const { path, thumbPath } = await plugin.resolve({ id });
        const url = Capacitor.convertFileSrc(`file://${thumbPath ?? path}`);
        if (cached) cached.displayUrl = url;
        return url;
    } catch {
        return null;
    }
}

/** 完整字节（vision 载荷/导出用）。 */
export async function nativeMediaReadBlob(id: string, mime: string): Promise<Blob | null> {
    if (!plugin) return null;
    try {
        const { data } = await plugin.readBase64({ id });
        const bin = atob(data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    } catch {
        return null;
    }
}

export async function nativeMediaDelete(id: string): Promise<void> {
    if (!plugin) return;
    try { await plugin.delete({ id }); } catch { /* 文件可能已被外部清理 */ }
    nativeIndex?.delete(id);
}

/** 全量条目（字节数来自 stat，不把内容读进 JS），同时刷新索引。 */
export async function nativeMediaList(): Promise<NativeMediaEntry[]> {
    if (!plugin) return [];
    try {
        const { entries } = await plugin.list();
        const mapped = entries.map(toEntry);
        nativeIndex = new Map(mapped.map(e => [e.id, e]));
        return mapped;
    } catch {
        return [];
    }
}

export async function nativeMediaClear(): Promise<number> {
    if (!plugin) return 0;
    try {
        const { removed } = await plugin.clear();
        nativeIndex?.clear();
        return removed;
    } catch {
        return 0;
    }
}
