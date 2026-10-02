// lib/native-http.ts
// 原生 HTTP 传输层：Android 上把请求交给 NativeHttp 插件（OkHttp）执行，
// 响应经桥事件回推，JS 侧用 ReadableStream 组装成标准 Response——
// 调用方拿到的和 fetch() 返回值同型，消费代码（reader/.text()/.json()）零改动。
// 浏览器/开发环境下 isNativeHttpAvailable() 为 false，统一回落到 fetch。

import { Capacitor, registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

export type NativeHttpRequestOptions = {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    bodyBase64?: boolean;
    signal?: AbortSignal;
};

/** httpFetch 支持的请求体类型（RequestInit.body 的子集）。 */
export type HttpFetchBody = string | FormData | Blob | ArrayBuffer | ArrayBufferView | URLSearchParams;

class UnsupportedBodyError extends Error {}

function normalizeHeaders(headers?: HeadersInit): Record<string, string> | undefined {
    if (!headers) return undefined;
    if (headers instanceof Headers) {
        const out: Record<string, string> = {};
        headers.forEach((value, key) => { out[key] = value; });
        return out;
    }
    if (Array.isArray(headers)) return Object.fromEntries(headers);
    return headers as Record<string, string>;
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

function blobToBase64Raw(blob: Blob): Promise<string> {
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

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
    if (!headers) return false;
    const target = name.toLowerCase();
    return Object.keys(headers).some(k => k.toLowerCase() === target);
}

async function encodeFormData(fd: FormData): Promise<{ body: string; contentType: string }> {
    const boundary = `----nativehttp${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    for (const [name, value] of fd.entries()) {
        if (typeof value === "string") {
            parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
        } else {
            const file = value as File;
            const filename = (file.name || "blob").replace(/["\r\n]/g, "_");
            parts.push(encoder.encode(
                `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
                `Content-Type: ${file.type || "application/octet-stream"}\r\n\r\n`,
            ));
            parts.push(new Uint8Array(await file.arrayBuffer()));
            parts.push(encoder.encode("\r\n"));
        }
    }
    parts.push(encoder.encode(`--${boundary}--\r\n`));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { merged.set(part, offset); offset += part.length; }
    return { body: bytesToBase64(merged), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** 把 RequestInit.body 编成桥能传的 {string | base64}。不支持的类型抛 UnsupportedBodyError。 */
async function encodeBodyForBridge(
    body: HttpFetchBody | null | undefined,
    headers: Record<string, string> | undefined,
): Promise<{ body?: string; bodyBase64?: boolean; headers?: Record<string, string> }> {
    if (body == null) return { headers };
    if (typeof body === "string") return { body, headers };
    if (body instanceof URLSearchParams) {
        const next = { ...(headers ?? {}) };
        if (!hasHeader(next, "Content-Type")) next["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
        return { body: body.toString(), headers: next };
    }
    if (body instanceof FormData) {
        const { body: encoded, contentType } = await encodeFormData(body);
        const next = { ...(headers ?? {}) };
        // multipart boundary 必须是我们生成的这个——无条件覆盖
        for (const k of Object.keys(next)) if (k.toLowerCase() === "content-type") delete next[k];
        next["Content-Type"] = contentType;
        return { body: encoded, bodyBase64: true, headers: next };
    }
    if (body instanceof Blob) {
        const next = { ...(headers ?? {}) };
        if (body.type && !hasHeader(next, "Content-Type")) next["Content-Type"] = body.type;
        return { body: await blobToBase64Raw(body), bodyBase64: true, headers: next };
    }
    if (body instanceof ArrayBuffer) {
        return { body: bytesToBase64(new Uint8Array(body)), bodyBase64: true, headers };
    }
    if (ArrayBuffer.isView(body)) {
        return { body: bytesToBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)), bodyBase64: true, headers };
    }
    throw new UnsupportedBodyError("body type not supported by native http");
}

type HeadEvent = { requestId: string; status: number; headers?: Record<string, string> };
type ChunkEvent = { requestId: string; data: string };
type DoneEvent = { requestId: string };
type ErrorEvent = { requestId: string; status?: number; error?: string };

