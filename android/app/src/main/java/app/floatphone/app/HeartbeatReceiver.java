package app.floatphone.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.core.content.ContextCompat;

/**
 * 心跳广播：先排下一拍 → 拉起常驻服务并让服务持有短唤醒锁。
 * 唤醒锁放在 Service 里持有，避免 Receiver 返回后 WakeLock 对象被 GC 提前释放。
 */
public class HeartbeatReceiver extends BroadcastReceiver {

    private static final String TAG = "BgKeepAliveBeat";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !HeartbeatScheduler.ACTION.equals(intent.getAction())) return;
        if (!BackgroundKeepAlivePrefs.isEnabled(context)) {
            Log.d(TAG, "keepalive disabled, ignore beat");
            return;
        }

        int minutes = BackgroundKeepAlivePrefs.getHeartbeatMinutes(context);
        HeartbeatScheduler.scheduleNext(context, minutes);

        try {
            Intent service = new Intent(context, BackgroundKeepAliveService.class);
            service.putExtra(BackgroundKeepAliveService.EXTRA_HEARTBEAT, true);
            ContextCompat.startForegroundService(context, service);
            Log.d(TAG, "heartbeat → service");
        } catch (RuntimeException error) {
            // Android 12+ 后台起 FGS 可能被拒；Boot/用户点开后会再启
            Log.w(TAG, "start service from beat rejected: " + error.getMessage());
        }
    }
}
