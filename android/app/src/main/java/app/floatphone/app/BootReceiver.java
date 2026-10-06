package app.floatphone.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.core.content.ContextCompat;

/**
 * 开机自恢复：重启后闹钟全部被系统清空，这里按用户保活设置重新排上心跳，
 * 并把前台服务拉起来（进程活着 → 服务内的引擎失联检测会引导用户点开 App
 * 重建 WebView）。无法静默运行引擎——WebView 必须由 Activity 创建，系统底线。
 */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "BackgroundKeepAlive";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        try {
            SharedPreferences prefs = BackgroundKeepAliveService.prefs(context);
            if (!prefs.getBoolean(BackgroundKeepAliveService.PREF_ENABLED, false)) return;

            HeartbeatScheduler.schedule(context, prefs.getInt(BackgroundKeepAliveService.PREF_HEARTBEAT_MINUTES, 5));

            Intent service = new Intent(context, BackgroundKeepAliveService.class);
            service.setAction(BackgroundKeepAliveService.ACTION_START);
            service.putExtra(BackgroundKeepAliveService.EXTRA_MODE,
                    prefs.getString(BackgroundKeepAliveService.PREF_MODE, "power_saving"));
            service.putExtra(BackgroundKeepAliveService.EXTRA_HEARTBEAT_MINUTES,
                    prefs.getInt(BackgroundKeepAliveService.PREF_HEARTBEAT_MINUTES, 5));
            ContextCompat.startForegroundService(context, service);
        } catch (RuntimeException error) {
            Log.e(TAG, "boot restore failed", error);
        }
    }
}
