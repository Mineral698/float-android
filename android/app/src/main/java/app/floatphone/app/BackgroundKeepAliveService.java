package app.floatphone.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
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
 * 后台常驻保活（用户显式开启）：前台服务按住进程，让 WebView 里的主动消息引擎
 * 在切后台/锁屏期间持续运行。与 GenerationKeepAliveService（单次生成临时保活）互补。
 *
 * 两种模式（JS 侧 lib/background-keepalive.ts 按设置驱动）：
 * - power_saving：不持常驻唤醒锁，由 HeartbeatReceiver 闹钟心跳周期性唤醒 CPU；
 * - realtime：常驻 PARTIAL_WAKE_LOCK + WiFi 锁，引擎秒级实时。
 *
 * 存活检测：JS 引擎每 ~30s 经 BackgroundKeepAlivePlugin.ping() 打一次点；
 * WebView 被销毁（如用户划掉 App）后 ping 停止，本服务超过阈值没等到 ping 就发
 * “点按恢复”全屏通知——服务还活着所以闹钟/通知链路仍然有效，这是规则内能做的极限。
 */
public class BackgroundKeepAliveService extends Service {

    public static final String ACTION_START = "app.floatphone.KEEPALIVE_START";
    public static final String ACTION_STOP = "app.floatphone.KEEPALIVE_STOP";
    public static final String EXTRA_MODE = "mode";               // power_saving | realtime
    public static final String EXTRA_HEARTBEAT_MINUTES = "heartbeatMinutes";

    private static final String TAG = "BackgroundKeepAlive";
    private static final String CHANNEL_ID = "background_keepalive";
    private static final int NOTIFICATION_ID = 4702;
    private static final int RECOVERY_NOTIFICATION_ID = 4703;

    /** JS 引擎 ping 超时下限：轮询 3s/次、30s 一个 ping，留足抖动余量 */
    private static final long PING_TIMEOUT_MIN_MS = 5L * 60 * 1000;
    /** 存活巡检周期 */
    private static final long LIVENESS_CHECK_MS = 60_000;
    /** realtime 模式唤醒锁兜底上限（用户关开关时会正常 stop，这是防滞留保险） */
    private static final long WAKELOCK_FAILSAFE_MS = 24L * 60 * 60 * 1000;

    private static final String PREFS = "background_keepalive";
    public static final String PREF_ENABLED = "enabled";
    public static final String PREF_MODE = "mode";
    public static final String PREF_HEARTBEAT_MINUTES = "heartbeatMinutes";

    /** 供插件与接收器跨实例读写（同进程） */
    private static volatile long lastPingAt = 0L;
    private static volatile boolean serviceRunning = false;
    private static volatile boolean recoveryPosted = false;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private String mode = "power_saving";

    private final Runnable livenessCheck = new Runnable() {
        @Override
        public void run() {
            checkEngineLiveness();
            handler.postDelayed(this, LIVENESS_CHECK_MS);
        }
    };

    public static boolean isRunning() {
        return serviceRunning;
    }

    public static void reportPing() {
        lastPingAt = System.currentTimeMillis();
        recoveryPosted = false;
    }

