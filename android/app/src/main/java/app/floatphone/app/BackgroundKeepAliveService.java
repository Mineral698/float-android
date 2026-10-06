package app.floatphone.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * 常驻前台服务：抬高进程优先级，让主动消息引擎在退后台后仍能跑。
 * <ul>
 *   <li>类型用 specialUse（规避 Android 14/15 dataSync 6h/天上限）</li>
 *   <li>START_STICKY：被杀后系统尽量拉回</li>
 *   <li>省电模式：不长期持锁，靠心跳闹钟唤醒；心跳拍内持 3 分钟锁</li>
 *   <li>实时模式：PARTIAL_WAKE_LOCK + WifiLock</li>
 *   <li>引擎失联：JS ping 停 5 分钟 → 「点按恢复」高优通知</li>
 * </ul>
 */
public class BackgroundKeepAliveService extends Service {

    public static final String EXTRA_HEARTBEAT = "heartbeat";

    private static final String TAG = "BgKeepAliveSvc";

    private static final String CHANNEL_ID = "bg_keepalive";
    private static final String ALERT_CHANNEL_ID = "bg_keepalive_alert";
    private static final int NOTIFICATION_ID = 4710;
    private static final int RECOVERY_NOTIFICATION_ID = 4711;

    /** JS 侧 ping 超过此时长未到 → 判定引擎失联 */
    private static final long ENGINE_STALE_MS = 5L * 60_000;
    private static final long STALE_CHECK_INTERVAL_MS = 60_000;
    /** 心跳拍内唤醒，覆盖一轮后台 LLM/工具 */
    private static final long HEARTBEAT_WAKE_MS = 3L * 60_000;
    /** 服务已起但从未收到 ping 时的宽限（开机后等用户打开 App） */
    private static final long NO_PING_GRACE_MS = 10L * 60_000;

    private PowerManager.WakeLock wakeLock;
    private PowerManager.WakeLock heartbeatWakeLock;
    private WifiManager.WifiLock wifiLock;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean recoveryPosted = false;
    private long serviceStartedAt = 0L;

