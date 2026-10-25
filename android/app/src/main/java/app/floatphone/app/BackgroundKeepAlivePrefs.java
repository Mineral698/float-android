package app.floatphone.app;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 后台保活状态落盘：供 Service / Receiver / Plugin 共用。
 * JS 进程被杀后，开机与心跳仍能读到「用户曾开启保活」。
 */
public final class BackgroundKeepAlivePrefs {

    public static final String PREFS = "float_bg_keepalive";
    public static final String KEY_ENABLED = "enabled";
    public static final String KEY_MODE = "mode";
    public static final String KEY_HEARTBEAT_MINUTES = "heartbeatMinutes";
    public static final String KEY_LAST_PING_AT = "lastPingAt";

    public static final String MODE_POWER_SAVE = "power_save";
    public static final String MODE_REALTIME = "realtime";

    private BackgroundKeepAlivePrefs() {}

    public static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static boolean isEnabled(Context context) {
        return prefs(context).getBoolean(KEY_ENABLED, false);
    }

    public static void setEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_ENABLED, enabled).apply();
    }

    public static String getMode(Context context) {
        String mode = prefs(context).getString(KEY_MODE, MODE_POWER_SAVE);
        return MODE_REALTIME.equals(mode) ? MODE_REALTIME : MODE_POWER_SAVE;
    }

    public static void setMode(Context context, String mode) {
        String safe = MODE_REALTIME.equals(mode) ? MODE_REALTIME : MODE_POWER_SAVE;
        prefs(context).edit().putString(KEY_MODE, safe).apply();
    }

    public static int getHeartbeatMinutes(Context context) {
        int minutes = prefs(context).getInt(KEY_HEARTBEAT_MINUTES, 5);
        if (minutes != 1 && minutes != 5 && minutes != 15) return 5;
        return minutes;
    }

    public static void setHeartbeatMinutes(Context context, int minutes) {
        int safe = (minutes == 1 || minutes == 15) ? minutes : 5;
        prefs(context).edit().putInt(KEY_HEARTBEAT_MINUTES, safe).apply();
    }

    public static long getLastPingAt(Context context) {
        return prefs(context).getLong(KEY_LAST_PING_AT, 0L);
    }

    public static void setLastPingAt(Context context, long at) {
        prefs(context).edit().putLong(KEY_LAST_PING_AT, at).apply();
    }
}
