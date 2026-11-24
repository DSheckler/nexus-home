package se.nexushome.panel;

import android.content.Context;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;

import javax.crypto.Cipher;

/**
 * Cliente mínimo del protocolo ADB por red (el de "adb connect"), para mandar órdenes
 * a la TV Box Android de la casa: teclas, abrir apps y encender/apagar la tele por HDMI-CEC.
 * La primera vez la tele pregunta «¿Permitir la depuración?»: hay que aceptar con el control.
 * La clave RSA de la tablet se genera una vez y se guarda en los archivos privados de la app.
 */
final class AdbClient {
    private static final int A_CNXN = 0x4e584e43, A_AUTH = 0x48545541, A_OPEN = 0x4e45504f,
            A_OKAY = 0x59414b4f, A_CLSE = 0x45534c43, A_WRTE = 0x45545257;
    private static final int VERSION = 0x01000000, MAXDATA = 4096;
    private static final int AUTH_TOKEN = 1, AUTH_SIGNATURE = 2, AUTH_RSAPUBLICKEY = 3;
    // Prefijo DigestInfo de SHA-1: ADB firma el token como si ya fuera un resumen SHA-1
    private static final byte[] SHA1_PREFIX = {0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14};

    private final Context ctx;
    private KeyPair keys;

    AdbClient(Context ctx) { this.ctx = ctx; }

    /** Ejecuta una orden de shell y devuelve lo que imprime. Lanza IOException si no conecta o no está autorizada. */
    synchronized String shell(String host, int port, String command, int timeoutMs) throws Exception {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(host, port), 2500);
            s.setSoTimeout(timeoutMs);
            InputStream in = s.getInputStream();
            OutputStream out = s.getOutputStream();
            DataInputStream din = new DataInputStream(in);
            send(out, A_CNXN, VERSION, MAXDATA, "host::\0".getBytes(StandardCharsets.UTF_8));
            boolean sentSig = false;
            while (true) {
                Msg m = read(din);
                if (m.cmd == A_CNXN) break;
                if (m.cmd != A_AUTH || m.arg0 != AUTH_TOKEN) throw new IOException("Respuesta inesperada de la TV Box");
                if (!sentSig) {
                    send(out, A_AUTH, AUTH_SIGNATURE, 0, sign(m.data));
                    sentSig = true;
                } else {
                    // Clave nueva: la tele muestra «¿Permitir la depuración?» (hasta 60 s para aceptar)
                    send(out, A_AUTH, AUTH_RSAPUBLICKEY, 0, publicKeyBlob());
                    s.setSoTimeout(60000);
                }
            }
            s.setSoTimeout(timeoutMs);
            int local = 1;
            send(out, A_OPEN, local, 0, ("shell:" + command + "\0").getBytes(StandardCharsets.UTF_8));
            ByteArrayOutputStream result = new ByteArrayOutputStream();
            int remote = 0;
            while (true) {
                Msg m = read(din);
                if (m.cmd == A_OKAY) { remote = m.arg0; continue; }
                if (m.cmd == A_WRTE) { result.write(m.data); send(out, A_OKAY, local, m.arg0, new byte[0]); continue; }
                if (m.cmd == A_CLSE) { send(out, A_CLSE, local, remote, new byte[0]); break; }
            }
            return result.toString("UTF-8");
        }
    }

    private static final class Msg { int cmd, arg0, arg1; byte[] data; }

    private static void send(OutputStream out, int cmd, int a0, int a1, byte[] data) throws IOException {
        ByteBuffer b = ByteBuffer.allocate(24 + data.length).order(ByteOrder.LITTLE_ENDIAN);
        int sum = 0;
        for (byte x : data) sum += x & 0xff;
        b.putInt(cmd).putInt(a0).putInt(a1).putInt(data.length).putInt(sum).putInt(cmd ^ 0xffffffff).put(data);
        out.write(b.array());
        out.flush();
    }

    private static Msg read(DataInputStream in) throws IOException {
        byte[] h = new byte[24];
        in.readFully(h);
        ByteBuffer b = ByteBuffer.wrap(h).order(ByteOrder.LITTLE_ENDIAN);
        Msg m = new Msg();
        m.cmd = b.getInt(); m.arg0 = b.getInt(); m.arg1 = b.getInt();
        int len = b.getInt();
        if (len < 0 || len > 1024 * 1024) throw new IOException("Mensaje ADB no válido");
        m.data = new byte[len];
        in.readFully(m.data);
        return m;
    }

    private byte[] sign(byte[] token) throws Exception {
        byte[] msg = new byte[SHA1_PREFIX.length + token.length];
        System.arraycopy(SHA1_PREFIX, 0, msg, 0, SHA1_PREFIX.length);
        System.arraycopy(token, 0, msg, SHA1_PREFIX.length, token.length);
        Cipher c = Cipher.getInstance("RSA/ECB/PKCS1Padding");
        c.init(Cipher.ENCRYPT_MODE, keys().getPrivate());
        return c.doFinal(msg);
    }

    // Clave pública en el formato de Android (mincrypt): n0inv, n y R² mod n en palabras de 32 bits
    private byte[] publicKeyBlob() throws Exception {
        RSAPublicKey pub = (RSAPublicKey) keys().getPublic();
        BigInteger n = pub.getModulus(), r32 = BigInteger.ONE.shiftLeft(32);
        int words = 2048 / 32;
        BigInteger rr = BigInteger.ONE.shiftLeft(2048).modPow(BigInteger.valueOf(2), n);
        BigInteger n0inv = n.remainder(r32).modInverse(r32).negate().mod(r32);
        ByteBuffer b = ByteBuffer.allocate(4 + 4 + words * 4 + words * 4 + 4).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt(words).putInt(n0inv.intValue());
        BigInteger t = n;
        for (int i = 0; i < words; i++) { b.putInt(t.remainder(r32).intValue()); t = t.shiftRight(32); }
        t = rr;
        for (int i = 0; i < words; i++) { b.putInt(t.remainder(r32).intValue()); t = t.shiftRight(32); }
        b.putInt(pub.getPublicExponent().intValue());
        String s = Base64.encodeToString(b.array(), Base64.NO_WRAP) + " nexus@tablet\0";
        return s.getBytes(StandardCharsets.UTF_8);
    }

    private KeyPair keys() throws Exception {
        if (keys != null) return keys;
        File priv = new File(ctx.getFilesDir(), "adbkey"), pub = new File(ctx.getFilesDir(), "adbkey.pub");
        KeyFactory kf = KeyFactory.getInstance("RSA");
        if (priv.exists() && pub.exists()) {
            PrivateKey pk = kf.generatePrivate(new PKCS8EncodedKeySpec(readAll(priv)));
            RSAPublicKey pu = (RSAPublicKey) kf.generatePublic(new X509EncodedKeySpec(readAll(pub)));
            keys = new KeyPair(pu, pk);
            return keys;
        }
        KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
        g.initialize(2048);
        keys = g.generateKeyPair();
        try (FileOutputStream o = new FileOutputStream(priv)) { o.write(keys.getPrivate().getEncoded()); }
        try (FileOutputStream o = new FileOutputStream(pub)) { o.write(keys.getPublic().getEncoded()); }
        return keys;
    }

    private static byte[] readAll(File f) throws IOException {
        try (FileInputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
            return o.toByteArray();
        }
    }
}
