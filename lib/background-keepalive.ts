// lib/background-keepalive.ts
// Android 主动消息常驻保活包装层。
//
// 开启后拉起 BackgroundKeepAlive 前台服务（specialUse）+ 心跳闹钟，
// 抬高进程优先级，让 follow-up 引擎在退后台后仍能生成并走原生通知。
// JS 每 30s ping 一次；服务侧若 5 分钟无 ping 则弹「点按恢复」。
//
// iOS / 网页：全降级为 no-op（Apple 不允许假保活；网页靠标签页存活）。

import { Capacitor, registerPlugin } from "@capacitor/core";

import {
    loadChatAppSettings,
    saveChatAppSettings,
    type KeepAliveMode,
} from "./chat-storage";

export type BackgroundKeepAliveStatus = {
    enabled: boolean;
    mode: KeepAliveMode;
    heartbeatMinutes: number;
    lastPingAt: number;
    batteryOptIgnored: boolean;
};

type BackgroundKeepAlivePluginDef = {
    start(options: { mode: string; heartbeatMinutes: number }): Promise<BackgroundKeepAliveStatus>;
    stop(): Promise<BackgroundKeepAliveStatus>;
    ping(): Promise<void>;
    status(): Promise<BackgroundKeepAliveStatus>;
    isIgnoringBatteryOptimizations(): Promise<{ ignoring: boolean }>;
    requestIgnoreBatteryOptimizations(): Promise<{ ignoring: boolean }>;
};

const plugin: BackgroundKeepAlivePluginDef | null = Capacitor.getPlatform() === "android"
    ? registerPlugin<BackgroundKeepAlivePluginDef>("BackgroundKeepAlive")
    : null;

let pingStop: (() => void) | null = null;
let lastKnownStatus: BackgroundKeepAliveStatus | null = null;

const IDLE_STATUS: BackgroundKeepAliveStatus = {
    enabled: false,
    mode: "power_save",
    heartbeatMinutes: 5,
    lastPingAt: 0,
    batteryOptIgnored: true,
};

export function isBackgroundKeepAliveSupported(): boolean {
    return plugin !== null;
}

function clampHeartbeatMinutes(raw: unknown): 1 | 5 | 15 {
    if (raw === 1 || raw === 15) return raw;
    return 5;
}

function resolveMode(raw: unknown): KeepAliveMode {
    return raw === "realtime" ? "realtime" : "power_save";
}

function startPingLoop(): void {
    if (!plugin || pingStop) return;
    const native = plugin;
    const tick = () => {
        void native.ping().catch((err) => {
            console.warn("[BgKeepAlive] ping failed:", err);
        });
    };
    tick();
    // 30s 一拍；不受「允许主动消息」总开关影响——有意闲置时仍要报存活
    const id = window.setInterval(tick, 30_000);
    pingStop = () => {
        window.clearInterval(id);
        pingStop = null;
    };
}

function stopPingLoop(): void {
    if (pingStop) pingStop();
}

/**
 * 按 ChatAppSettings 启停原生保活。应在设置变更与 follow-up 服务启动时调用。
 * 非 Android 直接返回 idle 状态。
 */
export async function applyBackgroundKeepAlive(): Promise<BackgroundKeepAliveStatus> {
    if (!plugin) {
        lastKnownStatus = IDLE_STATUS;
        return IDLE_STATUS;
    }
    const settings = loadChatAppSettings();
    const want = settings.keepAliveEnabled === true;
    const mode = resolveMode(settings.keepAliveMode);
    const minutes = clampHeartbeatMinutes(settings.keepAliveHeartbeatMinutes);

    try {
        if (want) {
            const status = await plugin.start({ mode, heartbeatMinutes: minutes });
            lastKnownStatus = status;
            startPingLoop();
            return status;
        }
        const status = await plugin.stop();
        lastKnownStatus = status;
        stopPingLoop();
        return status;
    } catch (err) {
        console.warn("[BgKeepAlive] apply failed:", err);
        lastKnownStatus = {
            enabled: want,
            mode,
            heartbeatMinutes: minutes,
            lastPingAt: Date.now(),
            batteryOptIgnored: false,
        };
        if (want) startPingLoop();
        else stopPingLoop();
        return lastKnownStatus;
    }
}

export async function getBackgroundKeepAliveStatus(): Promise<BackgroundKeepAliveStatus> {
    if (!plugin) return IDLE_STATUS;
    try {
        lastKnownStatus = await plugin.status();
        return lastKnownStatus;
    } catch {
        return lastKnownStatus ?? IDLE_STATUS;
    }
}

export function peekBackgroundKeepAliveStatus(): BackgroundKeepAliveStatus {
    return lastKnownStatus ?? IDLE_STATUS;
}

export async function requestBatteryOptimizationExemption(): Promise<boolean> {
    if (!plugin) return true;
    try {
        const res = await plugin.requestIgnoreBatteryOptimizations();
        return res.ignoring === true;
    } catch (err) {
        console.warn("[BgKeepAlive] battery exemption request failed:", err);
        return false;
    }
}

export async function checkBatteryOptimizationExemption(): Promise<boolean> {
    if (!plugin) return true;
    try {
        const res = await plugin.isIgnoringBatteryOptimizations();
        return res.ignoring === true;
    } catch {
        return false;
    }
}

/** 写入保活相关设置并立刻 apply */
export async function setKeepAliveSettings(patch: {
    keepAliveEnabled?: boolean;
    keepAliveMode?: KeepAliveMode;
    keepAliveHeartbeatMinutes?: 1 | 5 | 15;
}): Promise<BackgroundKeepAliveStatus> {
    const current = loadChatAppSettings();
    saveChatAppSettings({
        ...current,
        ...(patch.keepAliveEnabled !== undefined ? { keepAliveEnabled: patch.keepAliveEnabled } : {}),
        ...(patch.keepAliveMode !== undefined ? { keepAliveMode: patch.keepAliveMode } : {}),
        ...(patch.keepAliveHeartbeatMinutes !== undefined
            ? { keepAliveHeartbeatMinutes: patch.keepAliveHeartbeatMinutes }
            : {}),
    });
    return applyBackgroundKeepAlive();
}
