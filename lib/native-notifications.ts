// lib/native-notifications.ts
// 后台新消息的系统通知包装层。
//
// Android / iOS：走 @capacitor/local-notifications，弹出系统级横幅（类似微信）。
// 网页：降级到既有 browser Notification API（lib/browser-notification.ts）。
//
// 规则：
// - App 在前台时不弹系统通知（前台靠 App 内 chat-message-notice 横幅，避免双弹）
// - 同一会话折叠为一条通知，多条时显示「N 条新消息」
// - 回前台或点开通知后清除该会话的已送达通知
// - 可选「通知不显示内容」隐私开关（notifyHideContent）

import { App } from "@capacitor/app";
import { Capacitor, registerPlugin } from "@capacitor/core";
import {
    LocalNotifications,
    type Channel,
    type LocalNotificationSchema,
} from "@capacitor/local-notifications";

import { sendBrowserNotification } from "./browser-notification";
import { loadChatAppSettings, saveChatAppSettings } from "./chat-storage";

type AndroidChatNotifyPlugin = {
    showChatNotification(options: { id: number; title: string; body: string; sessionId: string }): Promise<void>;
    cancelChatNotification(options: { id: number }): Promise<void>;
};

/** Android 走自有高优先级通知；iOS 仍用 LocalNotifications */
const androidChatNotify: AndroidChatNotifyPlugin | null = Capacitor.getPlatform() === "android"
    ? registerPlugin<AndroidChatNotifyPlugin>("BackgroundKeepAlive")
    : null;

export const NOTIFICATION_OPEN_SESSION_EVENT = "ai-notification-open-session";

const CHANNEL_ID = "chat_messages";
const CHANNEL_NAME = "聊天消息";
/** IMPORTANCE_HIGH：允许 heads-up 横幅 */
const CHANNEL_IMPORTANCE = 4 as Channel["importance"];

type SessionNoticeState = {
    id: number;
    count: number;
    title: string;
};

const sessionNotices = new Map<string, SessionNoticeState>();
let appIsActive = true;
let initialized = false;
let initPromise: Promise<void> | null = null;

function isNativeNotificationPlatform(): boolean {
    const platform = Capacitor.getPlatform();
    return platform === "android" || platform === "ios";
}

function isSystemNotificationSettingEnabled(): boolean {
    const enabled = loadChatAppSettings().browserNotificationsEnabled;
    // Android/iOS 默认开（未显式关闭就弹）。网页仍需用户打开开关。
    if (isNativeNotificationPlatform()) return enabled !== false;
    return enabled === true;
}

function shouldHideContent(): boolean {
    return loadChatAppSettings().notifyHideContent === true;
}

/** sessionId → 稳定的 32-bit 正整数通知 id（进程内折叠用；重启后 Map 重建可接受） */
function notificationIdForSession(sessionId: string): number {
    let hash = 0;
    for (let i = 0; i < sessionId.length; i += 1) {
        hash = ((hash << 5) - hash + sessionId.charCodeAt(i)) | 0;
    }
    // 避开 0；保持正 31-bit，落在 Android int 范围内
    return (Math.abs(hash) % 2_000_000_000) + 1;
}

function dispatchOpenSession(sessionId: string): void {
    if (typeof window === "undefined" || !sessionId) return;
    window.dispatchEvent(new CustomEvent(NOTIFICATION_OPEN_SESSION_EVENT, {
        detail: { sessionId },
    }));
}

async function ensureChannel(): Promise<void> {
    if (Capacitor.getPlatform() !== "android") return;
    try {
        await LocalNotifications.createChannel({
            id: CHANNEL_ID,
            name: CHANNEL_NAME,
            description: "角色主动消息与后台回复的系统提醒",
            importance: CHANNEL_IMPORTANCE,
            visibility: 1,
            vibration: true,
            lights: true,
        });
    } catch (err) {
        console.warn("[NativeNotifications] createChannel failed:", err);
    }
}

