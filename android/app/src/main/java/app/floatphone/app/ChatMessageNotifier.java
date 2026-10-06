package app.floatphone.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * 聊天消息系统通知：高优先级 heads-up，不走 Capacitor LocalNotifications
 * （那个插件 priority 是 DEFAULT、且 setOnlyAlertOnce，国行机上经常只进列表不弹横幅）。
 */
public final class ChatMessageNotifier {

    public static final String EXTRA_SESSION_ID = "chatSessionId";
    /** 新 channel id：旧 channel 一旦以较低 importance 创建，系统不允许再调高 */
    private static final String CHANNEL_ID = "float_chat_messages_v2";
    private static final int PENDING_REQUEST_BASE = 4900;

    private ChatMessageNotifier() {}

    public static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "聊天消息",
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("角色新消息，退到后台时弹出横幅");
        channel.enableVibration(true);
        channel.enableLights(true);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        channel.setShowBadge(true);
        nm.createNotificationChannel(channel);
    }

    public static boolean notificationsEnabled(Context context) {
        return NotificationManagerCompat.from(context).areNotificationsEnabled();
    }

    public static void show(Context context, int id, String title, String body, String sessionId) {
        ensureChannel(context);
        if (!notificationsEnabled(context)) return;

        int safeId = id == 0 ? 4801 : id;
        String safeTitle = title == null || title.isEmpty() ? "新消息" : title;
        String safeBody = body == null || body.isEmpty() ? "发来一条消息" : body;

        Intent launch = new Intent(context, MainActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (sessionId != null && !sessionId.isEmpty()) {
            launch.putExtra(EXTRA_SESSION_ID, sessionId);
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent content = PendingIntent.getActivity(
                context,
                PENDING_REQUEST_BASE + (safeId & 0xfff),
                launch,
                flags
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle(safeTitle)
                .setContentText(safeBody)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(safeBody))
                .setContentIntent(content)
                .setAutoCancel(true)
                .setOnlyAlertOnce(false)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setDefaults(Notification.DEFAULT_ALL);

        NotificationManagerCompat.from(context).notify(safeId, builder.build());
    }

    public static void cancel(Context context, int id) {
        if (id == 0) return;
        NotificationManagerCompat.from(context).cancel(id);
    }
}
