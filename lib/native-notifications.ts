// lib/native-notifications.ts
// 后台消息的系统通知包装层（双平台契约）：
// - Android：走 Capacitor LocalNotifications（WebView 不渲染 Web Notification，
//   后台弹窗必须由原生本地通知承担）；点开通知跳转对应会话。
// - 网页版：不生效——降级沿用 browser-notification 的浏览器通知路径（调用方处理），
//   保活/弹窗能力不做假实现。
// - iOS：不挂任何行为（无后台保活场景，App 冻结时本模块不会被调用）。
//
// 按会话折叠：同一会话只保留一条通知，新消息原地更新并累计“N 条新消息”。
// 已读清理：App 回前台 / 点开对应会话时清除。

import { Capacitor } from "@capacitor/core";
import type { PermissionState } from "@capacitor/core";
import { App } from "@capacitor/app";
import { LocalNotifications } from "@capacitor/local-notifications";
import type { Importance, Visibility } from "@capacitor/local-notifications";
import { loadChatAppSettings } from "./chat-storage";

export const NOTIFICATION_OPEN_SESSION_EVENT = "ai-notification-open-session";

/** @capacitor/core 的 PermissionState 含 iOS 的 prompt-with-rationale；unknown = 平台不支持/查询失败 */
export type LocalNotificationPermissionState = PermissionState | "unknown";

const MESSAGE_CHANNEL_ID = "proactive-messages";
const CHANNEL_IMPORTANCE_HIGH: Importance = 4;
const CHANNEL_VISIBILITY_PUBLIC: Visibility = 1;

type BackgroundMessageDetail = {
    sessionId: string;
    /** 通知标题：单聊=角色名/备注，群聊=群名 */
    title: string;
    /** 通知内容：已按发送者前缀拼好的一条消息摘要 */
    body: string;
};

const sessionNotificationIds = new Map<string, number>();
const sessionUnreadCounts = new Map<string, number>();
let appActive = true;
let inited = false;

function isNativeAndroid(): boolean {
    return Capacitor.getPlatform() === "android";
}

/** sessionId → 稳定的正数通知 id（同会话原地更新实现折叠） */
function notificationIdFor(sessionId: string): number {
    const existing = sessionNotificationIds.get(sessionId);
    if (existing !== undefined) return existing;
    let hash = 0;
    for (let i = 0; i < sessionId.length; i++) {
        hash = (hash * 31 + sessionId.charCodeAt(i)) | 0;
    }
    const id = Math.abs(hash) || 1;
    sessionNotificationIds.set(sessionId, id);
    return id;
}

/** App 启动时调用一次：建通知渠道、跟踪前后台切换、处理通知点击 */
export async function initBackgroundNotifications(): Promise<void> {
    if (!isNativeAndroid() || inited) return;
    inited = true;
    try {
        await LocalNotifications.createChannel({
            id: MESSAGE_CHANNEL_ID,
            name: "主动消息",
            description: "角色在后台主动发来的消息提醒",
            importance: CHANNEL_IMPORTANCE_HIGH,
            visibility: CHANNEL_VISIBILITY_PUBLIC,
            vibration: true,
        });
    } catch (error) {
        console.warn("[NativeNotifications] createChannel failed:", error);
    }

    try {
        await App.addListener("appStateChange", (state) => {
            appActive = state.isActive;
            if (state.isActive) void clearAllMessageNotifications();
        });
    } catch (error) {
        console.warn("[NativeNotifications] appStateChange listener failed:", error);
    }

    try {
        await LocalNotifications.addListener("localNotificationActionPerformed", (action) => {
            const sessionId = (action.notification.extra as { sessionId?: string } | undefined)?.sessionId;
            if (!sessionId) return;
            void clearSessionNotification(sessionId);
            window.dispatchEvent(new CustomEvent(NOTIFICATION_OPEN_SESSION_EVENT, { detail: { sessionId } }));
        });
    } catch (error) {
        console.warn("[NativeNotifications] action listener failed:", error);
    }
}

/**
 * 后台落库的 assistant 消息 → 系统通知（同会话原地折叠）。
 * App 处于前台时不弹（App 内横幅已覆盖）；权限未授予时静默跳过。
 */
export async function notifyBackgroundMessage(detail: BackgroundMessageDetail): Promise<void> {
    if (!isNativeAndroid() || !detail.sessionId || appActive) return;
    try {
        if ((await LocalNotifications.checkPermissions()).display !== "granted") return;
    } catch {
        return;
    }

    const hideContent = loadChatAppSettings().notifyHideContent === true;
    const unread = (sessionUnreadCounts.get(detail.sessionId) || 0) + 1;
    sessionUnreadCounts.set(detail.sessionId, unread);

    try {
        await LocalNotifications.schedule({
            notifications: [{
                id: notificationIdFor(detail.sessionId),
                channelId: MESSAGE_CHANNEL_ID,
                title: detail.title,
                body: hideContent ? "发来一条消息" : detail.body,
                summaryText: unread > 1 ? `${unread} 条新消息` : undefined,
                extra: { sessionId: detail.sessionId },
            }],
        });
    } catch (error) {
        console.warn("[NativeNotifications] schedule failed:", error);
    }
}

export async function clearSessionNotification(sessionId: string): Promise<void> {
    if (!isNativeAndroid()) return;
    sessionUnreadCounts.delete(sessionId);
    const id = sessionNotificationIds.get(sessionId);
    if (id === undefined) return;
    try {
        const delivered = await LocalNotifications.getDeliveredNotifications();
        const found = delivered.notifications.filter(n => n.id === id);
        if (found.length > 0) await LocalNotifications.removeDeliveredNotifications({ notifications: found });
    } catch { /* 忽略清理失败 */ }
}

export async function clearAllMessageNotifications(): Promise<void> {
    if (!isNativeAndroid() || sessionNotificationIds.size === 0) return;
    sessionUnreadCounts.clear();
    const ids = new Set(Array.from(sessionNotificationIds.values()));
    try {
        const delivered = await LocalNotifications.getDeliveredNotifications();
        const found = delivered.notifications.filter(n => ids.has(n.id));
        if (found.length > 0) await LocalNotifications.removeDeliveredNotifications({ notifications: found });
    } catch { /* 忽略清理失败 */ }
}

// ── 权限（保活设置页的状态徽章用）──

export async function getLocalNotificationPermission(): Promise<LocalNotificationPermissionState> {
    if (!isNativeAndroid()) return "unknown";
    try {
        const status = await LocalNotifications.checkPermissions();
        return status.display;
    } catch {
        return "unknown";
    }
}

export async function requestLocalNotificationPermission(): Promise<LocalNotificationPermissionState> {
    if (!isNativeAndroid()) return "unknown";
    try {
        const status = await LocalNotifications.requestPermissions();
        return status.display;
    } catch {
        return "unknown";
    }
}
