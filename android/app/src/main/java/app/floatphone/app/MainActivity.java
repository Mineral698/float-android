package app.floatphone.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 麦克风/相机权限不在启动时申请——由 MediaPermissionsPlugin
        // 在对应功能（语音输入/视频通话/自定义 App 录音）被使用时按需拉起。
        registerPlugin(MediaPermissionsPlugin.class);
        // 生成保活：长时间 LLM/生图请求期间拉起前台服务，退后台不被挂起
        registerPlugin(GenerationKeepAlivePlugin.class);
        // 原生 HTTP：LLM 等长连接/流式请求由 OkHttp 承载，绕开 WebView fetch
        registerPlugin(NativeHttpPlugin.class);
        // 原生媒体存储：图片/音视频字节落文件系统，显示走 _capacitor_file_ 不占 JS 堆
        registerPlugin(NativeMediaPlugin.class);
        // 公共 Documents 写入权限桥：MANAGE_EXTERNAL_STORAGE 只能弹设置页引导
        registerPlugin(StorageAccessPlugin.class);
        // 应用自更新：GitHub Release APK 原生下载（断点续传）+ 拉起系统安装器
        registerPlugin(AppUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
        // 免疫系统字体缩放：WebView textZoom 会跟随系统 FONT_SCALE，
        // 大字体会把这台「虚拟手机」的整版 UI 文字放大打乱布局。
        // 应用内有自己的文字缩放设置，不需要系统层再叠一层。
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().getSettings().setTextZoom(100);
        }
    }
}
