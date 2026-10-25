package app.floatphone.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 常驻后台保活桥：JS（lib/background-keepalive.ts）启停服务、上报引擎存活 ping、
 * 查询/跳转电池优化豁免。启停状态写入 SharedPreferences，供开机与心跳恢复。
 */
@CapacitorPlugin(name = "BackgroundKeepAlive")
public class BackgroundKeepAlivePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        Context ctx = getContext();
        String mode = call.getString("mode", BackgroundKeepAlivePrefs.MODE_POWER_SAVE);
        Integer minutes = call.getInt("heartbeatMinutes", 5);
        BackgroundKeepAlivePrefs.setEnabled(ctx, true);
        BackgroundKeepAlivePrefs.setMode(ctx, mode);
        BackgroundKeepAlivePrefs.setHeartbeatMinutes(ctx, minutes != null ? minutes : 5);
        // 刚开启时记一笔 ping，避免服务立刻判失联
        BackgroundKeepAlivePrefs.setLastPingAt(ctx, System.currentTimeMillis());

        HeartbeatScheduler.scheduleNext(ctx, BackgroundKeepAlivePrefs.getHeartbeatMinutes(ctx));
        try {
            ContextCompat.startForegroundService(ctx, new Intent(ctx, BackgroundKeepAliveService.class));
        } catch (RuntimeException e) {
            // Android 12+ 禁止后台起 FGS：开关应在前台拨动；此处静默，status 会反映
            Logger.warn("BackgroundKeepAlive start rejected: " + e.getMessage());
        }
        call.resolve(statusObject(ctx));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        BackgroundKeepAlivePrefs.setEnabled(ctx, false);
        HeartbeatScheduler.cancel(ctx);
        try {
            ctx.stopService(new Intent(ctx, BackgroundKeepAliveService.class));
        } catch (RuntimeException e) {
            Logger.warn("BackgroundKeepAlive stop failed: " + e.getMessage());
        }
        call.resolve(statusObject(ctx));
    }

    @PluginMethod
    public void ping(PluginCall call) {
        Context ctx = getContext();
        BackgroundKeepAlivePrefs.setLastPingAt(ctx, System.currentTimeMillis());
        call.resolve();
    }

    /**
     * 立刻弹一条聊天系统通知（heads-up）。不依赖保活服务是否在跑。
     */
    @PluginMethod
    public void showChatNotification(PluginCall call) {
        Context ctx = getContext();
        if (!ChatMessageNotifier.notificationsEnabled(ctx)) {
            call.reject("notifications disabled");
            return;
        }
        String title = call.getString("title", "新消息");
        String body = call.getString("body", "发来一条消息");
        String sessionId = call.getString("sessionId", "");
        Integer id = call.getInt("id", 4801);
        ChatMessageNotifier.show(ctx, id != null ? id : 4801, title, body, sessionId);
        call.resolve();
    }

    @PluginMethod
    public void cancelChatNotification(PluginCall call) {
        Integer id = call.getInt("id", 0);
        ChatMessageNotifier.cancel(getContext(), id != null ? id : 0);
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(statusObject(getContext()));
    }

    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ignoring", isBatteryOptIgnored(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        Context ctx = getContext();
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity unavailable");
            return;
        }
        try {
            Intent intent;
            if (isBatteryOptIgnored(ctx)) {
                intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            } else {
                intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(Uri.parse("package:" + ctx.getPackageName()));
            }
            activity.startActivity(intent);
        } catch (RuntimeException e) {
            try {
                Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                activity.startActivity(fallback);
            } catch (RuntimeException e2) {
                Logger.warn("battery opt settings unavailable: " + e2.getMessage());
                call.reject("无法打开电池优化设置");
                return;
            }
        }
        JSObject result = new JSObject();
        result.put("ignoring", isBatteryOptIgnored(ctx));
        call.resolve(result);
    }

    private static boolean isBatteryOptIgnored(Context ctx) {
        if (Build.VERSION.SDK_INT < 23) return true;
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        } catch (RuntimeException e) {
            return false;
        }
    }

    private static JSObject statusObject(Context ctx) {
        JSObject result = new JSObject();
        result.put("enabled", BackgroundKeepAlivePrefs.isEnabled(ctx));
        result.put("mode", BackgroundKeepAlivePrefs.getMode(ctx));
        result.put("heartbeatMinutes", BackgroundKeepAlivePrefs.getHeartbeatMinutes(ctx));
        result.put("lastPingAt", BackgroundKeepAlivePrefs.getLastPingAt(ctx));
        result.put("batteryOptIgnored", isBatteryOptIgnored(ctx));
        return result;
    }
}
