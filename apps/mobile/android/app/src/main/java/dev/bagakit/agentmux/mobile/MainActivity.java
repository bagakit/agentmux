package dev.bagakit.agentmux.mobile;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AgentMuxWorkfaceFilePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
