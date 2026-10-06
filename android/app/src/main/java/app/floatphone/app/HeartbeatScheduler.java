package app.floatphone.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * 省电模式的心跳闹钟：one-shot setAndAllowWhileIdle（Doze 下也能触发，系统限流
 * 最快约 9 分钟一拍），由 HeartbeatReceiver 在每拍开头自续下一拍。
 * 选 inexact + allowIdle 而不是精确闹钟：免 SCHEDULE_EXACT_ALARM 特批权限，
 * 对“几分钟粒度的消息检查”精度足够。
 */
public final class HeartbeatScheduler {

    private static final int REQUEST_CODE = 1001;

    private HeartbeatScheduler() {
    }

    public static void schedule(Context context, int heartbeatMinutes) {
        int minutes = Math.max(1, Math.min(15, heartbeatMinutes));
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        long triggerAt = System.currentTimeMillis() + minutes * 60_000L;
        try {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent(context));
        } catch (RuntimeException error) {
            // 某些 ROM 对 allowWhileIdle 有限制，降级为普通唤醒闹钟
            try {
                am.set(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent(context));
            } catch (RuntimeException ignored) {
            }
        }
    }

    public static void cancel(Context context) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        am.cancel(pendingIntent(context));
    }

    private static PendingIntent pendingIntent(Context context) {
        Intent intent = new Intent(context, HeartbeatReceiver.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(context, REQUEST_CODE, intent, flags);
    }
}
