package app.auren;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.HashMap;

/**
 * Full-screen WebView for the wallet and explorer. The pages ship inside the app and are served from the app's own
 * secure address (https://app.auren.im), so the wallet's cryptography works without any local server.
 */
public class ViewActivity extends Activity {
    static final String HOST = "app.auren.im";
    private WebView web;

    private static String type(String p) {
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    private WebResourceResponse asset(String path) {
        if (path.equals("/")) path = "/wallet.html";
        if (path.contains("..")) return null;
        String name = path.equals("/networks.json") ? "networks.json" : "web_" + path.substring(1);
        try {
            InputStream a = getAssets().open(name);
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = a.read(buf)) > 0) bo.write(buf, 0, n);
            a.close();
            WebResourceResponse r = new WebResourceResponse(type(path), "utf-8", new ByteArrayInputStream(bo.toByteArray()));
            HashMap<String, String> h = new HashMap<String, String>();
            h.put("Cache-Control", "no-cache");
            r.setResponseHeaders(h);
            return r;
        } catch (Exception missing) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<String, String>(), new ByteArrayInputStream("not found".getBytes()));
        }
    }

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return asset(u.getPath() == null ? "/" : u.getPath());
                return null;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, String url) {
                Uri u = Uri.parse(url);
                String h = u.getHost();
                if (HOST.equals(h)) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u));
                return true;
            }
        });
        String page = getIntent().getStringExtra("page");
        web.loadUrl("https://" + HOST + "/" + (page != null ? page : "wallet.html"));
    }

    @Override public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
}
