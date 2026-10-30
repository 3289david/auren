package app.auren;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Foreground service that unpacks the bundled Node.js runtime and AUREN, then runs "auren join". */
public class NodeService extends Service {
    private static volatile Process proc;
    private static volatile boolean starting;
    private PowerManager.WakeLock lock;

    static boolean isRunning() { return starting || (proc != null && isAlive(proc)); }

    private static boolean isAlive(Process p) {
        try { p.exitValue(); return false; } catch (IllegalThreadStateException e) { return true; }
    }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent i, int flags, int id) {
        if (i != null && "stop".equals(i.getAction())) {
            if (proc != null) proc.destroy();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (i == null || isRunning()) return START_STICKY;
        startForeground(1, notification("Starting node…"));
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "auren:node");
        lock.acquire();
        starting = true;
        final String net = i.getStringExtra("network"), peers = i.getStringExtra("peers"), payout = i.getStringExtra("payout");
        final boolean earn = i.getBooleanExtra("earn", false);
        new Thread(new Runnable() { public void run() { runNode(net, peers, earn, payout); } }).start();
        return START_STICKY;
    }

    private Notification notification(String text) {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel("node", "AUREN node", NotificationManager.IMPORTANCE_LOW);
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(ch);
            b = new Notification.Builder(this, "node");
        } else {
            b = new Notification.Builder(this);
        }
        return b.setContentTitle("AUREN node").setContentText(text).setSmallIcon(android.R.drawable.stat_notify_sync).setOngoing(true).build();
    }

    private static String abi() {
        for (String a : Build.SUPPORTED_ABIS) if (a.equals("arm64-v8a") || a.equals("x86_64")) return a;
        throw new IllegalStateException("This phone's processor is not supported (needs 64-bit).");
    }

    private void unzip(String asset, File dest) throws Exception {
        InputStream in = getAssets().open(asset);
        ZipInputStream z = new ZipInputStream(in);
        ZipEntry e;
        byte[] buf = new byte[65536];
        while ((e = z.getNextEntry()) != null) {
            File f = new File(dest, e.getName());
            if (!f.getCanonicalPath().startsWith(dest.getCanonicalPath())) continue;
            if (e.isDirectory()) { f.mkdirs(); continue; }
            f.getParentFile().mkdirs();
            OutputStream o = new FileOutputStream(f);
            int n;
            while ((n = z.read(buf)) > 0) o.write(buf, 0, n);
            o.close();
        }
        z.close();
    }

    private void runNode(String net, String peers, boolean earn, String payout) {
        File logFile = new File(getFilesDir(), "node.log");
        try {
            File usr = new File(getFilesDir(), "usr"), app = new File(getFilesDir(), "app"), stamp = new File(getFilesDir(), "installed");
            String want = String.valueOf(getPackageManager().getPackageInfo(getPackageName(), 0).lastUpdateTime);
            if (!stamp.exists() || !readAll(stamp).equals(want)) {
                deleteTree(usr); deleteTree(app);
                unzip("runtime-" + abi() + ".zip", usr);
                unzip("auren.zip", app);
                new File(usr, "bin/node").setExecutable(true, false);
                FileOutputStream s = new FileOutputStream(stamp);
                s.write(want.getBytes("UTF-8"));
                s.close();
            }
            ArrayList<String> cmd = new ArrayList<String>();
            cmd.add(new File(usr, "bin/node").getAbsolutePath());
            cmd.add(new File(app, "bin/auren.js").getAbsolutePath());
            cmd.add("join"); cmd.add(net);
            cmd.add("--home"); cmd.add(new File(getFilesDir(), "data-" + net).getAbsolutePath());
            cmd.add("--port"); cmd.add("9650");
            if (peers != null && peers.length() > 0) { cmd.add("--peers"); cmd.add(peers); }
            if (earn) { cmd.add("--earn"); if (payout != null && payout.length() > 0) cmd.add(payout); }
            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.environment().put("LD_LIBRARY_PATH", new File(usr, "lib").getAbsolutePath());
            pb.environment().put("HOME", getFilesDir().getAbsolutePath());
            pb.environment().put("TMPDIR", getCacheDir().getAbsolutePath());
            pb.redirectErrorStream(true);
            pb.redirectOutput(logFile);
            proc = pb.start();
            starting = false;
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(1, notification("Running " + net));
            proc.waitFor();
        } catch (Throwable t) {
            try {
                FileOutputStream o = new FileOutputStream(logFile, true);
                o.write(("error: " + t + "\n").getBytes("UTF-8"));
                o.close();
            } catch (Exception ignored) { /* nothing more to do */ }
        } finally {
            starting = false;
            if (lock != null && lock.isHeld()) lock.release();
            stopForeground(true);
            stopSelf();
        }
    }

    private static String readAll(File f) throws Exception {
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        InputStream in = new java.io.FileInputStream(f);
        byte[] b = new byte[256];
        int n;
        while ((n = in.read(b)) > 0) bo.write(b, 0, n);
        in.close();
        return bo.toString("UTF-8");
    }

    private static void deleteTree(File f) {
        File[] k = f.listFiles();
        if (k != null) for (File c : k) deleteTree(c);
        f.delete();
    }

    @Override public void onDestroy() {
        if (proc != null) proc.destroy();
        super.onDestroy();
    }
}
