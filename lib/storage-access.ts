// lib/storage-access.ts
// 公共 Documents 目录写权限：Android 11+ 裸路径写共享存储需要
// MANAGE_EXTERNAL_STORAGE（系统设置页手动授权），不在普通运行时权限里。
// 网页端/低版本直接放行。

import { Capacitor, registerPlugin } from "@capacitor/core";

type StorageAccessPlugin = {
    checkManageAccess(): Promise<{ granted: boolean }>;
    requestManageAccess(): Promise<{ granted: boolean }>;
};

const StorageAccess = registerPlugin<StorageAccessPlugin>("StorageAccess");

/** 是否已能写公共 Documents。检测失败按放行处理（让实际写操作自己报错）。 */
export async function hasPublicDocumentsAccess(): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) return true;
    try {
        return (await StorageAccess.checkManageAccess()).granted === true;
    } catch {
        return true;
    }
}

/** 拉起系统「所有文件访问」设置页。返回调用当下的授权状态（刚弹窗多半还是 false）。 */
export async function requestDocumentsAccess(): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) return true;
    try {
        return (await StorageAccess.requestManageAccess()).granted === true;
    } catch {
        return false;
    }
}
