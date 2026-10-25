"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { Battery, Bell, BellOff, ChevronRight, HeartPulse, Info, Shield } from "lucide-react";

import { PageShell } from "@/components/ui/page-shell";
import { Toggle } from "@/components/ui/form";
import {
    checkBatteryOptimizationExemption,
    getBackgroundKeepAliveStatus,
    isBackgroundKeepAliveSupported,
    requestBatteryOptimizationExemption,
    setKeepAliveSettings,
    type BackgroundKeepAliveStatus,
} from "@/lib/background-keepalive";
import {
    checkSystemNotificationPermission,
    getNotifyHideContent,
    requestSystemNotificationPermission,
    setNotifyHideContent,
} from "@/lib/native-notifications";
import { loadChatAppSettings, saveChatAppSettings, type KeepAliveMode } from "@/lib/chat-storage";
import { BINDING_ACCENTS } from "@/lib/ui-accent-colors";

type KeepAliveSettingsPageProps = {
    onBack: () => void;
};

function statusLabel(status: BackgroundKeepAliveStatus | null, supported: boolean): string {
    if (!supported) return "当前平台不支持常驻保活（仅 Android）";
    if (!status?.enabled) return "未运行";
    const mode = status.mode === "realtime" ? "实时" : "省电";
    return `运行中 · ${mode} · 心跳 ${status.heartbeatMinutes} 分钟`;
}

