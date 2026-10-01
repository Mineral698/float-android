// lib/keep-alive.ts
// Android 后台保活：长时间生成请求（查手机/栖所/生图/聊天回复）进行中时，
// 拉起一个前台服务持有 PARTIAL_WAKE_LOCK，防止退到桌面/锁屏后系统挂起
// 进程或掐断网络。Capacitor 的 WebView 默认 KeepRunning=true，退后台 JS
// 不会被暂停——缺的只是进程优先级，这正是前台服务补的。
//
// JS 侧按引用计数管理：多个并发请求共享同一个服务；release 后留 1.2s
// 宽限期，避免连续请求（如栖所逐件生成）之间反复启停服务。
// 浏览器环境下整个模块是 no-op。

import { Capacitor, registerPlugin } from "@capacitor/core";

type GenerationKeepAlivePlugin = {
    start(options?: { label?: string }): Promise<void>;
    stop(): Promise<void>;
};

const plugin: GenerationKeepAlivePlugin | null = Capacitor.isNativePlatform()
    ? registerPlugin<GenerationKeepAlivePlugin>("GenerationKeepAlive")
    : null;

let activeCount = 0;
// start/stop 调用串行化，避免并发 acquire/release 造成原生侧状态错乱
let chain: Promise<void> = Promise.resolve();

const RELEASE_GRACE_MS = 1200;

function enqueue(task: () => Promise<void>): void {
    chain = chain.then(task).catch(() => undefined);
}

/**
 * 为一段耗时任务持有后台保活。返回 release 函数（幂等，可放心在 finally 里调）。
 * 浏览器端返回空函数。
 */
export function acquireGenerationKeepAlive(label?: string): () => void {
    if (!plugin) return () => { };
    const native = plugin;
    activeCount += 1;
    if (activeCount === 1) {
        enqueue(async () => {
            // Android 12+ 禁止后台启动前台服务：此刻 App 通常还在前台，立即起。
            // 若已被系统禁止（极端：用户秒切后台），静默降级为不保活。
            await native.start({ label }).catch((err) => {
                console.warn("[KeepAlive] start failed:", err);
            });
        });
    }

    let released = false;
    return () => {
        if (released) return;
        released = true;
        activeCount = Math.max(0, activeCount - 1);
        if (activeCount === 0) {
            enqueue(async () => {
                await new Promise<void>((resolve) => setTimeout(resolve, RELEASE_GRACE_MS));
                if (activeCount !== 0) return;
                await native.stop().catch((err) => {
                    console.warn("[KeepAlive] stop failed:", err);
                });
            });
        }
    };
}

/** 包住一个 promise：任务期间持有保活，结束自动释放。 */
export async function withGenerationKeepAlive<T>(label: string, task: () => Promise<T>): Promise<T> {
    const release = acquireGenerationKeepAlive(label);
    try {
        return await task();
    } finally {
        release();
    }
}
