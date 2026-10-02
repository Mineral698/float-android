// 手机壳布局判定：把「是不是该全屏铺开的手机界面」收敛成一处确定性判断。
// 原先纯靠 CSS 媒体查询 (max-width:500px)+(hover:none)+(pointer:coarse)，但部分
// 国产 ROM / 手写笔设备 / 折叠屏会把 hover 或 pointer 误报为 hover/fine，或视口
// 宽度超过 500px，导致移动端布局整块不生效——退回带手机边框的桌面展示布局。
//
// 原生 Capacitor 壳里永远按手机处理：真实设备本身就是边框，无需再画手机框。
// 纯浏览器仍走媒体查询——桌面浏览器里保留带框样机的演示形态。

import { Capacitor } from "@capacitor/core";

const MOBILE_MQ = "(max-width: 500px) and (hover: none) and (pointer: coarse)";
const TOUCH_MQ = "(hover: none) and (pointer: coarse)";
const NARROW_MQ = "(max-width: 373px)";

/** 是否按「手机全屏壳」渲染（原生壳恒真；浏览器看媒体查询）。 */
export function isPhoneShellMobile(): boolean {
    if (Capacitor.isNativePlatform()) return true;
    return window.matchMedia(MOBILE_MQ).matches;
}

/** 主指针是否触摸（原生壳恒真；浏览器看媒体查询）。 */
export function isTouchPrimary(): boolean {
    if (Capacitor.isNativePlatform()) return true;
    return window.matchMedia(TOUCH_MQ).matches;
}

/**
 * 把判定结果同步成 <html> 上的 class，供 styles/phone-shell.css 使用：
 *   html.phone-shell-mobile  → 手机全屏壳布局（对应原 ≤500px 媒体查询块）
 *   html.phone-shell-narrow  → 极窄屏图标等比缩放（对应原 ≤373px 媒体查询块）
 * 在入口模块作用域调用一次；媒体查询变化（旋转、窗口缩放）会自动重评估。
 */
export function installShellLayoutMode(): void {
    const root = document.documentElement;
    const mobileMq = window.matchMedia(MOBILE_MQ);
    const narrowMq = window.matchMedia(NARROW_MQ);

    const apply = () => {
        const mobile = isPhoneShellMobile();
        root.classList.toggle("phone-shell-mobile", mobile);
        root.classList.toggle("phone-shell-narrow", mobile && narrowMq.matches);
    };

    apply();
    // MediaQueryList.addEventListener 需要 Chrome 39+；addListener 兜底更旧 WebView。
    for (const mql of [mobileMq, narrowMq]) {
        if (typeof mql.addEventListener === "function") {
            mql.addEventListener("change", apply);
        } else {
            mql.addListener(apply);
        }
    }
}
