// 流畅模式：禁用全站 backdrop-filter 实时毛玻璃。
// Android WebView 上毛玻璃是最重的 GPU 开销之一（滚动时逐帧对下层内容做模糊合成），
// 聊天页/桌面卡顿的主要渲染侧原因之一。默认策略：原生壳内自动开启，浏览器默认关闭；
// 用户在 设置 → Runtime → 流畅模式 可手动覆盖。

import { Capacitor } from "@capacitor/core";
import { kvGet, kvSet } from "./kv-db";

const KEY = "perf_smooth_mode";

export function isSmoothModeEnabled(): boolean {
    const v = kvGet(KEY);
    if (v === "on") return true;
    if (v === "off") return false;
    return Capacitor.isNativePlatform();
}

export function setSmoothMode(on: boolean): void {
    kvSet(KEY, on ? "on" : "off");
    applyPerfMode();
}

export function applyPerfMode(): void {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("perf-smooth", isSmoothModeEnabled());
}