    public static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                int wifiMode = Build.VERSION.SDK_INT >= 29
                        ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                        : WifiManager.WIFI_MODE_FULL;
                wifiLock = wm.createWifiLock(wifiMode, "float:keepalive");
                wifiLock.setReferenceCounted(false);
            }
        } catch (RuntimeException error) {
            Log.e(TAG, "wifi lock unavailable", error);
            wifiLock = null;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        boolean stopping = intent != null && ACTION_STOP.equals(intent.getAction());
        if (stopping) {
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            createChannels();
            if (intent != null && ACTION_START.equals(intent.getAction())) {
                mode = intent.getStringExtra(EXTRA_MODE);
                if (mode == null || mode.isEmpty()) mode = "power_saving";
                int minutes = intent.getIntExtra(EXTRA_HEARTBEAT_MINUTES, 5);
                SharedPreferences.Editor editor = prefs(this).edit();
                editor.putBoolean(PREF_ENABLED, true);
                editor.putString(PREF_MODE, mode);
                editor.putInt(PREF_HEARTBEAT_MINUTES, minutes);
                editor.apply();
            } else {
                // START_STICKY 被系统拉起：从偏好恢复模式
                mode = prefs(this).getString(PREF_MODE, "power_saving");
            }

            Notification notification = buildRunningNotification();
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }

            boolean realtime = "realtime".equals(mode);
            if (realtime) {
                if (wakeLock == null) {
                    PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                    if (pm != null) {
                        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "float:keepalive");
                        wakeLock.setReferenceCounted(false);
                    }
                }
                if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire(WAKELOCK_FAILSAFE_MS);
            } else if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
            if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();

            lastPingAt = Math.max(lastPingAt, System.currentTimeMillis());
            recoveryPosted = false;
            serviceRunning = true;
            handler.removeCallbacks(livenessCheck);
            handler.postDelayed(livenessCheck, LIVENESS_CHECK_MS);
            return START_STICKY;
        } catch (RuntimeException error) {
            Log.e(TAG, "foreground start failed", error);
            stopSelf();
            return START_NOT_STICKY;
        }
    }

    /**
     * 失联阈值随心跳周期走：省电心跳最长 15 分钟，且 Doze 下被系统限流到
     * 最快约 9 分钟一拍——固定 5 分钟会把“正常间隔”误判成引擎死亡，
     * 导致每个心跳周期都误弹一次“点按恢复”。阈值 = 心跳周期 + 2 分钟缓冲。
     */
    private long pingTimeoutMs() {
        int minutes = prefs(this).getInt(PREF_HEARTBEAT_MINUTES, 5);
        return Math.max(PING_TIMEOUT_MIN_MS, minutes * 60_000L + 2L * 60_000);
    }

    private void checkEngineLiveness() {
        long idleMs = System.currentTimeMillis() - lastPingAt;
        if (idleMs < pingTimeoutMs() || recoveryPosted) return;
        recoveryPosted = true;
        postRecoveryNotification();
    }

    private void postRecoveryNotification() {
        try {
            Intent launch = new Intent(this, MainActivity.class);
            launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pending = PendingIntent.getActivity(
                    this, 4703, launch,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            NotificationCompat.Builder builder = new NotificationCompat.Builder(this, "background_keepalive_recovery")
                    .setSmallIcon(R.drawable.ic_stat_notify)
                    .setContentTitle("主动消息已暂停")
                    .setContentText("点按回到小手机，恢复后台主动消息")
                    .setContentIntent(pending)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_REMINDER)
                    .setAutoCancel(true);
            if (Build.VERSION.SDK_INT >= 29) {
                builder.setFullScreenIntent(pending, true);
            }
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(RECOVERY_NOTIFICATION_ID, builder.build());
        } catch (RuntimeException error) {
            Log.e(TAG, "recovery notification failed", error);
        }
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel running = new NotificationChannel(
                CHANNEL_ID, "后台运行", NotificationManager.IMPORTANCE_MIN);
        running.setDescription("后台保活运行提示（静默）");
        running.setShowBadge(false);
        nm.createNotificationChannel(running);
        NotificationChannel recovery = new NotificationChannel(
                "background_keepalive_recovery", "主动消息恢复提醒", NotificationManager.IMPORTANCE_HIGH);
        recovery.setDescription("引擎在后台失联时的恢复引导");
        recovery.setShowBadge(true);
        nm.createNotificationChannel(recovery);
    }

    private Notification buildRunningNotification() {
        Intent launch = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(
                this, 0, launch,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String text = "realtime".equals(mode)
                ? "后台保活运行中（实时）"
                : "后台保活运行中（省电）";
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(text)
                .setContentIntent(pending)
                .setOngoing(true)
                .setSilent(true)
                .build();
    }

    @Override
    public void onDestroy() {
        serviceRunning = false;
        handler.removeCallbacks(livenessCheck);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
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