    private final Runnable staleCheck = new Runnable() {
        @Override
        public void run() {
            checkEngineStale();
            handler.postDelayed(this, STALE_CHECK_INTERVAL_MS);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        serviceStartedAt = System.currentTimeMillis();
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "float:bg_keepalive");
                wakeLock.setReferenceCounted(false);
                heartbeatWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "float:bg_heartbeat");
                heartbeatWakeLock.setReferenceCounted(false);
            }
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                int mode = Build.VERSION.SDK_INT >= 29
                        ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                        : WifiManager.WIFI_MODE_FULL;
                wifiLock = wm.createWifiLock(mode, "float:bg_keepalive");
                wifiLock.setReferenceCounted(false);
            }
        } catch (RuntimeException error) {
            Log.e(TAG, "locks unavailable", error);
            wakeLock = null;
            heartbeatWakeLock = null;
            wifiLock = null;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!BackgroundKeepAlivePrefs.isEnabled(this)) {
            Log.d(TAG, "disabled, stopping");
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            createChannels();
            Notification notification = buildOngoingNotification();
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                );
            } else if (Build.VERSION.SDK_INT >= 29) {
                // specialUse 仅 API 34+；低版本用 dataSync（manifest 已声明 specialUse|dataSync）
                startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                );
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            applyModeLocks();
            // 刷新常驻通知文案（模式切换后也会走到这里）
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(NOTIFICATION_ID, buildOngoingNotification());

            if (intent != null && intent.getBooleanExtra(EXTRA_HEARTBEAT, false)) {
                acquireHeartbeatWake();
            }

            handler.removeCallbacks(staleCheck);
            handler.postDelayed(staleCheck, STALE_CHECK_INTERVAL_MS);
            return START_STICKY;
        } catch (RuntimeException error) {
            Log.e(TAG, "foreground start failed", error);
            stopSelf();
            return START_NOT_STICKY;
        }
    }

    private void acquireHeartbeatWake() {
        // 实时模式已有长锁，不必叠心跳锁
        if (BackgroundKeepAlivePrefs.MODE_REALTIME.equals(BackgroundKeepAlivePrefs.getMode(this))) {
            return;
        }
        try {
            if (heartbeatWakeLock != null) {
                // 每次心跳重置超时窗口
                if (heartbeatWakeLock.isHeld()) heartbeatWakeLock.release();
                heartbeatWakeLock.acquire(HEARTBEAT_WAKE_MS);
                Log.d(TAG, "heartbeat wake " + HEARTBEAT_WAKE_MS + "ms");
            }
        } catch (RuntimeException error) {
            Log.e(TAG, "heartbeat wake failed", error);
        }
    }

    private void applyModeLocks() {
        boolean realtime = BackgroundKeepAlivePrefs.MODE_REALTIME.equals(
                BackgroundKeepAlivePrefs.getMode(this)
        );
        try {
            if (realtime) {
                if (wakeLock != null && !wakeLock.isHeld()) {
                    // 实时模式常驻；设长超时防止泄漏时永挂
                    wakeLock.acquire(12L * 60 * 60 * 1000);
                }
                if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
            } else {
                if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
                if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
            }
        } catch (RuntimeException error) {
            Log.e(TAG, "applyModeLocks failed", error);
        }
    }

    private void checkEngineStale() {
        if (!BackgroundKeepAlivePrefs.isEnabled(this)) return;
        long last = BackgroundKeepAlivePrefs.getLastPingAt(this);
        long now = System.currentTimeMillis();
        if (last <= 0) {
            // 开机后服务先起来、用户还没打开 App：给宽限，超时再提醒点按恢复
            if (serviceStartedAt > 0 && now - serviceStartedAt >= NO_PING_GRACE_MS) {
                if (!recoveryPosted) {
                    recoveryPosted = true;
                    postRecoveryNotification();
                }
            }
            return;
        }
        long age = now - last;
        if (age < ENGINE_STALE_MS) {
            recoveryPosted = false;
            return;
        }
        if (recoveryPosted) return;
        recoveryPosted = true;
        postRecoveryNotification();
    }

    private void postRecoveryNotification() {
        createChannels();
        Intent launch = new Intent(this, MainActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(
                this, 1, launch,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, ALERT_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle(getString(R.string.app_name))
                .setContentText("主动消息引擎已暂停，点按恢复")
                .setStyle(new NotificationCompat.BigTextStyle()
                        .bigText("后台 WebView 已失联，主动消息暂时无法生成。点按打开 App 即可恢复。"))
                .setContentIntent(content)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_ALARM);

        // 全屏意图：锁屏时更醒目；无权限时系统会降级为普通 heads-up
        try {
            PendingIntent fullScreen = PendingIntent.getActivity(
                    this, 2, launch,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
            );
            builder.setFullScreenIntent(fullScreen, true);
        } catch (RuntimeException error) {
            Log.w(TAG, "fullScreenIntent unavailable", error);
        }

        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            nm.notify(RECOVERY_NOTIFICATION_ID, builder.build());
        }
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel ongoing = new NotificationChannel(
                CHANNEL_ID, "后台保活", NotificationManager.IMPORTANCE_LOW);
        ongoing.setDescription("保持主动消息引擎在后台可运行");
        ongoing.setShowBadge(false);
        nm.createNotificationChannel(ongoing);

        NotificationChannel alert = new NotificationChannel(
                ALERT_CHANNEL_ID, "保活恢复提醒", NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription("引擎失联时提醒你点按恢复");
        alert.enableVibration(true);
        nm.createNotificationChannel(alert);
    }

    private Notification buildOngoingNotification() {
        Intent launch = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(
                this, 0, launch,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        boolean realtime = BackgroundKeepAlivePrefs.MODE_REALTIME.equals(
                BackgroundKeepAlivePrefs.getMode(this)
        );
        String text = realtime ? "实时保活中（耗电较高）" : "省电保活中（心跳唤醒）";
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(text)
                .setContentIntent(pending)
                .setOngoing(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(staleCheck);
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            if (heartbeatWakeLock != null && heartbeatWakeLock.isHeld()) heartbeatWakeLock.release();
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (RuntimeException error) {
            Log.e(TAG, "release locks failed", error);
        }
        try {
            stopForeground(true);
        } catch (RuntimeException error) {
            Log.e(TAG, "stopForeground failed", error);
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
