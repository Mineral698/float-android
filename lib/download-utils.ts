import { Capacitor } from "@capacitor/core";
import { httpFetch } from "./native-http";
import { hasPublicDocumentsAccess, requestDocumentsAccess } from "./storage-access";

export type DownloadFileOptions = {
    disableNativeShare?: boolean;
    nativeShareOnly?: boolean;
};

export function isNativeApp(): boolean {
    return Capacitor.isNativePlatform();
}

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result ?? "");
            resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
        };
        reader.onerror = () => reject(reader.error ?? new Error("读取文件内容失败"));
        reader.readAsDataURL(blob);
    });
}

/**
 * 原生端 a[download] 对 blob: URL 静默无效——必须经 Filesystem 插件落盘到系统下载目录。
 *
 * 注意必须分块：整文件 base64 一次过桥会把 JS 堆、Capacitor 桥接 JSON 解析、
 * 原生 Base64.decode 三重放大同时打满（几十 MB 的备份在移动端必崩——进程被
 * 系统杀掉，表现是闪退且无报错）。分块后每次桥接只带 ~5MB base64，峰值恒定。
 */
async function saveFileNative(blob: Blob, filename: string): Promise<void> {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    const CHUNK_BYTES = 4 * 1024 * 1024; // 4MB 二进制 ≈ 5.3MB base64
    // Android 上 Documents 映射到公共 Documents 文件夹（文件管理器可见）。
    // 插件实际是裸路径写入：API 30+ 需要 MANAGE_EXTERNAL_STORAGE（「所有文件
    // 访问」），它是设置页授权不是运行时弹窗——缺权限先拉起设置页再报引导文案，
    // 免得只丢一个 EACCES 让用户摸不着头脑。
    if (!(await hasPublicDocumentsAccess())) {
        await requestDocumentsAccess();
        throw new Error("需要「所有文件访问」权限才能存到文档目录——已打开系统设置页，开启后回来再试一次即可（只需设置一次）");
    }
    try { await Filesystem.requestPermissions(); } catch { /* 老设备兜底 */ }

    let offset = 0;
    let wroteAnything = false;
    try {
        do {
            const chunk = blob.slice(offset, offset + CHUNK_BYTES);
            const base64 = await blobToBase64(chunk);
            if (!wroteAnything) {
                // 首块用 writeFile（截断同名残件）；后续块 appendFile
                await Filesystem.writeFile({ path: filename, data: base64, directory: Directory.Documents, recursive: true });
                wroteAnything = true;
            } else {
                await Filesystem.appendFile({ path: filename, data: base64, directory: Directory.Documents });
            }
            offset += CHUNK_BYTES;
        } while (offset < blob.size);
    } catch (err) {
        // 中途失败会留下半个 zip——尽力清掉，避免用户把残件当备份
        if (wroteAnything) {
            try { await Filesystem.deleteFile({ path: filename, directory: Directory.Documents }); } catch { /* 清不掉就算了 */ }
        }
        throw err;
    }
}

export function isAndroidBrowser(): boolean {
    return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

export function isIOSBrowser(): boolean {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    return /iPad|iPhone|iPod/i.test(ua) || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export async function downloadFile(blob: Blob, filename: string, options: DownloadFileOptions = {}): Promise<void> {
    const url = URL.createObjectURL(blob);
    const anchorDownload = () => {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
    };

    const shouldUseNativeShare = options.nativeShareOnly || (!options.disableNativeShare && isIOSBrowser());
    if (shouldUseNativeShare) {
        const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
        const canNativeShare = typeof navigator !== "undefined"
            && typeof navigator.share === "function"
            && typeof navigator.canShare === "function"
            && navigator.canShare({ files: [file] });
        if (canNativeShare) {
            try {
                await navigator.share({ files: [file] });
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                return;
            } catch (err) {
                // User explicitly dismissed the share sheet → respect it, don't force a download.
                if (err instanceof DOMException && err.name === "AbortError") {
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                    return;
                }
                // Any other failure (webview without real file-share support, lost user
                // activation, etc.) is surfaced to the caller on iOS instead of opening
                // the blob URL, which can navigate away from the app.
            }
        }
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        throw new Error("当前浏览器没有成功打开系统分享，请在 Safari 中重试，或导出轻量备份后再试。");
    }

    if (isNativeApp()) {
        // 原生端没有可用的锚点兜底（blob: 下载静默无效）——失败必须抛出，
        // 让上层提示真实错误，而不是"显示已导出但文件根本没落盘"。
        try {
            await saveFileNative(blob, filename);
        } finally {
            URL.revokeObjectURL(url);
        }
        return;
    }
    anchorDownload();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 打开外部链接。window.open 在 WebView 里因不支持多窗口而静默返回 null；
 * target=_blank 的锚点点击会走 WebViewClient.shouldOverrideUrlLoading，
 * Capacitor 对非本地 origin 自动拉起系统浏览器。
 */
export function openExternalUrl(url: string): void {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
}

export async function downloadUrl(url: string, filename: string): Promise<void> {
    let blob: Blob | null = null;

    try {
        const res = await httpFetch(url);
        if (res.ok) blob = await res.blob();
    } catch { /* CORS or network error — try proxy */ }

    if (blob) {
        await downloadFile(blob, filename);
    } else {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
}