type NativeHttpPluginDef = {
    start(options: {
        requestId: string;
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        bodyBase64?: boolean;
    }): Promise<void>;
    cancel(options: { requestId: string }): Promise<void>;
    addListener(event: "nativeHttpHead", cb: (e: HeadEvent) => void): Promise<PluginListenerHandle>;
    addListener(event: "nativeHttpChunk", cb: (e: ChunkEvent) => void): Promise<PluginListenerHandle>;
    addListener(event: "nativeHttpDone", cb: (e: DoneEvent) => void): Promise<PluginListenerHandle>;
    addListener(event: "nativeHttpError", cb: (e: ErrorEvent) => void): Promise<PluginListenerHandle>;
};

type PendingRequest = {
    requestId: string;
    stream: ReadableStream<Uint8Array>;
    controller: ReadableStreamDefaultController<Uint8Array> | null;
    resolve: ((response: Response) => void) | null;
    reject: ((err: unknown) => void) | null;
    /** promise 已 resolve/reject（响应头已交付消费方） */
    settled: boolean;
    /** 整条请求已收尾（done/error/cancel），后续事件忽略 */
    finished: boolean;
    signal: AbortSignal | null;
    onAbort: (() => void) | null;
};

// 仅 Android 有原生实现；iOS/Web 走 fetch 兜底
const plugin: NativeHttpPluginDef | null = Capacitor.getPlatform() === "android"
    ? registerPlugin<NativeHttpPluginDef>("NativeHttp")
    : null;

const pending = new Map<string, PendingRequest>();
let seq = 0;
let listenersReady: Promise<void> | null = null;

export function isNativeHttpAvailable(): boolean {
    return plugin !== null;
}

function ensureListeners(): Promise<void> {
    if (listenersReady) return listenersReady;
    if (!plugin) return Promise.resolve();
    const p = plugin;
    listenersReady = Promise.all([
        p.addListener("nativeHttpHead", onHead),
        p.addListener("nativeHttpChunk", onChunk),
        p.addListener("nativeHttpDone", onDone),
        p.addListener("nativeHttpError", onError),
    ]).then(() => undefined);
    return listenersReady;
}

function abortError(): DOMException {
    return new DOMException("The operation was aborted.", "AbortError");
}

function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function cleanup(entry: PendingRequest): void {
    entry.finished = true;
    pending.delete(entry.requestId);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
    entry.signal = null;
    entry.onAbort = null;
    entry.resolve = null;
    entry.reject = null;
}

function onHead(e: HeadEvent): void {
    const entry = pending.get(e.requestId);
    if (!entry || entry.finished || !entry.resolve || !entry.reject) return;
    entry.settled = true;
    const status = typeof e.status === "number" ? e.status : 0;
    try {
        if (status < 200 || status > 599) throw new Error(`Invalid status ${status}`);
        // 204/304 按规范不能有 body：流端多余字节丢弃，直接给空 body
        const noBody = status === 204 || status === 304;
        const response = new Response(noBody ? null : entry.stream, {
            status,
            headers: e.headers,
        });
        entry.resolve(response);
    } catch (err) {
        entry.reject(err);
    }
    cleanupResolve(entry);
}

function cleanupResolve(entry: PendingRequest): void {
    entry.resolve = null;
    entry.reject = null;
}

function onChunk(e: ChunkEvent): void {
    const entry = pending.get(e.requestId);
    if (!entry || entry.finished || !entry.controller) return;
    try {
        entry.controller.enqueue(b64ToBytes(e.data));
    } catch { /* 流已被消费方取消，剩余块丢弃 */ }
}

function onDone(e: DoneEvent): void {
    const entry = pending.get(e.requestId);
    if (!entry || entry.finished) return;
    try { entry.controller?.close(); } catch { /* ignore */ }
    cleanup(entry);
}

function onError(e: ErrorEvent): void {
    const entry = pending.get(e.requestId);
    if (!entry || entry.finished) return;
    const err = new Error(e.error || `Native HTTP error${e.status ? ` ${e.status}` : ""}`);
    if (!entry.settled && entry.reject) {
        entry.reject(err);
    } else {
        try { entry.controller?.error(err); } catch { /* ignore */ }
    }
    cleanup(entry);
}

