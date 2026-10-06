package app.floatphone.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.PowerManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 后台常驻保活的 JS 入口（lib/background-keepalive.ts）：
 * start/stop 由设置页驱动；ping 由 follow-up-service 轮询周期性调用，
 * 服务侧据此判断 WebView 是否还活着（死亡 → “点按恢复”通知）。
 * 启停状态同时落 SharedPreferences，BootReceiver 开机后据此恢复。
 */
@CapacitorPlugin(name = "BackgroundKeepAlive")
public class BackgroundKeepAlivePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String mode = call.getString("mode", "power_saving");
        if (!"realtime".equals(mode)) mode = "power_saving";
        int heartbeatMinutes = call.getInt("heartbeatMinutes", 5);

        Context context = getContext();
        SharedPreferences.Editor editor = BackgroundKeepAliveService.prefs(context).edit();
        editor.putBoolean(BackgroundKeepAliveService.PREF_ENABLED, true);
        editor.putString(BackgroundKeepAliveService.PREF_MODE, mode);
        editor.putInt(BackgroundKeepAliveService.PREF_HEARTBEAT_MINUTES, heartbeatMinutes);
        editor.apply();

        if ("power_saving".equals(mode)) {
            HeartbeatScheduler.schedule(context, heartbeatMinutes);
        } else {
            HeartbeatScheduler.cancel(context);
        }

        Intent service = new Intent(context, BackgroundKeepAliveService.class);
        service.setAction(BackgroundKeepAliveService.ACTION_START);
        service.putExtra(BackgroundKeepAliveService.EXTRA_MODE, mode);
        service.putExtra(BackgroundKeepAliveService.EXTRA_HEARTBEAT_MINUTES, heartbeatMinutes);
        boolean started = true;
        try {
            ContextCompat.startForegroundService(context, service);
        } catch (RuntimeException e) {
            // 前台服务启动被拒（极端时序）：保活降级，闹钟心跳仍有效
            started = false;
        }
        JSObject result = new JSObject();
        result.put("running", started);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context context = getContext();
        BackgroundKeepAliveService.prefs(context).edit()
                .putBoolean(BackgroundKeepAliveService.PREF_ENABLED, false)
                .apply();
        HeartbeatScheduler.cancel(context);
        Intent service = new Intent(context, BackgroundKeepAliveService.class);
        service.setAction(BackgroundKeepAliveService.ACTION_STOP);
        try {
            context.startService(service);
        } catch (RuntimeException ignored) {
            // 服务可能本来就没在跑
        }
        JSObject result = new JSObject();
        result.put("running", false);
        call.resolve(result);
    }

    @PluginMethod
    public void ping(PluginCall call) {
        BackgroundKeepAliveService.reportPing();
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("running", BackgroundKeepAliveService.isRunning());
        call.resolve(result);
    }

    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ignoring", ignoring(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        Context context = getContext();
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    android.net.Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (RuntimeException ignored) {
            // 个别 ROM 裁剪了该入口：用户只能到系统电池设置手动豁免
        }
        JSObject result = new JSObject();
        result.put("ignoring", ignoring(context));
        call.resolve(result);
    }

    private static boolean ignoring(Context context) {
        try {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(context.getPackageName());
        } catch (RuntimeException error) {
            return false;
        }
    }
}
