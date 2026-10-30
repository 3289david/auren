package app.auren;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.text.InputType;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;

/**
 * Launcher. In the wallet app it starts the bundled wallet. In the node app it shows the node controls:
 * choose a network, optionally earn AUR, start or stop the node, and open the wallet or explorer served by the node.
 */
public class MainActivity extends Activity {
    private final Handler ui = new Handler();
    private TextView status, log;
    private Button toggle;
    private boolean running;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        String mode = "wallet";
        try {
            ApplicationInfo ai = getPackageManager().getApplicationInfo(getPackageName(), PackageManager.GET_META_DATA);
            mode = ai.metaData.getString("auren.mode", "wallet");
        } catch (Exception ignored) { /* default */ }
        if (mode.equals("wallet")) {
            try { Web.start(getAssets()); } catch (Exception e) { /* fixed port busy: ViewActivity falls back */ }
            startActivity(new Intent(this, ViewActivity.class));
            finish();
            return;
        }
        buildNodeUi();
    }

    private int dp(int v) { return (int) (v * getResources().getDisplayMetrics().density); }

    private void buildNodeUi() {
        ScrollView sv = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(24), dp(20), dp(24));
        sv.addView(root);
        setContentView(sv);

        TextView title = new TextView(this);
        title.setText("AUREN node");
        title.setTextSize(26);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);
        TextView sub = new TextView(this);
        sub.setText("Run a full AUREN node on this phone. Keep it plugged in for best results.");
        sub.setPadding(0, dp(4), 0, dp(16));
        root.addView(sub);

        final Spinner net = new Spinner(this);
        net.setAdapter(new ArrayAdapter<String>(this, android.R.layout.simple_spinner_dropdown_item, new String[] { "testnet", "devnet" }));
        root.addView(net);
        final EditText peers = new EditText(this);
        peers.setHint("Peer node URL (optional), e.g. http://192.168.1.20:9650");
        peers.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        root.addView(peers);
        final CheckBox earn = new CheckBox(this);
        earn.setText("Earn AUR (bond this node and prove storage each epoch)");
        earn.setChecked(true);
        root.addView(earn);
        final EditText payout = new EditText(this);
        payout.setHint("Address to receive rewards (empty = the node's own address)");
        root.addView(payout);

        toggle = new Button(this);
        toggle.setText("Start node");
        root.addView(toggle);
        status = new TextView(this);
        status.setText("Stopped");
        status.setPadding(0, dp(12), 0, dp(8));
        root.addView(status);

        Button wallet = new Button(this);
        wallet.setText("Open wallet");
        Button explorer = new Button(this);
        explorer.setText("Open explorer");
        root.addView(wallet);
        root.addView(explorer);
        wallet.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { open("wallet.html"); } });
        explorer.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { open("explorer.html"); } });

        log = new TextView(this);
        log.setTypeface(Typeface.MONOSPACE);
        log.setTextSize(11);
        log.setPadding(0, dp(12), 0, 0);
        root.addView(log);

        toggle.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                Intent i = new Intent(MainActivity.this, NodeService.class);
                if (running) {
                    i.setAction("stop");
                    startService(i);
                } else {
                    i.setAction("start");
                    i.putExtra("network", (String) net.getSelectedItem());
                    i.putExtra("peers", peers.getText().toString().trim());
                    i.putExtra("earn", earn.isChecked());
                    i.putExtra("payout", payout.getText().toString().trim());
                    if (android.os.Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
                }
            }
        });
        poll();
    }

    private void open(String page) {
        Intent i = new Intent(this, ViewActivity.class);
        i.putExtra("url", "http://127.0.0.1:9650/" + page);
        startActivity(i);
    }

    private void poll() {
        new Thread(new Runnable() {
            public void run() {
                String s = null;
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:9650/status").openConnection();
                    c.setConnectTimeout(1500);
                    c.setReadTimeout(1500);
                    InputStream in = c.getInputStream();
                    java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                    org.json.JSONObject j = new org.json.JSONObject(bo.toString("UTF-8"));
                    s = "Running: " + j.optString("chainId") + " · block " + j.optLong("height") + " · " + j.optInt("peers") + " peers" + (j.optBoolean("catchingUp") ? " · catching up" : " · in sync");
                } catch (Exception e) { s = null; }
                final String text = s;
                final String tail = tail(new File(getFilesDir(), "node.log"), 14);
                ui.post(new Runnable() {
                    public void run() {
                        running = text != null || NodeService.isRunning();
                        status.setText(text != null ? text : (NodeService.isRunning() ? "Starting…" : "Stopped"));
                        toggle.setText(running ? "Stop node" : "Start node");
                        log.setText(tail);
                        ui.postDelayed(new Runnable() { public void run() { poll(); } }, 2000);
                    }
                });
            }
        }).start();
    }

    private static String tail(File f, int n) {
        if (!f.exists()) return "";
        ArrayList<String> lines = new ArrayList<String>();
        try {
            BufferedReader r = new BufferedReader(new FileReader(f));
            String l;
            while ((l = r.readLine()) != null) { lines.add(l.length() > 160 ? l.substring(0, 160) : l); if (lines.size() > n) lines.remove(0); }
            r.close();
        } catch (Exception ignored) { /* no log yet */ }
        StringBuilder sb = new StringBuilder();
        for (String s : lines) sb.append(s).append('\n');
        return sb.toString();
    }
}
