package se.nexushome.panel;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.util.List;
import org.json.JSONObject;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.BatteryManager;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * NEXUS Home - app de kiosko propia.
 * Muestra el panel a pantalla completa, mantiene la pantalla encendida,
 * permite micrófono y sonido sin toques, y ofrece a la página una pequeña
 * interfaz (window.NexusAndroid) para el brillo y abrir los ajustes de Android.
 */
public class MainActivity extends Activity {

    // build.ps1 cambia este valor por el de android/host.txt (tu Worker de Cloudflare)
    private static final String HOST = "NEXUS_HOST_PLACEHOLDER";
    private static final String HOME_URL = "https://" + HOST + "/";
    private static final int REQ_MIC = 1;
    private static final long RETRY_MS = 15000;

    private FrameLayout root;
    private WebView web;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);   // se ve sobre la pantalla de bloqueo
            setTurnScreenOn(true);
        }
        w.getDecorView().setBackgroundColor(Color.parseColor("#15171a"));

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#15171a"));
        setContentView(root);

        WebView.setWebContentsDebuggingEnabled(true); // mantenimiento desde el PC por USB
        createWebView();
        web.loadUrl(startUrl(getIntent()));

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
        }
    }

    // Vinculación inicial: adb shell am start ... --es pair <clave>
    private String startUrl(Intent intent) {
        String pair = intent != null ? intent.getStringExtra("pair") : null;
        if (pair != null && pair.matches("[a-fA-F0-9]{32,128}")) return HOME_URL + "#token=" + pair;
        return HOME_URL;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#15171a"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // alarmas y voz sin tocar la pantalla
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        // El panel se diseña al 100 %: el tamaño de letra de Android (p. ej. 110 %) lo descuadraba.
        // Solo afecta a NEXUS; el resto de la tablet sigue con su ajuste.
        s.setTextZoom(100);

        web.addJavascriptInterface(new Bridge(), "NexusAndroid");

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // Solo nuestro panel puede usar el micrófono
                Uri origin = request.getOrigin();
                if (origin != null && HOST.equals(origin.getHost())) {
                    runOnUiThread(() -> request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE}));
                } else {
                    request.deny();
                }
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                // No se navega fuera del panel
                return !HOST.equals(req.getUrl().getHost());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) {
                    view.loadData(offlinePage(), "text/html; charset=utf-8", "utf-8");
                    handler.postDelayed(() -> web.loadUrl(HOME_URL), RETRY_MS);
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // Si el motor web se cae (poca memoria), se recrea en lugar de cerrar la app
                root.removeView(web);
                web.destroy();
                createWebView();
                web.loadUrl(HOME_URL);
                return true;
            }
        });

        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    }

    private String offlinePage() {
        return "<html><body style='margin:0;height:100vh;display:flex;align-items:center;justify-content:center;"
                + "background:#15171a;color:#8b9097;font-family:sans-serif;font-size:28px'>"
                + "Sin conexión. Reintentando…</body></html>";
    }

    /** Interfaz para la página: window.NexusAndroid */
    private class Bridge {
        @JavascriptInterface
        public void setBrightness(final float value) {
            // value 0..1; negativo = brillo automático del sistema
            runOnUiThread(() -> {
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                lp.screenBrightness = value < 0 ? WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                        : Math.max(0.01f, Math.min(1f, value));
                getWindow().setAttributes(lp);
            });
        }

        @JavascriptInterface
        public void openSystemSettings() {
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)));
        }

        @JavascriptInterface
        public String version() {
            return "1.6";
        }

        // ---------- Sonido con el reproductor nativo ----------
        // En esta tablet (Android 11 + WebView 140) la salida de audio de la página usa AAudio
        // y se desconecta a los pocos milisegundos de empezar ("device change"): la voz y las
        // alarmas sonaban a trozos. MediaPlayer no tiene ese fallo, así que la página le pasa
        // el audio ya hecho (MP3 o WAV en base64) y aquí se reproduce.
        private final java.util.Map<String, android.media.MediaPlayer> players = new java.util.HashMap<>();
        private int fileSeq = 0;

        @JavascriptInterface
        public boolean playAudio(final String base64, final String id, final float volume) {
            final java.io.File f;
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                f = new java.io.File(getCacheDir(), "snd" + (fileSeq++ % 8));
                try (java.io.FileOutputStream o = new java.io.FileOutputStream(f)) { o.write(data); }
            } catch (Exception e) {
                return false;
            }
            runOnUiThread(() -> {
                android.media.MediaPlayer mp = new android.media.MediaPlayer();
                try {
                    mp.setAudioAttributes(new android.media.AudioAttributes.Builder()
                            .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build());
                    mp.setDataSource(f.getAbsolutePath());
                    float v = Math.max(0f, Math.min(1f, volume));
                    mp.setVolume(v, v);
                    mp.setOnCompletionListener(p -> finish(id, p));
                    mp.setOnErrorListener((p, what, extra) -> { finish(id, p); return true; });
                    mp.prepare();
                    synchronized (players) { players.put(id, mp); }
                    mp.start();
                } catch (Exception e) {
                    mp.release();
                    notifyEnded(id);
                }
            });
            return true;
        }

        private void finish(String id, android.media.MediaPlayer p) {
            synchronized (players) { players.remove(id); }
            try { p.release(); } catch (Exception ignored) { }
            notifyEnded(id);
        }

        private void notifyEnded(String id) {
            String safe = id.replaceAll("[^A-Za-z0-9_-]", "");
            runOnUiThread(() -> web.evaluateJavascript("window.NexusSound&&NexusSound.ended('" + safe + "')", null));
        }

        // ---------- Voz de Android (Google TTS): gratis, sin cuota de Cloudflare ----------
        // speechSynthesis no existe dentro de WebView; los textos largos y la reserva sin cuota
        // usan este motor del sistema.
        private android.speech.tts.TextToSpeech tts;
        private boolean ttsReady = false;

        private void ensureTts() {
            if (tts != null) return;
            tts = new android.speech.tts.TextToSpeech(MainActivity.this, status -> {
                if (status != android.speech.tts.TextToSpeech.SUCCESS) return;
                // Español de Latinoamérica (Chile o EE. UU.); el de España solo si no hay otro
                int r = android.speech.tts.TextToSpeech.LANG_NOT_SUPPORTED;
                for (String[] l : new String[][] { { "es", "CL" }, { "es", "US" }, { "es", "MX" }, { "es", "ES" } }) {
                    r = tts.setLanguage(new java.util.Locale(l[0], l[1]));
                    if (r >= android.speech.tts.TextToSpeech.LANG_AVAILABLE) break;
                }
                ttsReady = r != android.speech.tts.TextToSpeech.LANG_MISSING_DATA && r != android.speech.tts.TextToSpeech.LANG_NOT_SUPPORTED;
                tts.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
                    @Override public void onStart(String id) { }
                    @Override public void onDone(String id) { notifyEnded(id); }
                    @Override public void onError(String id) { notifyEnded(id); }
                    @Override public void onStop(String id, boolean interrupted) { notifyEnded(id); }
                });
            });
        }

        @JavascriptInterface
        public boolean ttsAvailable() {
            runOnUiThread(this::ensureTts);
            return ttsReady;
        }

        @JavascriptInterface
        public boolean speak(final String text, final String id) {
            if (!ttsReady) { runOnUiThread(this::ensureTts); return false; }
            runOnUiThread(() -> {
                Bundle b = new Bundle();
                b.putInt(android.speech.tts.TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC);
                tts.speak(text, android.speech.tts.TextToSpeech.QUEUE_FLUSH, b, id);
            });
            return true;
        }

        @JavascriptInterface
        public void stopAudio() {
            runOnUiThread(() -> {
                if (tts != null) tts.stop();
                java.util.List<String> ids;
                synchronized (players) { ids = new java.util.ArrayList<>(players.keySet()); }
                for (String id : ids) {
                    android.media.MediaPlayer p;
                    synchronized (players) { p = players.remove(id); }
                    if (p == null) continue;
                    try { p.stop(); } catch (Exception ignored) { }
                    try { p.release(); } catch (Exception ignored) { }
                    notifyEnded(id);
                }
            });
        }

        private int savedVolume = -1;

        /** Alarma: sube el volumen multimedia al máximo mientras suena y luego lo devuelve */
        @JavascriptInterface
        public void alarmVolume(boolean loud) {
            AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
            if (am == null) return;
            if (loud) {
                if (savedVolume < 0) savedVolume = am.getStreamVolume(AudioManager.STREAM_MUSIC);
                am.setStreamVolume(AudioManager.STREAM_MUSIC, am.getStreamMaxVolume(AudioManager.STREAM_MUSIC), 0);
            } else if (savedVolume >= 0) {
                am.setStreamVolume(AudioManager.STREAM_MUSIC, savedVolume, 0);
                savedVolume = -1;
            }
        }

        // ---------- Widget de música (MediaSession de Spotify, YouTube...) ----------
        private MediaController activeController() {
            try {
                MediaSessionManager msm = (MediaSessionManager) getSystemService(MEDIA_SESSION_SERVICE);
                List<MediaController> list = msm.getActiveSessions(new ComponentName(MainActivity.this, MediaListener.class));
                MediaController best = null;
                for (MediaController c : list) {
                    PlaybackState st = c.getPlaybackState();
                    if (st != null && st.getState() == PlaybackState.STATE_PLAYING) return c;
                    if (best == null && c.getMetadata() != null) best = c;
                }
                return best;
            } catch (SecurityException e) {
                return null; // sin acceso a notificaciones
            }
        }

        private String artKey = "";
        private String artData = "";

        /** {"available":bool,"app","title","artist","playing","art"} ; art solo cambia con la canción */
        @JavascriptInterface
        public String mediaInfo() {
            JSONObject o = new JSONObject();
            try {
                MediaController c = activeController();
                if (c == null || c.getMetadata() == null) return o.put("available", false).toString();
                MediaMetadata md = c.getMetadata();
                PlaybackState st = c.getPlaybackState();
                String title = md.getString(MediaMetadata.METADATA_KEY_TITLE);
                String artist = md.getString(MediaMetadata.METADATA_KEY_ARTIST);
                if (artist == null) artist = md.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST);
                String key = c.getPackageName() + "|" + title;
                if (!key.equals(artKey)) {
                    artKey = key;
                    artData = "";
                    Bitmap bmp = md.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART);
                    if (bmp == null) bmp = md.getBitmap(MediaMetadata.METADATA_KEY_ART);
                    if (bmp != null) {
                        Bitmap small = Bitmap.createScaledBitmap(bmp, 192, 192 * bmp.getHeight() / Math.max(1, bmp.getWidth()), true);
                        ByteArrayOutputStream out = new ByteArrayOutputStream();
                        small.compress(Bitmap.CompressFormat.JPEG, 80, out);
                        artData = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
                    }
                }
                o.put("available", true)
                        .put("app", c.getPackageName())
                        .put("title", title == null ? "" : title)
                        .put("artist", artist == null ? "" : artist)
                        .put("playing", st != null && st.getState() == PlaybackState.STATE_PLAYING)
                        .put("artKey", artKey.hashCode());
                return o.toString();
            } catch (Exception e) {
                return "{\"available\":false}";
            }
        }

        @JavascriptInterface
        public String mediaArt() {
            return artData;
        }

        @JavascriptInterface
        public boolean mediaControl(String action) {
            MediaController c = activeController();
            if (c == null) return false;
            MediaController.TransportControls t = c.getTransportControls();
            switch (action) {
                case "play": t.play(); break;
                case "pause": t.pause(); break;
                case "next": t.skipToNext(); break;
                case "prev": t.skipToPrevious(); break;
                default: return false;
            }
            return true;
        }

        /** ¿Tiene NEXUS el acceso necesario para el widget de música? */
        @JavascriptInterface
        public boolean mediaAccess() {
            String flat = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
            return flat != null && flat.contains(getPackageName());
        }

        /** Abre otra app (Spotify, YouTube) con un enlace; el botón de inicio vuelve a NEXUS */
        @JavascriptInterface
        public boolean openApp(String pkg, String uri) {
            if (!"com.spotify.music".equals(pkg) && !"com.google.android.youtube".equals(pkg)) return false;
            try {
                Intent i = uri != null && !uri.isEmpty()
                        ? new Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setPackage(pkg)
                        : getPackageManager().getLaunchIntentForPackage(pkg);
                if (i == null) return false;
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        /** Batería y Wi-Fi para los iconos del panel (JSON) */
        @JavascriptInterface
        public String status() {
            Intent b = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            int level = -1, plugged = 0, st = -1;
            if (b != null) {
                int raw = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
                level = raw >= 0 && scale > 0 ? Math.round(raw * 100f / scale) : -1;
                plugged = b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
                st = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            }
            boolean charging = st == BatteryManager.BATTERY_STATUS_CHARGING;
            // Conexión real por ConnectivityManager (sin permiso de ubicación);
            // la intensidad (RSSI) sí la da WifiManager.
            boolean wifi = false;
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm != null) {
                NetworkCapabilities nc = cm.getNetworkCapabilities(cm.getActiveNetwork());
                wifi = nc != null && nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                        && nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            }
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            WifiInfo wi = wm != null ? wm.getConnectionInfo() : null;
            int rssi = wi != null ? wi.getRssi() : -127;
            int bars = wifi ? (rssi > -127 ? Math.max(1, WifiManager.calculateSignalLevel(rssi, 5)) : 4) : 0;
            return "{\"battery\":" + level + ",\"plugged\":" + (plugged != 0) + ",\"charging\":" + charging
                    + ",\"wifi\":" + wifi + ",\"bars\":" + bars + "}";
        }
    }

    // ---------- pantalla completa inmersiva ----------
    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                getWindow().setDecorFitsSystemWindows(false);
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideSystemBars();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        // El panel sigue vivo (alarmas, escucha) aunque se abran los ajustes encima
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String url = startUrl(intent);
        if (!url.equals(HOME_URL)) web.loadUrl(url); // nueva vinculación
    }

    @Override
    public void onBackPressed() {
        // Ignorado: el botón Atrás no saca del panel
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code == REQ_MIC) web.reload();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
