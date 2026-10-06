"use client";

// 后台保活设置页：聊天 → 我的 → 主动消息 → 后台保活。
// 开关打开即拉起常驻前台服务并按模式安排闹钟心跳；权限徽章实时检测，
// 自启动无公开检测 API，只提供各 ROM 的路径引导（如实展示，不假装检测）。

import { useEffect, useState } from "react";
import { BatteryCharging, Bell, ChevronRight, ShieldCheck } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { Toggle, Select } from "@/components/ui/form";
import { loadChatAppSettings, saveChatAppSettings } from "@/lib/chat-storage";
import {
    applyBackgroundKeepAlive,
    isIgnoringBatteryOptimizations,
    isKeepAlivePlatform,
    requestIgnoreBatteryOptimizations,
} from "@/lib/background-keepalive";
import {
    getLocalNotificationPermission,
    requestLocalNotificationPermission,
    type LocalNotificationPermissionState,
} from "@/lib/native-notifications";

const HEARTBEAT_OPTIONS = [1, 5, 15];

export function KeepAliveSettingsPage({ onBack }: { onBack: () => void }) {
    const supported = isKeepAlivePlatform();
    const [enabled, setEnabled] = useState(false);
    const [mode, setMode] = useState<"power_saving" | "realtime">("power_saving");
    const [heartbeatMinutes, setHeartbeatMinutes] = useState(5);
    const [notifyHideContent, setNotifyHideContent] = useState(false);
    const [notificationPerm, setNotificationPerm] = useState<LocalNotificationPermissionState>("unknown");
    const [batteryExempt, setBatteryExempt] = useState(false);
    const [showAutostartGuide, setShowAutostartGuide] = useState(false);

    useEffect(() => {
        const settings = loadChatAppSettings();
        setEnabled(settings.keepAliveEnabled === true);
        setMode(settings.keepAliveMode === "realtime" ? "realtime" : "power_saving");
        setHeartbeatMinutes(Math.min(15, Math.max(1, Math.round(settings.keepAliveHeartbeatMinutes ?? 5))));
        setNotifyHideContent(settings.notifyHideContent === true);
        void getLocalNotificationPermission().then(setNotificationPerm);
        void isIgnoringBatteryOptimizations().then(setBatteryExempt);
    }, []);

    const persist = (patch: Partial<ReturnType<typeof loadChatAppSettings>>) => {
        saveChatAppSettings({ ...loadChatAppSettings(), ...patch });
    };

    const handleEnabledToggle = async (next: boolean) => {
        setEnabled(next);
        persist({ keepAliveEnabled: next });
        if (next && notificationPerm === "prompt") {
            setNotificationPerm(await requestLocalNotificationPermission());
        }
        await applyBackgroundKeepAlive();
    };

    const handleModeChange = async (next: "power_saving" | "realtime") => {
        setMode(next);
        persist({ keepAliveMode: next });
        await applyBackgroundKeepAlive();
    };

    const handleHeartbeatChange = async (minutes: number) => {
        setHeartbeatMinutes(minutes);
        persist({ keepAliveHeartbeatMinutes: minutes });
        await applyBackgroundKeepAlive();
    };

    const permBadge = (state: LocalNotificationPermissionState): { text: string; ok: boolean } => {
        if (state === "granted") return { text: "已授权", ok: true };
        if (state === "denied") return { text: "已被拒绝（去系统设置重开）", ok: false };
        if (state === "prompt") return { text: "去授权", ok: false };
        return { text: "不支持", ok: false };
    };

    const notifBadge = permBadge(notificationPerm);

    return (
        <PageShell title="后台保活" onBack={onBack} className="absolute inset-0 z-[100]">
            <div className="page-menu profile-settings-menu">
                {!supported && (
                    <p className="menu-group-desc mx-2">当前平台不支持后台保活（仅 Android App 可用）；网页版请保持标签页打开。</p>
                )}

                <p className="menu-group-desc mx-2">保活开关</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <ShieldCheck size={18} className="opacity-70" />
                        <div className="flex flex-col flex-1 gap-0.5">
                            <span className="ts-14 font-semibold">开启后台保活</span>
                            <span className="ts-11 opacity-70">切后台/锁屏时保住进程与引擎，主动消息照常触发并弹系统通知</span>
                        </div>
                        <Toggle checked={enabled} onChange={v => void handleEnabledToggle(v)} />
                    </div>
                </div>

                {enabled && supported && (
                    <>
                        <p className="menu-group-desc mx-2">保活模式</p>
                        <div className="menu-group">
                            <div className="menu-item">
                                <div className="flex flex-col flex-1 gap-0.5">
                                    <span className="ts-14 font-semibold">模式</span>
                                    <span className="ts-11 opacity-70">
                                        省电：闹钟心跳唤醒，约 1~2%/天；实时：常驻唤醒，消息秒级送达，约 3~8%/天
                                    </span>
                                </div>
                                <Select value={mode} onChange={e => void handleModeChange(e.target.value as "power_saving" | "realtime")}>
                                    <option value="power_saving">省电（推荐）</option>
                                    <option value="realtime">实时</option>
                                </Select>
                            </div>
                            {mode === "power_saving" && (
                                <div className="menu-item">
                                    <div className="flex flex-col flex-1 gap-0.5">
                                        <span className="ts-14 font-semibold">后台检查频率</span>
                                        <span className="ts-11 opacity-70">每隔多久醒来检查一次；深睡时系统最快约 9 分钟一拍</span>
                                    </div>
                                    <Select value={String(heartbeatMinutes)} onChange={e => void handleHeartbeatChange(Number(e.target.value))}>
                                        {HEARTBEAT_OPTIONS.map(n => <option key={n} value={n}>{n} 分钟</option>)}
                                    </Select>
                                </div>
                            )}
                        </div>
                    </>
                )}

                <p className="menu-group-desc mx-2">权限状态</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <Bell size={18} className="opacity-70" />
                        <div className="flex flex-col flex-1 gap-0.5">
                            <span className="ts-14 font-semibold">系统通知</span>
                            <span className="ts-11 opacity-70">后台消息弹窗的必要权限</span>
                        </div>
                        {notifBadge.ok ? (
                            <span className="ui-badge" data-variant="success">{notifBadge.text}</span>
                        ) : (
                            <button
                                type="button"
                                className="ui-link-btn"
                                disabled={!supported || notificationPerm === "denied"}
                                onClick={() => void requestLocalNotificationPermission().then(setNotificationPerm)}
                            >
                                {notifBadge.text}
                            </button>
                        )}
                    </div>
                    <div className="menu-item">
                        <BatteryCharging size={18} className="opacity-70" />
                        <div className="flex flex-col flex-1 gap-0.5">
                            <span className="ts-14 font-semibold">电池优化豁免</span>
                            <span className="ts-11 opacity-70">避免系统省电策略杀掉后台进程</span>
                        </div>
                        {batteryExempt ? (
                            <span className="ui-badge" data-variant="success">已豁免</span>
                        ) : (
                            <button type="button" className="ui-link-btn" disabled={!supported} onClick={() => void requestIgnoreBatteryOptimizations().then(setBatteryExempt)}>
                                去设置
                            </button>
                        )}
                    </div>
                    <div className="menu-item">
                        <ChevronRight size={18} className="opacity-70" />
                        <div className="flex flex-col flex-1 gap-0.5">
                            <span className="ts-14 font-semibold">自启动权限</span>
                            <span className="ts-11 opacity-70">国产 ROM 需手动允许，无检测接口</span>
                        </div>
                        <button type="button" className="ui-link-btn" onClick={() => setShowAutostartGuide(v => !v)}>
                            {showAutostartGuide ? "收起" : "查看引导"}
                        </button>
                    </div>
                    {showAutostartGuide && (
                        <div className="menu-item flex-col !items-stretch">
                            <span className="ts-11 opacity-80 leading-relaxed">
                                小米/HyperOS：设置 → 应用设置 → 应用管理 → 本应用 → 自启动。<br />
                                华为/荣耀：设置 → 应用 → 应用启动管理 → 关闭自动管理 → 允许自启动/关联启动/后台活动。<br />
                                OPPO/一加：设置 → 应用 → 自启动管理 → 允许；电池 → 更多设置 → 关闭深度睡眠优化。<br />
                                vivo/iQOO：设置 → 应用 → 权限管理 → 自启动 → 允许。<br />
                                三星：设置 → 电池 → 后台使用限制 → 将本应用移出“深度睡眠”。
                            </span>
                        </div>
                    )}
                </div>

                <p className="menu-group-desc mx-2">通知隐私</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <div className="flex flex-col flex-1 gap-0.5">
                            <span className="ts-14 font-semibold">通知不显示内容</span>
                            <span className="ts-11 opacity-70">开启后通知只显示“发来一条消息”，不泄露聊天内容</span>
                        </div>
                        <Toggle checked={notifyHideContent} onChange={v => { setNotifyHideContent(v); persist({ notifyHideContent: v }); }} />
                    </div>
                </div>

                <p className="menu-group-desc mx-2">
                    说明：上滑划掉 App 会暂停主动消息（会弹提醒让你点一下恢复，前提是保活开着）；重启手机后需打开一次 App。
                    开启保活后通知栏会有一条安静的“运行中”提示，这是 Android 保活的标准形态。
                </p>
            </div>
        </PageShell>
    );
}