/**
 * 经原生 OkHttp 发起请求。返回标准 Response：
 * head 事件到达时 resolve（与 fetch 语义一致），body 走 ReadableStream。
 * signal abort → 原生 cancel + AbortError。
 */
export async function fetchViaNativeHttp(options: NativeHttpRequestOptions): Promise<Response> {
    if (!plugin) throw new Error("NativeHttp not available");
    const signal = options.signal ?? null;
    if (signal?.aborted) throw abortError();

    const requestId = `nh-${Date.now().toString(36)}-${++seq}`;
    const entry: PendingRequest = {
        requestId,
        stream: null as unknown as ReadableStream<Uint8Array>,
        controller: null,
        resolve: null,
        reject: null,
        settled: false,
        finished: false,
        signal,
        onAbort: null,
    };
    entry.stream = new ReadableStream<Uint8Array>({
        start(controller) {
            entry.controller = controller;
        },
        cancel() {
            void plugin?.cancel({ requestId });
            cleanup(entry);
        },
    });
    pending.set(requestId, entry);

    const headPromise = new Promise<Response>((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
    });

    if (signal) {
        entry.onAbort = () => {
            void plugin.cancel({ requestId });
            if (!entry.settled && entry.reject) {
                entry.reject(abortError());
            } else {
                try { entry.controller?.error(abortError()); } catch { /* ignore */ }
            }
            cleanup(entry);
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
    }

    await ensureListeners();
    try {
        await plugin.start({
            requestId,
            url: options.url,
            method: options.method ?? "POST",
            headers: options.headers,
            body: options.body,
            bodyBase64: options.bodyBase64,
        });
    } catch (err) {
        cleanup(entry);
        throw err;
    }
    // start 在途期间 abort 已触发：原生侧 cancel 可能先于注册到达，再补一刀
    if (signal?.aborted) void plugin.cancel({ requestId });

    // headPromise 的拒绝由消费方 await 承接；这里挂个吞错防止 unhandled rejection
    // 出现在 abort/error 恰好落在 resolve 边界时的窗口期
    headPromise.catch(() => undefined);
    return headPromise;
}

/**
 * 通用出口：Android 走 OkHttp（无 CORS 限制、socket 不受 WebView 节流），
 * 浏览器/开发环境回落 fetch。签名与 fetch 对齐（RequestInit 子集）：
 * headers 支持 HeadersInit；body 支持 string/FormData/Blob/ArrayBuffer/View/URLSearchParams。
 *
 * 回落规则：
 *  - 非 http(s) URL（data:/blob:/file: 等）或不可编码的 body → 直接走 fetch；
 *  - 原生传输层失败 → 幂等请求（GET/HEAD）回落 fetch 一次；
 *    POST 等请求不重试——失败时服务端可能已收到，重试会重复扣费/重复执行；
 *  - AbortError 永不重试。
 */
export async function httpFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = normalizeHeaders(init.headers ?? undefined);
    const body = init.body as HttpFetchBody | null | undefined;
    const method = (init.method ?? (body ? "POST" : "GET")).toUpperCase();

    const webFetch = () => fetch(url, init);

    if (!plugin || !/^https?:\/\//i.test(url)) return webFetch();

    let encoded: { body?: string; bodyBase64?: boolean; headers?: Record<string, string> };
    try {
        encoded = await encodeBodyForBridge(body, headers);
    } catch (err) {
        // body 类型超出桥能力（ReadableStream 等）——请求还没发出，安全回落
        if (err instanceof UnsupportedBodyError) return webFetch();
        throw err;
    }

    try {
        return await fetchViaNativeHttp({
            url,
            method,
            headers: encoded.headers,
            body: encoded.body,
            bodyBase64: encoded.bodyBase64,
            signal: init.signal ?? undefined,
        });
    } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        if (init.signal?.aborted) throw err;
        if (method === "GET" || method === "HEAD") return webFetch();
        throw err;
    }
}
