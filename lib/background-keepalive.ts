// lib/background-keepalive.ts
// 后台常驻保活包装层（双平台契约）——与 keep-alive.ts（单次生成保活）互补：
// 那个按引用计数只为"一次生成"短暂持锁，这个在用户开启后让进程+引擎
// 整个后台存活（前台服务 + 闹钟心跳），是"AI 主动消息后台弹窗"的基座。
//
// - Android：BackgroundKeepAlive 原生插件（前台服务 + 闹钟心跳 + 存活 ping）。
// - iOS / 网页版：不支持——不启动服务、不报错，调用方按 supported=false 降级展示。
//
// 存活检测约定：JS 引擎（follow-up-service 轮询）每隔 ~30s 调 ping()；
// 原生服务侧发现 ping 超时（WebView 已死但进程还在，例如被划掉）时
// 发"点按恢复"全屏通知，由用户把 App 拉回前台重建 WebView。

import { Capacitor, registerPlugin } from "@capacitor/core";
import { loadChatAppSettings } from "./chat-storage";

export type KeepAliveMode = "power_saving" | "realtime";

interface BackgroundKeepAlivePlugin {
    /** 启动前台服务并按模式安排心跳闹钟（实时模式不依赖闹钟） */
    start(options: { mode: KeepAliveMode; heartbeatMinutes: number }): Promise<{ running: boolean }>;
    /** 停止前台服务并注销心跳闹钟 */
    stop(): Promise<{ running: boolean }>;
    /** 引擎存活 ping：由 JS 轮询周期性调用，服务侧据此判断 WebView 是否还活着 */
    ping(): Promise<void>;
    status(): Promise<{ running: boolean }>;
    isIgnoringBatteryOptimizations(): Promise<{ ignoring: boolean }>;
    requestIgnoreBatteryOptimizations(): Promise<{ ignoring: boolean }>;
}

const plugin: BackgroundKeepAlivePlugin | null = Capacitor.getPlatform() === "android"
    ? registerPlugin<BackgroundKeepAlivePlugin>("BackgroundKeepAlive")
    : null;

export function isKeepAlivePlatform(): boolean {
    return Capacitor.getPlatform() === "android";
}

/** 引擎存活 ping：fire-and-forget，未开启保活/非 Android 时空转 */
export function pingBackgroundKeepAlive(): void {
    if (!plugin) return;
    try {
        void plugin.ping().catch(() => { /* 服务未运行等场景静默 */ });
    } catch { /* 忽略 */ }
}

/**
 * 按设置里的开关/模式应用保活状态。
 * App 启动和设置页改动时调用；未开启时确保服务与闹钟都已停止。
 */
export async function applyBackgroundKeepAlive(): Promise<{ running: boolean }> {
    if (!plugin) return { running: false };
    const settings = loadChatAppSettings();
    if (settings.keepAliveEnabled !== true) {
        try { await plugin.stop(); } catch { /* 静默 */ }
        return { running: false };
    }
    const mode: KeepAliveMode = settings.keepAliveMode === "realtime" ? "realtime" : "power_saving";
    const heartbeatMinutes = Math.min(15, Math.max(1, Math.round(settings.keepAliveHeartbeatMinutes ?? 5)));
    try {
        const result = await plugin.start({ mode, heartbeatMinutes });
        return { running: result.running };
    } catch (error) {
        console.warn("[BackgroundKeepAlive] start failed:", error);
        return { running: false };
    }
}

export async function getBackgroundKeepAliveRunning(): Promise<boolean> {
    if (!plugin) return false;
    try {
        return (await plugin.status()).running;
    } catch {
        return false;
    }
}

export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
    if (!plugin) return true;
    try {
        return (await plugin.isIgnoringBatteryOptimizations()).ignoring;
    } catch {
        return true;
    }
}

export async function requestIgnoreBatteryOptimizations(): Promise<boolean> {
    if (!plugin) return false;
    try {
        return (await plugin.requestIgnoreBatteryOptimizations()).ignoring;
    } catch {
        return false;
    }
}