async function clearDeliveredById(id: number): Promise<void> {
    if (androidChatNotify) {
        try {
            await androidChatNotify.cancelChatNotification({ id });
        } catch {
            // ignore
        }
    }
    try {
        await LocalNotifications.removeDeliveredNotifications({
            // Cap 7 typings require title/body on DeliveredNotificationSchema; runtime only needs id
            notifications: [{ id, title: "", body: "" }],
        });
    } catch {
        // ignore — notification may already be gone
    }
    try {
        await LocalNotifications.cancel({ notifications: [{ id }] });
    } catch {
        // ignore
    }
}

/** 清除某个会话的系统通知（点开会话 / 回前台时调用） */
export async function clearSessionNotification(sessionId: string): Promise<void> {
    if (!sessionId || !isNativeNotificationPlatform()) return;
    const existing = sessionNotices.get(sessionId);
    const id = existing?.id ?? notificationIdForSession(sessionId);
    sessionNotices.delete(sessionId);
    await clearDeliveredById(id);
}

/** 清除全部会话折叠状态与已送达通知 */
export async function clearAllSessionNotifications(): Promise<void> {
    if (!isNativeNotificationPlatform()) return;
    const ids = [...sessionNotices.values()].map(s => s.id);
    sessionNotices.clear();
    if (ids.length === 0) {
        try {
            await LocalNotifications.removeAllDeliveredNotifications();
        } catch {
            // ignore
        }
        return;
    }
    await Promise.all(ids.map(id => clearDeliveredById(id)));
}

/**
 * 初始化：建 channel、跟踪前后台、监听通知点击。
 * 幂等；可在 desktop-shell / follow-up 启动时调用。
 */
export function initNativeNotifications(): Promise<void> {
    if (!isNativeNotificationPlatform()) return Promise.resolve();
    if (initialized) return Promise.resolve();
    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            const state = await App.getState();
            appIsActive = state.isActive !== false;
        } catch {
            appIsActive = typeof document === "undefined" ? true : !document.hidden;
        }

        await ensureChannel();

        if (isSystemNotificationSettingEnabled()) {
            try {
                const perm = await LocalNotifications.checkPermissions();
                if (perm.display !== "granted") {
                    await LocalNotifications.requestPermissions();
                }
            } catch (err) {
                console.warn("[NativeNotifications] permission request failed:", err);
            }
        }

        try {
            await App.addListener("appStateChange", ({ isActive }) => {
                appIsActive = isActive;
                const pageVisible = typeof document === "undefined" || !document.hidden;
                if (isActive && pageVisible) {
                    void clearAllSessionNotifications();
                }
            });
        } catch (err) {
            console.warn("[NativeNotifications] appStateChange listener failed:", err);
        }

        try {
            await LocalNotifications.addListener("localNotificationActionPerformed", (action) => {
                const sessionId = action.notification?.extra?.sessionId;
                if (typeof sessionId === "string" && sessionId) {
                    void clearSessionNotification(sessionId);
                    dispatchOpenSession(sessionId);
                }
            });
        } catch (err) {
            console.warn("[NativeNotifications] action listener failed:", err);
        }

        initialized = true;
    })().catch((err) => {
        console.warn("[NativeNotifications] init failed:", err);
        initPromise = null;
    });

    return initPromise ?? Promise.resolve();
}

/** 前台才抑制系统通知。任一信号表明已退后台就弹。 */
async function isAppForeground(): Promise<boolean> {
    try {
        const state = await App.getState();
        if (state.isActive === false) return false;
    } catch {
        // 读不到原生状态时看 visibility
    }
    if (typeof document !== "undefined" && document.hidden) return false;
    return appIsActive;
}

