package app.floatphone.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.content.ContextCompat;

/**
 * 省电模式的闹钟心跳：setAndAllowWhileIdle 每 N 分钟唤醒一次 CPU（Doze 深睡下
 * 系统限流最快约 9 分钟一拍），持一把 3 分钟的部分唤醒锁——CPU 醒着，WebView 里
 * 的 JS 引擎自然跑一拍，到点的主动消息照常生成与弹通知。
 *
 * 顺带自愈：服务若被系统悄悄杀掉，就地重启；真正生成时的长时间联网由
 * GenerationKeepAliveService（现有单次生成保活）持锁，与本心跳正好衔接。
 */
public class HeartbeatReceiver extends BroadcastReceiver {

    private static final String TAG = "BackgroundKeepAlive";
    private static final String WAKELOCK_TAG = "float:heartbeat";
    /** 心跳唤醒窗口：覆盖“LLM 回复 → 工具请求 → 下一轮”的完整一拍 */
    private static final long HEARTBEAT_WAKELOCK_MS = 3L * 60 * 1000;

    @Override
    public void onReceive(Context context, Intent intent) {
        SharedPreferencesCompat prefs = new SharedPreferencesCompat(context);
        if (!prefs.enabled()) return;

        // 先排下一拍再干活（one-shot 闹钟的自续）
        HeartbeatScheduler.schedule(context, prefs.heartbeatMinutes());

        try {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                PowerManager.WakeLock lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG);
                lock.setReferenceCounted(false);
                lock.acquire(HEARTBEAT_WAKELOCK_MS);
            }
        } catch (RuntimeException error) {
            Log.e(TAG, "heartbeat wakelock unavailable", error);
        }

        if (!BackgroundKeepAliveService.isRunning()) {
            Intent service = new Intent(context, BackgroundKeepAliveService.class);
            service.setAction(BackgroundKeepAliveService.ACTION_START);
            service.putExtra(BackgroundKeepAliveService.EXTRA_MODE, prefs.mode());
            service.putExtra(BackgroundKeepAliveService.EXTRA_HEARTBEAT_MINUTES, prefs.heartbeatMinutes());
            try {
                ContextCompat.startForegroundService(context, service);
            } catch (RuntimeException error) {
                Log.e(TAG, "heartbeat service restart rejected", error);
            }
        }
    }

    /** 小包装避免 onReceive 里重复读偏好 */
    private static class SharedPreferencesCompat {
        private final android.content.SharedPreferences prefs;
        SharedPreferencesCompat(Context context) {
            prefs = BackgroundKeepAliveService.prefs(context);
        }
        boolean enabled() { return prefs.getBoolean(BackgroundKeepAliveService.PREF_ENABLED, false); }
        String mode() { return prefs.getString(BackgroundKeepAliveService.PREF_MODE, "power_saving"); }
        int heartbeatMinutes() { return prefs.getInt(BackgroundKeepAliveService.PREF_HEARTBEAT_MINUTES, 5); }
    }
}
