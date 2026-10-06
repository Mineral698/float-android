package app.floatphone.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * 后台保活心跳闹钟：用 setAndAllowWhileIdle 的 one-shot 自续，
 * 不需要 SCHEDULE_EXACT_ALARM。Doze 下系统限流最快约 9 分钟一拍。
 */
public final class HeartbeatScheduler {

    public static final String ACTION = "app.floatphone.app.ACTION_BG_KEEPALIVE_HEARTBEAT";
    private static final String TAG = "BgKeepAliveSched";
    private static final int REQUEST_CODE = 4720;

    private HeartbeatScheduler() {}

    public static void scheduleNext(Context context, int minutes) {
        int safeMinutes = minutes <= 0 ? 5 : minutes;
        long triggerAt = System.currentTimeMillis() + safeMinutes * 60_000L;
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            Log.w(TAG, "AlarmManager unavailable");
            return;
        }
        PendingIntent pi = pendingIntent(context);
        try {
            if (Build.VERSION.SDK_INT >= 23) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi);
            } else {
                am.set(AlarmManager.RTC_WAKEUP, triggerAt, pi);
            }
            Log.d(TAG, "next heartbeat in " + safeMinutes + " min");
        } catch (RuntimeException error) {
            Log.e(TAG, "schedule failed", error);
        }
    }

    public static void cancel(Context context) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        try {
            am.cancel(pendingIntent(context));
        } catch (RuntimeException error) {
            Log.e(TAG, "cancel failed", error);
        }
    }

    private static PendingIntent pendingIntent(Context context) {
        Intent intent = new Intent(context, HeartbeatReceiver.class);
        intent.setAction(ACTION);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(context, REQUEST_CODE, intent, flags);
    }
}
