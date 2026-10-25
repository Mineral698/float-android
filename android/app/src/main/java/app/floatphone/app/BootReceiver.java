package app.floatphone.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.core.content.ContextCompat;

/**
 * 开机恢复：若用户此前开启了后台保活，重排心跳闹钟并拉起常驻服务。
 */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "BgKeepAliveBoot";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !"android.intent.action.LOCKED_BOOT_COMPLETED".equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }
        if (!BackgroundKeepAlivePrefs.isEnabled(context)) {
            Log.d(TAG, "keepalive off, skip boot restore");
            return;
        }
        int minutes = BackgroundKeepAlivePrefs.getHeartbeatMinutes(context);
        HeartbeatScheduler.scheduleNext(context, minutes);
        try {
            Intent service = new Intent(context, BackgroundKeepAliveService.class);
            ContextCompat.startForegroundService(context, service);
            Log.d(TAG, "restored keepalive after " + action);
        } catch (RuntimeException error) {
            Log.w(TAG, "boot start service rejected: " + error.getMessage());
        }
    }
}
