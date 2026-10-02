package dev.bagakit.agentmux.mobile;

import android.app.Activity;
import android.content.Intent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** Public document picker only; independent of the private credential bridge. */
@CapacitorPlugin(name = "AgentMuxWorkfaceFile")
public class AgentMuxWorkfaceFilePlugin extends Plugin {
    private byte[] bytes;
    @PluginMethod public synchronized void save(PluginCall call) {
        if (bytes != null) { call.reject("A workface file picker is already open. This second request was not saved.", "NATIVE_WORKFACE_NOT_SAVED"); return; }
        try {
            String value = call.getString("bytes");
            if (!"agentmux-workface.json".equals(call.getString("filename")) || value == null) throw new Exception();
            byte[] source = value.getBytes(StandardCharsets.UTF_8); JSONObject object = new JSONObject(value);
            if (source.length > 2 * 1024 * 1024 || object.length() != 2 || !object.getString("schema").equals("agentmux.mobile-workface.v1")
                || !(object.get("workface") instanceof JSONObject)) throw new Exception();
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/json").putExtra(Intent.EXTRA_TITLE, "agentmux-workface.json");
            bytes = source; startActivityForResult(call, intent, "fileSelected");
        } catch (Exception error) { bytes = null; call.reject("The workface file was not saved. Choose a file destination and retry.", "NATIVE_WORKFACE_NOT_SAVED"); }
    }
    @ActivityCallback private synchronized void fileSelected(PluginCall call, ActivityResult result) {
        byte[] source = bytes; bytes = null;
        if (call == null) return;
        if (source == null || result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("The workface file was not saved. The original record is retained.", "NATIVE_WORKFACE_NOT_SAVED"); return;
        }
        execute(() -> {
            try (OutputStream output = getContext().getContentResolver().openOutputStream(result.getData().getData(), "w")) {
                if (output == null) throw new Exception(); output.write(source); output.flush();
            } catch (Exception error) { call.reject("The workface file write is unconfirmed. The original record is retained.", "NATIVE_WORKFACE_NOT_SAVED"); return; }
            call.resolve();
        });
    }
}
