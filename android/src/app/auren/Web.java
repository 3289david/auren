package app.auren;

import android.content.res.AssetManager;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * Tiny static web server on 127.0.0.1 that serves the wallet and explorer bundled in the app.
 * The wallet needs a secure origin (crypto.subtle), and http://127.0.0.1 is one. The port is fixed so the
 * browser storage that holds the encrypted wallet keeps the same origin between launches.
 */
final class Web {
    static final int PORT = 38787;
    private static ServerSocket server;

    static synchronized int start(final AssetManager am) throws IOException {
        if (server != null && !server.isClosed()) return server.getLocalPort();
        try {
            server = new ServerSocket(PORT, 50, InetAddress.getByName("127.0.0.1"));
        } catch (IOException busy) {
            server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        }
        final ServerSocket ss = server;
        Thread t = new Thread(new Runnable() {
            public void run() {
                while (!ss.isClosed()) {
                    try {
                        final Socket s = ss.accept();
                        new Thread(new Runnable() { public void run() { serve(am, s); } }).start();
                    } catch (IOException e) { return; }
                }
            }
        });
        t.setDaemon(true);
        t.start();
        return ss.getLocalPort();
    }

    private static String type(String p) {
        if (p.endsWith(".html")) return "text/html; charset=utf-8";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    private static void serve(AssetManager am, Socket s) {
        try {
            s.setSoTimeout(10000);
            InputStream in = s.getInputStream();
            ByteArrayOutputStream head = new ByteArrayOutputStream();
            int prev = 0, c;
            while ((c = in.read()) != -1 && head.size() < 16384) {
                head.write(c);
                if (c == '\n' && prev == '\n') break;
                if (c != '\r') prev = c;
            }
            String first = new String(head.toByteArray(), StandardCharsets.ISO_8859_1).split("\r?\n")[0];
            String[] parts = first.split(" ");
            String path = parts.length > 1 ? parts[1] : "/";
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);
            if (path.equals("/")) path = "/wallet.html";
            byte[] body = null;
            if (!path.contains("..")) {
                String asset = path.equals("/networks.json") ? "networks.json" : "web_" + path.substring(1);
                try {
                    InputStream a = am.open(asset);
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = a.read(buf)) > 0) bo.write(buf, 0, n);
                    a.close();
                    body = bo.toByteArray();
                } catch (IOException missing) { body = null; }
            }
            OutputStream out = s.getOutputStream();
            if (body == null) {
                byte[] nf = "not found".getBytes(StandardCharsets.UTF_8);
                out.write(("HTTP/1.1 404 Not Found\r\nContent-Length: " + nf.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
                out.write(nf);
            } else {
                out.write(("HTTP/1.1 200 OK\r\nContent-Type: " + type(path) + "\r\nContent-Length: " + body.length + "\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
                out.write(body);
            }
            out.flush();
            s.close();
        } catch (IOException ignored) {
            try { s.close(); } catch (IOException e) { /* ignore */ }
        }
    }
}
