// 媒体权限按需申请：浏览器端直接放行（浏览器自己管权限弹窗），
// 原生端走 MediaPermissionsPlugin 拉起 Android 运行时权限，
// 授权后 WebView 的 getUserMedia 才能拿到流。

import { Capacitor, registerPlugin } from "@capacitor/core";

type MediaPermissionsPlugin = {
    ensureMicrophone(): Promise<{ granted: boolean }>;
    ensureCamera(): Promise<{ granted: boolean }>;
    ensureCameraAndMic(): Promise<{ granted: boolean }>;
};

const MediaPermissions = registerPlugin<MediaPermissionsPlugin>("MediaPermissions");

async function ensure(kind: "microphone" | "camera" | "av"): Promise<boolean> {
    // iOS 权限由 Info.plist usage description + WKWebView getUserMedia 系统弹窗处理
    if (Capacitor.getPlatform() !== "android") return true;
    try {
        const res = kind === "microphone" ? await MediaPermissions.ensureMicrophone()
            : kind === "camera" ? await MediaPermissions.ensureCamera()
            : await MediaPermissions.ensureCameraAndMic();
        return res.granted === true;
    } catch {
        return false;
    }
}

/** 语音输入/录音前调用：申请麦克风运行时权限，返回是否可用。 */
export function ensureMicrophonePermission(): Promise<boolean> {
    return ensure("microphone");
}

/** 仅视频前调用。 */
export function ensureCameraPermission(): Promise<boolean> {
    return ensure("camera");
}

/** 视频通话等同时需要摄像头+麦克风的场景。 */
export function ensureCameraAndMicPermission(): Promise<boolean> {
    return ensure("av");
}
