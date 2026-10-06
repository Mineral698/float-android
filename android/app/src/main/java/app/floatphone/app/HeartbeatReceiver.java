package app.floatphone.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.content.ContextCompat;

/**
 * 心跳广播：先排下一拍 → 持约 3 分钟唤醒锁（覆盖一轮 LLM/工具调用）→
 * 若常驻服务被杀则拉起。
 */
public class HeartbeatReceiver extends BroadcastReceiver {

    private static final String TAG = "BgKeepAliveBeat";
    /** 覆盖一轮后台生成（请求 + 工具）的典型时长 */
    private static final long WAKE_MS = 3L * 60_000;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !HeartbeatScheduler.ACTION.equals(intent.getAction())) return;
        if (!BackgroundKeepAlivePrefs.isEnabled(context)) {
            Log.d(TAG, "keepalive disabled, ignore beat");
            return;
        }

        int minutes = BackgroundKeepAlivePrefs.getHeartbeatMinutes(context);
        HeartbeatScheduler.scheduleNext(context, minutes);

        PowerManager.WakeLock beatLock = null;
        try {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                beatLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "float:bg_heartbeat");
                beatLock.setReferenceCounted(false);
                beatLock.acquire(WAKE_MS);
            }
        } catch (RuntimeException error) {
            Log.e(TAG, "beat wake lock failed", error);
        }

        try {
            Intent service = new Intent(context, BackgroundKeepAliveService.class);
            ContextCompat.startForegroundService(context, service);
        } catch (RuntimeException error) {
            // Android 12+ 后台起 FGS 可能被拒；Boot/用户点开后会再启
            Log.w(TAG, "start service from beat rejected: " + error.getMessage());
        }

        // wake lock 会在超时自动释放；不在这里 release，留给 WAKE_MS 覆盖整拍
        if (beatLock != null) {
            // 引用交给系统超时；避免立刻 release 让 CPU 马上睡回去
            Log.d(TAG, "heartbeat wake held up to " + WAKE_MS + "ms");
        }
    }
}
