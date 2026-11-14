import { useState } from "react";
import { createRoot } from "react-dom/client";
import { mountThemeRuntime, updateThemeSelection } from "@agentmux/client-ui/theme";
import { DesktopClientUiProvider } from "../../../src/renderer/src/components/DesktopClientUiProvider";
import { SettingsNavigation } from "../../../src/renderer/src/components/SettingsNavigation";
import { WindowUtilityBar } from "../../../src/renderer/src/components/WindowUtilityBar";
import { ToolkitPopover } from "../../../src/renderer/src/components/performance/PerformancePopover";
import { ToolkitIcon } from "../../../src/renderer/src/components/toolkit/ToolkitIcon";
import { UserToolkitResult } from "../../../src/renderer/src/components/toolkit/UserToolkitResult";
import "../../../src/renderer/src/styles/index.css";

const inputs: { trusted: boolean; target: string }[] = [];
document.addEventListener("click", event => {
  const button = (event.target as Element).closest("button");
  if (button) inputs.push({ trusted: event.isTrusted, target: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "" });
}, true);
mountThemeRuntime(window, { appAppearance: "dark" });

const definition = {
  id: "launch-receipt-fixture",
  name: "Workspace monitor",
  icon: "terminal",
  enabled: true,
  statusBar: "icon",
  mode: "tui",
} as const;

function Scene() {
  const [selected, select] = useState<string | symbol | null>(null);
  return (
    <DesktopClientUiProvider>
      <SettingsNavigation.Provider value={{ open() {}, openToolkit() {} }}>
        <main style={{ height: "calc(100vh - var(--window-status-bar-height))", padding: 20, background: "var(--surface-0)" }}>
          <label>
            Working note
            <input aria-label="Original draft" defaultValue="Keep the original draft" style={{ display: "block", width: "min(260px, 100%)", marginTop: 6 }} />
          </label>
        </main>
        <footer className="window-status-bar" style={{ position: "fixed", bottom: 0, left: 0, right: 0 }}>
          <span>Ready</span>
          <div className="window-status-bar__right">
            <WindowUtilityBar toolkit={
              <ToolkitPopover toolId={definition.id} name={definition.name} icon={<ToolkitIcon icon={definition.icon} size={14} />} selectedToolId={selected} onSelectTool={select}>
                {close => <UserToolkitResult definition={definition} active close={close} />}
              </ToolkitPopover>
            } />
          </div>
        </footer>
      </SettingsNavigation.Provider>
    </DesktopClientUiProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Scene />);
Object.assign(window, {
  pendingLaunchProof: {
    inputs,
    theme(appAppearance: "light" | "dark") {
      return updateThemeSelection({ appAppearance });
    },
  },
});