async function postNativeNotification(payload: {
    id: number;
    title: string;
    body: string;
    sessionId: string;
}): Promise<void> {
    if (androidChatNotify) {
        await androidChatNotify.showChatNotification(payload);
        return;
    }
    const schema: LocalNotificationSchema = {
        id: payload.id,
        title: payload.title,
        body: payload.body,
        largeBody: payload.body,
        channelId: CHANNEL_ID,
        autoCancel: true,
        extra: { sessionId: payload.sessionId },
    };
    await LocalNotifications.schedule({ notifications: [schema] });
}

/** 查询系统通知权限是否已授予（原生）或浏览器 Notification 是否 granted */
export async function checkSystemNotificationPermission(): Promise<boolean> {
    if (isNativeNotificationPlatform()) {
        try {
            const status = await LocalNotifications.checkPermissions();
            return status.display === "granted";
        } catch {
            return false;
        }
    }
    if (typeof window === "undefined" || !("Notification" in window)) return false;
    return Notification.permission === "granted";
}

/** 申请系统通知权限；原生走 LocalNotifications，网页走 Notification.requestPermission */
export async function requestSystemNotificationPermission(): Promise<boolean> {
    if (isNativeNotificationPlatform()) {
        await initNativeNotifications();
        try {
            const status = await LocalNotifications.requestPermissions();
            return status.display === "granted";
        } catch (err) {
            console.warn("[NativeNotifications] requestPermissions failed:", err);
            return false;
        }
    }
    const { requestNotificationPermission } = await import("./browser-notification");
    return requestNotificationPermission();
}

export type BackgroundMessageNotice = {
    sessionId: string;
    title: string;
    body: string;
    /** 可选头像 URL；原生端暂不嵌入大图（避免 base64 过桥），保留参数供网页路径使用 */
    icon?: string;
};

/**
 * 后台新消息系统通知入口。
 * - 设置未开 → 不弹
 * - App 前台 → 不弹系统通知（由 App 内横幅负责）
 * - Android/iOS → LocalNotifications 即时弹出并按会话折叠
 * - 网页 → browser Notification API
 */
export async function notifyBackgroundMessage(notice: BackgroundMessageNotice): Promise<void> {
    if (!notice.sessionId || !notice.title) return;
    if (!isSystemNotificationSettingEnabled()) return;

    if (!isNativeNotificationPlatform()) {
        if (typeof document !== "undefined" && !document.hidden) return;
        sendBrowserNotification(notice.title, {
            body: notice.body,
            icon: notice.icon,
        });
        return;
    }

    await initNativeNotifications();
    if (await isAppForeground()) return;

    try {
        const perm = await LocalNotifications.checkPermissions();
        if (perm.display !== "granted") return;
    } catch {
        return;
    }

    const hide = shouldHideContent();
    const prev = sessionNotices.get(notice.sessionId);
    const id = prev?.id ?? notificationIdForSession(notice.sessionId);
    const count = (prev?.count ?? 0) + 1;
    const title = notice.title.trim() || "新消息";
    const rawBody = (notice.body || "").trim() || "发来一条消息";
    const body = hide
        ? (count > 1 ? `${count} 条新消息` : "发来一条消息")
        : (count > 1 ? `${rawBody}（${count} 条新消息）` : rawBody);

    sessionNotices.set(notice.sessionId, { id, count, title });

    try {
        await postNativeNotification({
            id,
            title,
            body,
            sessionId: notice.sessionId,
        });
    } catch (err) {
        console.warn("[NativeNotifications] show failed:", err);
    }
}

/** 写入隐私开关（通知不显示正文） */
export function setNotifyHideContent(hide: boolean): void {
    const settings = loadChatAppSettings();
    saveChatAppSettings({ ...settings, notifyHideContent: hide });
}

export function getNotifyHideContent(): boolean {
    return shouldHideContent();
}

/** 当前是否应走原生系统通知（供设置页文案切换） */
export function usesNativeSystemNotifications(): boolean {
    return isNativeNotificationPlatform();
}
