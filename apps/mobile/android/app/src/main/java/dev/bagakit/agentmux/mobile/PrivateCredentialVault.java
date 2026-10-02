package dev.bagakit.agentmux.mobile;

import android.app.KeyguardManager;
import android.content.Context;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import android.util.Base64;

/** Native-only. Keystore holds the non-exportable encryption key; noBackup holds only ciphertext. */
final class PrivateCredentialVault {
    private final Context context;
    PrivateCredentialVault(Context context) { this.context = context; }
    private String binding(String origin, String hostId) { return origin + "\n" + hostId; }
    private String identity(String origin, String hostId) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(binding(origin, hostId).getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder();
        for (byte value : hash) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }
    private void unlocked() throws Exception {
        KeyguardManager lock = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        if (lock == null || lock.isDeviceLocked()) throw new Exception("NATIVE_SECRET_STORE_UNCONFIRMED");
    }
    private SecretKey key(String identity, boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        String alias = "AgentMux.Device.v1." + identity;
        if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
        if (!create) throw new Exception("NATIVE_SECRET_STORE_UNCONFIRMED");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(alias,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true);
        if (Build.VERSION.SDK_INT >= 28) spec.setUnlockedDeviceRequired(true);
        generator.init(spec.build()); return generator.generateKey();
    }
    private AtomicFile file(String identity) { return new AtomicFile(new File(context.getNoBackupFilesDir(), "agentmux-device-" + identity)); }
    synchronized JSONObject read(String origin, String hostId) throws Exception {
        try { return readExisting(origin, hostId); }
        catch (Exception unconfirmed) { throw new Exception("NATIVE_SECRET_STORE_UNCONFIRMED"); }
    }
    private JSONObject readExisting(String origin, String hostId) throws Exception {
        unlocked(); String id = identity(origin, hostId); byte[] encoded;
        try { encoded = file(id).readFully(); }
        catch (FileNotFoundException absent) {
            // FileNotFoundException also includes an inaccessible existing file.
            if (file(id).getBaseFile().exists()) throw absent;
            return null;
        }
        if (encoded.length > 8192) throw new Exception("NATIVE_SECRET_STORE_UNCONFIRMED");
        JSONObject envelope = new JSONObject(new String(encoded, StandardCharsets.UTF_8));
        if (envelope.length() != 2 || !envelope.has("iv") || !envelope.has("ciphertext")) throw new Exception("NATIVE_SECRET_STORE_UNCONFIRMED");
        byte[] iv = Base64.decode(envelope.getString("iv"), Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(id, false), new GCMParameterSpec(128, iv));
        cipher.updateAAD(binding(origin, hostId).getBytes(StandardCharsets.UTF_8));
        JSONObject value = new JSONObject(new String(cipher.doFinal(Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP)), StandardCharsets.UTF_8));
        if (value.length() != 4 || !origin.equals(value.getString("origin")) || !hostId.equals(value.getString("hostId"))
            || value.getString("deviceId").isEmpty() || !value.getString("credential").matches("[A-Za-z0-9_-]{43}")) {
            throw new Exception("NATIVE_SECRET_STORE_UNCONFIRMED");
        }
        return value;
    }
    synchronized void save(String origin, String hostId, JSONObject value) throws Exception {
        unlocked(); String id = identity(origin, hostId);
        AtomicFile file = file(id); boolean original = read(origin, hostId) != null;
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(id, !original));
        cipher.updateAAD(binding(origin, hostId).getBytes(StandardCharsets.UTF_8));
        JSONObject envelope = new JSONObject().put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
        FileOutputStream output = null;
        try {
            output = file.startWrite(); output.write(envelope.toString().getBytes(StandardCharsets.UTF_8)); output.getFD().sync();
            file.finishWrite(output); output = null;
        } finally { if (output != null) file.failWrite(output); }
    }
}
