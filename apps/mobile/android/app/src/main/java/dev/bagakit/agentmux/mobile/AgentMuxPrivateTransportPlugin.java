package dev.bagakit.agentmux.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import android.util.Base64;
import org.json.JSONObject;
import java.io.InputStream;
import java.net.URI;
import okhttp3.Call;
import okhttp3.CookieJar;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.io.ByteArrayOutputStream;

@CapacitorPlugin(name = "AgentMuxPrivateTransport")
public class AgentMuxPrivateTransportPlugin extends Plugin {
    private static final String DEVICE = "/_agentmux/device";
    private static final class Operation {
        volatile Call call;
        volatile Response response;
        volatile InputStream body;
        volatile boolean cancelled;
        final java.util.concurrent.atomic.AtomicBoolean reading = new java.util.concurrent.atomic.AtomicBoolean();
        final ExecutorService reader = Executors.newSingleThreadExecutor();
        void close() {
            cancelled = true;
            if (call != null) call.cancel();
            if (response != null) response.close();
            if (body != null) try { body.close(); } catch (Exception ignored) {}
            reader.shutdownNow();
        }
    }
    private static final class Pending {
        final String deviceId, claim;
        boolean unknown;
        JSONObject credential, approved;
        Pending(String deviceId, String claim) { this.deviceId = deviceId; this.claim = claim; }
    }
    private final Map<String, Operation> requests = new ConcurrentHashMap<>();
    private final Map<String, Pending> pending = new HashMap<>();
    private final java.util.Set<String> busy = new java.util.HashSet<>();
    private final ExecutorService network = Executors.newFixedThreadPool(4);
    private PrivateCredentialVault vault;
    private OkHttpClient http;
    @Override public void load() {
        vault = new PrivateCredentialVault(getContext());
        // Isolated cookie policy: Capacitor installs a process-global CookieHandler.
        http = new OkHttpClient.Builder().cookieJar(CookieJar.NO_COOKIES)
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build();
    }
    private String text(String value, int limit) throws Exception {
        if (value == null || value.isEmpty() || value.length() > limit || value.contains("\r") || value.contains("\n")) throw new Exception("NATIVE_CONNECTION_UNCONFIRMED");
        return value;
    }
    private String origin(PluginCall call) throws Exception {
        String value = text(call.getString("origin"), 1024); URI uri = new URI(value);
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null
            || uri.getRawFragment() != null || (uri.getRawPath() != null && !uri.getRawPath().isEmpty()) || uri.getPort() == 443) throw new Exception("NATIVE_CONNECTION_UNCONFIRMED");
        return value;
    }
    private synchronized Operation reserve(String id) throws Exception {
        text(id, 160); Operation operation = new Operation();
        if (requests.size() >= 32 || requests.putIfAbsent(id, operation) != null) {
            operation.close(); throw new Exception("NATIVE_CONNECTION_UNCONFIRMED");
        }
        return operation;
    }
    private boolean forbidden(String name) {
        String key = name.toLowerCase(java.util.Locale.ROOT);
        return key.matches("authorization|proxy-authorization|cookie|origin|host|x-agentmux-transport") || key.startsWith("sec-fetch-");
    }
    private Response connection(String origin, String path, String method, JSONObject headers,
                                          String hostId, byte[] body, Operation operation) throws Exception {
        URI base = new URI(origin), uri = new URI(origin + path).normalize();
        if (!path.startsWith("/") || path.startsWith("//") || !base.getRawAuthority().equals(uri.getRawAuthority())
            || !"https".equals(uri.getScheme()) || uri.getRawUserInfo() != null || uri.getRawFragment() != null) throw new Exception("NATIVE_CONNECTION_UNCONFIRMED");
        if (uri.getPath().contains("\\")) throw new Exception("NATIVE_CONNECTION_UNCONFIRMED");
        for (String segment : uri.getPath().split("/")) {
            if (segment.equals(".") || segment.equals("..")) throw new Exception("NATIVE_CONNECTION_UNCONFIRMED");
        }
        // Never replace the default platform TrustManager or HostnameVerifier.
        Request.Builder request = new Request.Builder().url(uri.toURL());
        for (Iterator<String> keys = headers.keys(); keys.hasNext();) {
            String name = keys.next(), value = headers.getString(name);
            if (forbidden(name) || value.contains("\r") || value.contains("\n")) throw new Exception("NATIVE_CONNECTION_UNCONFIRMED");
            request.header(name, value);
        }
        request.header("X-AgentMux-Transport", "native");
        if (hostId != null) {
            JSONObject credential = vault.read(origin, hostId);
            if (credential == null) throw new Exception("NATIVE_DEVICE_UNAPPROVED");
            request.header("Authorization", "AgentMuxDevice " + hostId + "." + credential.getString("credential"));
        }
        if (operation.cancelled) throw new Exception("NATIVE_CONNECTION_UNCONFIRMED");
        request.method(method, body == null ? null : RequestBody.create(body, (MediaType) null));
        operation.call = http.newCall(request.build());
        if (operation.cancelled) { operation.call.cancel(); throw new Exception("NATIVE_CONNECTION_UNCONFIRMED"); }
        Response response = operation.call.execute(); operation.response = response;
        int status = response.code();
        if (status >= 300 && status < 400) throw new Exception("NATIVE_CONNECTION_UNCONFIRMED");
        if (operation.cancelled) throw new Exception("NATIVE_CONNECTION_UNCONFIRMED");
        operation.body = response.body().byteStream();
        return response;
    }
    private void reject(PluginCall call, Exception error) {
        String code = "NATIVE_SECRET_STORE_UNCONFIRMED".equals(error.getMessage()) ? error.getMessage()
            : "NATIVE_CLAIM_UNCONFIRMED".equals(error.getMessage()) || "NATIVE_DEVICE_UNAPPROVED".equals(error.getMessage()) ? error.getMessage() : "NATIVE_CONNECTION_UNCONFIRMED";
        call.reject(code.equals("NATIVE_DEVICE_UNAPPROVED") ? "This device has no saved authorization for this Mac. Confirm a new local invitation; existing Sessions are retained."
            : code.equals("NATIVE_CLAIM_UNCONFIRMED") ? "The one-time claim result is unknown and has not been resent. Use a new local invitation; existing Sessions are retained."
            : code.equals("NATIVE_SECRET_STORE_UNCONFIRMED") ? "System credential storage is unconfirmed. Unlock this device and retry saving; the original identity is retained."
            : "This private connection is unconfirmed. Check system certificate trust, Mac address and device approval; existing Sessions are retained.", code);
    }
    private void close(String id, Operation operation) { requests.remove(id, operation); operation.close(); }
    @PluginMethod public void open(PluginCall call) {
        final String id = call.getString("requestId"); final Operation operation;
        try { operation = reserve(id); } catch (Exception error) { reject(call, error); return; }
        network.execute(() -> {
            try {
                String origin = origin(call), hostId = call.getString("hostId"), path = text(call.getString("path"), 8192), method = text(call.getString("method"), 16);
                URI uri = new URI(origin + path).normalize();
                boolean device = uri.getPath().equals(DEVICE) || uri.getPath().startsWith(DEVICE + "/");
                if (device && !("GET".equals(method) && (uri.getPath().equals(DEVICE) || uri.getPath().equals(DEVICE + "/status"))) throw new Exception();
                if (hostId == null && !("GET".equals(method) && uri.getPath().equals(DEVICE) && uri.getRawQuery() == null)) throw new Exception();
                if (hostId != null) text(hostId, 128);
                String encoded = call.getString("body");
                byte[] body = encoded == null ? null : Base64.decode(encoded, Base64.NO_WRAP);
                Response response = connection(origin, path, method, call.getObject("headers", new JSObject()), hostId, body, operation);
                JSObject headers = new JSObject();
                for (Map.Entry<String, List<String>> header : response.headers().toMultimap().entrySet()) {
                    if (header.getKey() == null) continue;
                    String key = header.getKey().toLowerCase(java.util.Locale.ROOT);
                    if (!key.equals("set-cookie") && !key.equals("authorization")) headers.put(key, String.join(", ", header.getValue()));
                }
                call.resolve(new JSObject().put("status", response.code()).put("headers", headers));
            } catch (Exception error) { close(id, operation); reject(call, error); }
        });
    }
    @PluginMethod public void read(PluginCall call) {
        String id = call.getString("requestId"); Operation operation = id == null ? null : requests.get(id);
        if (operation == null) { reject(call, new Exception()); return; }
        if (!operation.reading.compareAndSet(false, true)) { reject(call, new Exception()); return; }
        try { operation.reader.execute(() -> {
            try {
                if (operation.cancelled) throw new Exception();
                byte[] bytes = new byte[64 * 1024]; int count = operation.body == null ? -1 : operation.body.read(bytes);
                if (operation.cancelled) throw new Exception();
                if (count < 0) { close(id, operation); call.resolve(new JSObject().put("done", true)); }
                else call.resolve(new JSObject().put("done", false).put("data", Base64.encodeToString(bytes, 0, count, Base64.NO_WRAP)));
            } catch (Exception error) { close(id, operation); reject(call, error); }
            finally { operation.reading.set(false); }
        }); } catch (java.util.concurrent.RejectedExecutionException ended) { operation.reading.set(false); reject(call, new Exception()); }
    }
    @PluginMethod public void cancel(PluginCall call) {
        String id = call.getString("requestId"); Operation operation = id == null ? null : requests.remove(id);
        if (operation != null) operation.close(); call.resolve();
    }
    private JSONObject admission(String origin, String path, JSONObject body, Operation operation, int[] status) throws Exception {
        Response response = connection(origin, path, "POST", new JSONObject().put("Content-Type", "application/json"), null,
            body.toString().getBytes(StandardCharsets.UTF_8), operation);
        String type = response.header("Content-Type");
        if (type == null || !type.split(";", 2)[0].trim().equals("application/json")) throw new Exception();
        status[0] = response.code(); ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] chunk = new byte[1024]; int count;
        if (operation.body == null) throw new Exception();
        while ((count = operation.body.read(chunk)) != -1) { if (bytes.size() + count > 4096) throw new Exception(); bytes.write(chunk, 0, count); }
        return new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
    }
    private long integer(JSONObject value, String key) throws Exception {
        Object number = value.get(key); if (!(number instanceof Number)) throw new Exception();
        double n = ((Number) number).doubleValue();
        if (!Double.isFinite(n) || n < 0 || n > 9007199254740991d || Math.rint(n) != n) throw new Exception();
        return ((Number) number).longValue();
    }
    private void save(String origin, String hostId, String key, Pending pending, PluginCall call) throws Exception {
        try { vault.save(origin, hostId, pending.credential); }
        catch (Exception failure) { throw new Exception("NATIVE_SECRET_STORE_UNCONFIRMED"); }
        synchronized (this.pending) { this.pending.remove(key); }
        call.resolve(new JSObject(pending.approved.toString()));
    }
    @PluginMethod public void begin(PluginCall call) {
        final String id = call.getString("requestId"); final Operation operation;
        try { operation = reserve(id); } catch (Exception error) { reject(call, error); return; }
        network.execute(() -> {
            String key = null; boolean ownsBusy = false;
            try {
                String origin = origin(call), hostId = text(call.getString("hostId"), 128); key = origin + "\n" + hostId;
                synchronized (pending) { if (busy.contains(key) || (pending.get(key) != null && pending.get(key).credential != null)) throw new Exception("NATIVE_SECRET_STORE_UNCONFIRMED"); busy.add(key); }
                ownsBusy = true;
                int[] status = new int[1]; JSONObject state = admission(origin, DEVICE, new JSONObject().put("hostId", hostId)
                    .put("invitation", text(call.getString("invitation"), 128)).put("name", text(call.getString("name"), 128)), operation, status);
                if (status[0] != 201 || state.length() != 6 || !state.getString("state").equals("waiting") || !hostId.equals(state.getString("hostId"))) throw new Exception();
                String deviceId = text(state.getString("deviceId"), 128), claim = text(state.getString("claim"), 128), code = state.getString("confirmationCode");
                if (!claim.matches("[A-Za-z0-9_-]{43}") || !code.matches("[0-9]{6}")) throw new Exception();
                long expiresAt = integer(state, "expiresAt"); synchronized (pending) { pending.put(key, new Pending(deviceId, claim)); }
                call.resolve(new JSObject().put("state", "waiting").put("hostId", hostId).put("deviceId", deviceId).put("confirmationCode", code).put("expiresAt", expiresAt));
            } catch (Exception error) { reject(call, error); }
            finally { if (ownsBusy) synchronized (pending) { busy.remove(key); } close(id, operation); }
        });
    }
    @PluginMethod public void claim(PluginCall call) {
        final String id = call.getString("requestId"); final Operation operation;
        try { operation = reserve(id); } catch (Exception error) { reject(call, error); return; }
        network.execute(() -> {
            String key = null; boolean ownsBusy = false; Pending item = null;
            try {
                String origin = origin(call), hostId = text(call.getString("hostId"), 128); key = origin + "\n" + hostId;
                synchronized (pending) {
                    item = pending.get(key); if (busy.contains(key) || item == null) throw new Exception();
                    busy.add(key);
                }
                ownsBusy = true;
                if (item.credential != null) { save(origin, hostId, key, item, call); return; }
                if (item.unknown) throw new Exception("NATIVE_CLAIM_UNCONFIRMED");
                item.unknown = true;
                int[] status = new int[1]; JSONObject state = admission(origin, DEVICE + "/claim", new JSONObject().put("hostId", hostId)
                    .put("deviceId", item.deviceId).put("claim", item.claim), operation, status);
                if (!hostId.equals(state.getString("hostId"))) throw new Exception();
                if (status[0] == 202 && state.length() == 2 && state.getString("state").equals("waiting")) {
                    item.unknown = false; call.resolve(new JSObject().put("state", "waiting").put("hostId", hostId)); return;
                }
                if (status[0] != 200 || state.length() != 4 || !state.getString("state").equals("approved")) throw new Exception();
                JSONObject device = state.getJSONObject("device"); String credential = state.getString("credential");
                if (device.length() != 3 || !item.deviceId.equals(device.getString("deviceId")) || !credential.matches("[A-Za-z0-9_-]{43}")) throw new Exception();
                JSObject publicDevice = new JSObject().put("deviceId", item.deviceId).put("name", text(device.getString("name"), 128)).put("createdAt", integer(device, "createdAt"));
                item.approved = new JSONObject().put("state", "approved").put("hostId", hostId).put("device", publicDevice);
                item.credential = new JSONObject().put("origin", origin).put("hostId", hostId).put("deviceId", item.deviceId).put("credential", credential);
                save(origin, hostId, key, item, call);
            } catch (Exception error) {
                reject(call, ownsBusy && item != null && item.unknown && item.credential == null
                    ? new Exception("NATIVE_CLAIM_UNCONFIRMED") : error);
            }
            finally { if (ownsBusy) synchronized (pending) { busy.remove(key); } close(id, operation); }
        });
    }
    @Override protected void handleOnDestroy() {
        for (Operation operation : requests.values()) operation.close(); requests.clear(); network.shutdownNow();
        synchronized (pending) { pending.clear(); busy.clear(); }
        if (http != null) { http.dispatcher().executorService().shutdown(); http.connectionPool().evictAll(); }
    }
}
