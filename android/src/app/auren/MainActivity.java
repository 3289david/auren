package app.auren;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.util.ArrayList;

/**
 * Launcher. In the wallet app it opens the bundled wallet. In the node app it shows a simple control screen:
 * pick a network, choose whether to earn AUR, start or stop the node, and open the wallet or explorer.
 */
public class MainActivity extends Activity {
    private static final int BG = Color.parseColor("#F7F7F5");
    private static final int INK = Color.parseColor("#16161A");
    private static final int MUTED = Color.parseColor("#6B6B73");
    private static final int LINE = Color.parseColor("#E6E6E1");
    private static final int ACCENT = Color.parseColor("#9A7410");
    private static final int OK = Color.parseColor("#167A55");
    private static final int BAD = Color.parseColor("#B8332F");

    private final Handler ui = new Handler();
    private TextView statusText, statusSub, log;
    private View dot;
    private Button toggle, netTest, netDev;
    private boolean running;
    private String network = "testnet";

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        String mode = "wallet";
        try {
            ApplicationInfo ai = getPackageManager().getApplicationInfo(getPackageName(), PackageManager.GET_META_DATA);
            mode = ai.metaData.getString("auren.mode", "wallet");
        } catch (Exception ignored) { /* default */ }
        if (mode.equals("wallet")) {
            startActivity(new Intent(this, ViewActivity.class));
            finish();
            return;
        }
        buildNodeUi();
    }

    private int dp(int v) { return (int) (v * getResources().getDisplayMetrics().density); }

    private GradientDrawable box(int fill, int stroke, int radiusDp) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(radiusDp));
        if (stroke != 0) g.setStroke(dp(1), stroke);
        return g;
    }

    private LinearLayout card() {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        c.setBackground(box(Color.WHITE, LINE, 14));
        c.setPadding(dp(18), dp(16), dp(18), dp(16));
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.bottomMargin = dp(14);
        c.setLayoutParams(p);
        return c;
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private Button button(String label, boolean primary) {
        Button bt = new Button(this);
        bt.setText(label);
        bt.setAllCaps(false);
        bt.setTextSize(16);
        bt.setTypeface(Typeface.DEFAULT_BOLD);
        bt.setTextColor(primary ? Color.WHITE : INK);
        bt.setBackground(primary ? box(INK, 0, 12) : box(Color.WHITE, LINE, 12));
        bt.setStateListAnimator(null);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        p.bottomMargin = dp(10);
        bt.setLayoutParams(p);
        return bt;
    }

    private void styleSegment(Button on, Button off) {
        on.setBackground(box(INK, 0, 10)); on.setTextColor(Color.WHITE);
        off.setBackground(box(Color.WHITE, LINE, 10)); off.setTextColor(INK);
    }

    private void buildNodeUi() {
        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(BG);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(28), dp(20), dp(28));
        sv.addView(root);
        setContentView(sv);

        TextView brand = text("AUREN", 13, ACCENT, true);
        brand.setLetterSpacing(0.2f);
        root.addView(brand);
        TextView title = text("Run a node", 30, INK, true);
        root.addView(title);
        TextView sub = text("Help keep the network running, and earn AUR while you do.", 15, MUTED, false);
        sub.setPadding(0, dp(4), 0, dp(20));
        root.addView(sub);

        // status card
        LinearLayout st = card();
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        dot = new View(this);
        dot.setLayoutParams(new LinearLayout.LayoutParams(dp(12), dp(12)));
        dot.setBackground(box(MUTED, 0, 6));
        row.addView(dot);
        statusText = text("Stopped", 22, INK, true);
        statusText.setPadding(dp(12), 0, 0, 0);
        row.addView(statusText);
        st.addView(row);
        statusSub = text("Choose a network and press Start.", 14, MUTED, false);
        statusSub.setPadding(0, dp(6), 0, 0);
        st.addView(statusSub);
        root.addView(st);

        // settings card
        LinearLayout set = card();
        set.addView(text("Network", 13, MUTED, true));
        LinearLayout seg = new LinearLayout(this);
        seg.setOrientation(LinearLayout.HORIZONTAL);
        seg.setPadding(0, dp(8), 0, dp(14));
        netTest = new Button(this); netDev = new Button(this);
        for (Button x : new Button[] { netTest, netDev }) {
            x.setAllCaps(false); x.setTextSize(15); x.setStateListAnimator(null);
            LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, dp(46), 1f);
            p.rightMargin = dp(8);
            x.setLayoutParams(p);
        }
        netTest.setText("Testnet"); netDev.setText("Devnet");
        styleSegment(netTest, netDev);
        netTest.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { network = "testnet"; styleSegment(netTest, netDev); } });
        netDev.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { network = "devnet"; styleSegment(netDev, netTest); } });
        seg.addView(netTest); seg.addView(netDev);
        set.addView(seg);

        final Switch earn = new Switch(this);
        earn.setText("Earn AUR");
        earn.setTextSize(16);
        earn.setTextColor(INK);
        earn.setChecked(true);
        set.addView(earn);
        TextView earnNote = text("Locks a small deposit and shares a pool of new AUR with nodes that store the chain.", 13, MUTED, false);
        earnNote.setPadding(0, dp(4), 0, dp(10));
        set.addView(earnNote);
        final EditText payout = new EditText(this);
        payout.setHint("Address for rewards (optional)");
        payout.setTextSize(15);
        payout.setSingleLine(true);
        payout.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        payout.setBackground(box(BG, LINE, 10));
        payout.setPadding(dp(12), dp(10), dp(12), dp(10));
        set.addView(payout);
        root.addView(set);

        toggle = button("Start node", true);
        root.addView(toggle);
        Button wallet = button("Open wallet", false);
        Button explorer = button("Open explorer", false);
        root.addView(wallet);
        root.addView(explorer);
        wallet.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { open("wallet.html"); } });
        explorer.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { open("explorer.html"); } });

        // details
        LinearLayout det = card();
        TextView dh = text("Details", 13, MUTED, true);
        det.addView(dh);
        log = new TextView(this);
        log.setTypeface(Typeface.MONOSPACE);
        log.setTextSize(10.5f);
        log.setTextColor(MUTED);
        log.setPadding(0, dp(8), 0, 0);
        det.addView(log);
        root.addView(det);

        toggle.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                Intent i = new Intent(MainActivity.this, NodeService.class);
                if (running) {
                    i.setAction("stop");
                    startService(i);
                } else {
                    i.setAction("start");
                    i.putExtra("network", network);
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
        i.putExtra("page", page);
        startActivity(i);
    }

    private void poll() {
        new Thread(new Runnable() {
            public void run() {
                final String tail = tail(new File(getFilesDir(), "node.log"), 12);
                String last = null;
                boolean earning = false;
                for (String line : tail.split("\n")) {
                    int at = line.indexOf(" block ");
                    if (at >= 0) last = line.substring(at + 7).split(" ")[0];
                    if (line.contains("node rewards")) earning = true;
                }
                final boolean on = NodeService.isRunning();
                final String blockNo = last;
                final boolean earn = earning;
                ui.post(new Runnable() {
                    public void run() {
                        running = on;
                        statusText.setText(!on ? "Stopped" : (blockNo != null ? "Running" : "Starting…"));
                        dot.setBackground(box(!on ? MUTED : (blockNo != null ? OK : ACCENT), 0, 6));
                        statusSub.setText(!on ? "Choose a network and press Start." : (blockNo != null ? "Block " + blockNo + (earn ? "  ·  earning AUR" : "") : "Connecting to the network…"));
                        toggle.setText(on ? "Stop node" : "Start node");
                        toggle.setBackground(on ? box(Color.WHITE, BAD, 12) : box(INK, 0, 12));
                        toggle.setTextColor(on ? BAD : Color.WHITE);
                        log.setText(tail.length() == 0 ? "Nothing yet." : tail);
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
            while ((l = r.readLine()) != null) { lines.add(l.length() > 110 ? l.substring(0, 110) : l); if (lines.size() > n) lines.remove(0); }
            r.close();
        } catch (Exception ignored) { /* no log yet */ }
        StringBuilder sb = new StringBuilder();
        for (String s : lines) sb.append(s).append('\n');
        return sb.toString();
    }
}