export function KeepAliveSettingsPage({ onBack }: KeepAliveSettingsPageProps) {
    const supported = isBackgroundKeepAliveSupported();
    const [enabled, setEnabled] = useState(false);
    const [mode, setMode] = useState<KeepAliveMode>("power_save");
    const [heartbeat, setHeartbeat] = useState<1 | 5 | 15>(5);
    const [status, setStatus] = useState<BackgroundKeepAliveStatus | null>(null);
    const [batteryIgnored, setBatteryIgnored] = useState(false);
    const [notifGranted, setNotifGranted] = useState(false);
    const [notifEnabled, setNotifEnabled] = useState(false);
    const [hideContent, setHideContent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [hint, setHint] = useState<string | null>(null);

    const refresh = async () => {
        const settings = loadChatAppSettings();
        setEnabled(settings.keepAliveEnabled === true);
        setMode(settings.keepAliveMode === "realtime" ? "realtime" : "power_save");
        setHeartbeat(
            settings.keepAliveHeartbeatMinutes === 1 || settings.keepAliveHeartbeatMinutes === 15
                ? settings.keepAliveHeartbeatMinutes
                : 5,
        );
        setNotifEnabled(settings.browserNotificationsEnabled === true);
        setHideContent(getNotifyHideContent());
        const [st, bat, perm] = await Promise.all([
            getBackgroundKeepAliveStatus(),
            checkBatteryOptimizationExemption(),
            checkSystemNotificationPermission(),
        ]);
        setStatus(st);
        setBatteryIgnored(bat);
        setNotifGranted(perm);
    };

    useEffect(() => {
        void refresh();
        const id = window.setInterval(() => { void refresh(); }, 8_000);
        return () => window.clearInterval(id);
    }, []);

    const handleEnable = async (next: boolean) => {
        if (busy) return;
        setBusy(true);
        setHint(null);
        try {
            if (next && !notifGranted) {
                const granted = await requestSystemNotificationPermission();
                setNotifGranted(granted);
                if (granted) {
                    saveChatAppSettings({ ...loadChatAppSettings(), browserNotificationsEnabled: true });
                    setNotifEnabled(true);
                }
            }
            const st = await setKeepAliveSettings({ keepAliveEnabled: next });
            setEnabled(next);
            setStatus(st);
            setHint(next
                ? "已开启常驻保活。请顺便打开电池豁免与各 ROM 自启动，否则仍可能被杀。"
                : "已关闭常驻保活。");
        } catch (err) {
            setHint(`操作失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setBusy(false);
            void refresh();
        }
    };

    const handleMode = async (next: KeepAliveMode) => {
        setMode(next);
        const st = await setKeepAliveSettings({ keepAliveMode: next });
        setStatus(st);
    };

    const handleHeartbeat = async (next: 1 | 5 | 15) => {
        setHeartbeat(next);
        const st = await setKeepAliveSettings({ keepAliveHeartbeatMinutes: next });
        setStatus(st);
        if (next === 1) {
            setHint("已设 1 分钟；Doze 下系统仍可能把闹钟拉到约 9 分钟一拍。");
        }
    };

    const handleBattery = async () => {
        setBusy(true);
        try {
            const ignored = await requestBatteryOptimizationExemption();
            setBatteryIgnored(ignored);
            setHint(ignored ? "已忽略电池优化。" : "请在系统页里把 float 设为「不优化」。");
        } finally {
            setBusy(false);
            void refresh();
        }
    };

    const handleNotifToggle = async (next: boolean) => {
        if (!next) {
            saveChatAppSettings({ ...loadChatAppSettings(), browserNotificationsEnabled: false });
            setNotifEnabled(false);
            return;
        }
        const granted = await requestSystemNotificationPermission();
        setNotifGranted(granted);
        saveChatAppSettings({ ...loadChatAppSettings(), browserNotificationsEnabled: granted });
        setNotifEnabled(granted);
        if (!granted) setHint("未获得通知权限，请到系统设置允许通知。");
    };

    return (
        <PageShell title="后台保活" onBack={onBack} className="absolute inset-0 z-[100]">
            <div className="page-menu profile-settings-menu">
                <p className="menu-group-desc mx-2">
                    开启后拉起常驻前台服务，尽量让主动消息在退后台后仍能生成并推系统通知。
                    划掉 App 后 WebView 会销毁——那时会收到「点按恢复」；系统设置里强制停止则彻底失效。
                </p>

                <div className="menu-group">
                    <div className="menu-item">
                        <span className="chat-info-icon" style={{ "--icon-color": BINDING_ACCENTS.identity } as CSSProperties}>
                            <HeartPulse size={22} strokeWidth={1.75} />
                        </span>
                        <div className="menu-label-group">
                            <span className="menu-label">启用后台保活</span>
                            <span className="menu-desc">{statusLabel(status, supported)}</span>
                        </div>
                        <Toggle
                            checked={enabled}
                            disabled={!supported || busy}
                            onChange={v => { void handleEnable(v); }}
                        />
                    </div>

                    <div className="menu-item" style={{ opacity: enabled ? 1 : 0.45 }}>
                        <span className="chat-info-icon" style={{ "--icon-color": BINDING_ACCENTS.voice } as CSSProperties}>
                            <Shield size={22} strokeWidth={1.75} />
                        </span>
                        <div className="menu-label-group">
                            <span className="menu-label">保活模式</span>
                            <span className="menu-desc">
                                {mode === "realtime" ? "实时：常驻唤醒锁，更稳也更耗电" : "省电：靠心跳闹钟唤醒引擎"}
                            </span>
                        </div>
                        <div className="menu-right">
                            <select
                                className="text-right border-none outline-none ts-13 text-[var(--c-text)] bg-transparent"
                                disabled={!enabled || !supported || busy}
                                value={mode}
                                onChange={e => { void handleMode(e.target.value as KeepAliveMode); }}
                            >
                                <option value="power_save">省电</option>
                                <option value="realtime">实时</option>
                            </select>
                        </div>
                    </div>

                    <div className="menu-item" style={{ opacity: enabled ? 1 : 0.45 }}>
                        <span className="chat-info-icon" style={{ "--icon-color": BINDING_ACCENTS.preset } as CSSProperties}>
                            <Info size={22} strokeWidth={1.75} />
                        </span>
                        <div className="menu-label-group">
                            <span className="menu-label">心跳频率</span>
                            <span className="menu-desc">Doze 下系统最快约 9 分钟一拍</span>
                        </div>
                        <div className="menu-right">
                            <select
                                className="text-right border-none outline-none ts-13 text-[var(--c-text)] bg-transparent"
                                disabled={!enabled || !supported || busy}
                                value={String(heartbeat)}
                                onChange={e => { void handleHeartbeat(Number(e.target.value) as 1 | 5 | 15); }}
                            >
                                <option value="1">1 分钟</option>
                                <option value="5">5 分钟</option>
                                <option value="15">15 分钟</option>
                            </select>
                        </div>
                    </div>
                </div>

                <p className="menu-group-desc mx-2">权限与豁免</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <span className="chat-info-icon" style={{ "--icon-color": BINDING_ACCENTS.memory } as CSSProperties}>
                            <Bell size={22} strokeWidth={1.75} />
                        </span>
                        <div className="menu-label-group">
                            <span className="menu-label">通知权限</span>
                            <span className="menu-desc">{notifGranted ? "已授予" : "未授予——系统横幅发不出来"}</span>
                        </div>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                            onClick={() => { void requestSystemNotificationPermission().then(g => { setNotifGranted(g); void refresh(); }); }}
                        >
                            {notifGranted ? "已允许" : "去申请"}
                        </button>
                    </div>

                    <div className="menu-item">
                        <span className="chat-info-icon" style={{ "--icon-color": CONTENT_BATTERY } as CSSProperties}>
                            <Battery size={22} strokeWidth={1.75} />
                        </span>
                        <div className="menu-label-group">
                            <span className="menu-label">电池优化豁免</span>
                            <span className="menu-desc">{batteryIgnored ? "已忽略优化" : "未豁免——后台仍可能被杀"}</span>
                        </div>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                            disabled={!supported || busy}
                            onClick={() => { void handleBattery(); }}
                        >
                            {batteryIgnored ? "已设置" : "一键跳转"}
                        </button>
                    </div>

                    <a
                        className="menu-item"
                        href="https://dontkillmyapp.com/"
                        target="_blank"
                        rel="noreferrer"
                    >
                        <span className="chat-info-icon" style={{ "--icon-color": BINDING_ACCENTS.regex } as CSSProperties}>
                            <ChevronRight size={22} strokeWidth={1.75} />
                        </span>
                        <div className="menu-label-group">
                            <span className="menu-label">各 ROM 自启动引导</span>
                            <span className="menu-desc">小米 / 华为 / OPPO / vivo 等需额外放开自启动</span>
                        </div>
                        <ChevronRight size={16} className="text-[var(--c-icon)] opacity-50" />
                    </a>
                </div>

                <p className="menu-group-desc mx-2">通知</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <span className="chat-info-icon" style={{ "--icon-color": BINDING_ACCENTS.identity } as CSSProperties}>
                            <Bell size={22} strokeWidth={1.75} />
                        </span>
                        <div className="menu-label-group">
                            <span className="menu-label">新消息系统通知</span>
                            <span className="menu-desc">后台落库后推系统横幅</span>
                        </div>
                        <Toggle checked={notifEnabled} onChange={v => { void handleNotifToggle(v); }} />
                    </div>
                    <div className="menu-item">
                        <span className="chat-info-icon" style={{ "--icon-color": BINDING_ACCENTS.memory } as CSSProperties}>
                            <BellOff size={22} strokeWidth={1.75} />
                        </span>
                        <div className="menu-label-group">
                            <span className="menu-label">通知不显示内容</span>
                            <span className="menu-desc">只显示「发来一条消息」</span>
                        </div>
                        <Toggle
                            checked={hideContent}
                            disabled={!notifEnabled}
                            onChange={v => { setHideContent(v); setNotifyHideContent(v); }}
                        />
                    </div>
                </div>

                {hint && <p className="menu-group-desc mx-2">{hint}</p>}

                <p className="menu-group-desc mx-2">
                    边界：保活开着时划掉 App，进程可能被前台服务按住，但 WebView 已毁 → 引擎死 → 会弹「点按恢复」。
                    系统设置里强制停止 = 彻底死，无解。开启保活请在 App 前台操作（Android 12+ 限制）。
                </p>

                {!supported && (
                    <p className="menu-group-desc mx-2">iOS / 网页不提供常驻保活；请保持 App 或标签页在前台附近。</p>
                )}
            </div>
        </PageShell>
    );
}

/** 电池图标用色（避免再引一整包 accent） */
const CONTENT_BATTERY = "#16a34a";
