import { createRoot } from "react-dom/client";
import { useState } from "react";
import { DesktopClientUiProvider } from "../../../src/renderer/src/components/DesktopClientUiProvider";
import { WindowUtilityBar } from "../../../src/renderer/src/components/WindowUtilityBar";
import { SettingsNavigation } from "../../../src/renderer/src/components/SettingsNavigation";
import { ToolkitPopover } from "../../../src/renderer/src/components/performance/PerformancePopover";
import { PerformanceOverview } from "../../../src/renderer/src/components/performance/PerformanceOverview";
import { PerformanceScript } from "../../../src/renderer/src/components/performance/PerformanceScript";
import { UserToolkitResult } from "../../../src/renderer/src/components/toolkit/UserToolkitResult";
import { MobileConnectionResult } from "../../../src/renderer/src/components/toolkit/MobileConnectionResult";
import { TuiToolkitSettings } from "../../../src/renderer/src/components/toolkit/TuiToolkitResult";
import { ToolkitIcon } from "../../../src/renderer/src/components/toolkit/ToolkitIcon";
import { MOBILE_CONNECTION_TOOL_ID } from "../../../src/shared/toolkit-preferences";
import { api } from "../../../src/renderer/src/lib/api";
import { useAppStore } from "../../../src/renderer/src/store";
import {
  mountThemeRuntime,
  updateThemeSelection,
} from "@agentmux/client-ui/theme";
import { performanceSnapshot } from "../performance-panel/data";
import type {
  ToolkitScriptSnapshot,
  ToolkitToolDefinition,
} from "@agentmux/core/control";
import "../../../src/renderer/src/styles/index.css";

const w = window as any,
  effects: any[] = [],
  inputs: any[] = [];
const config = await api.config.get();
useAppStore.setState({ config, loading: false });
mountThemeRuntime(window, { appAppearance: "dark" });
const definition: ToolkitToolDefinition = {
  id: "frame-custom",
  revision: "original-definition",
  name: "Workspace report",
  icon: "terminal",
  enabled: true,
  statusBar: "icon",
  workspacePath: "~/.agentmux",
  script: 'console.log("Workspace report")',
  args: [],
  actions: [
    {
      id: "inspect",
      label:
        "Inspect the complete retained report for every configured workspace",
      script: 'console.log("Retained report")',
      args: [],
    },
  ],
};
function result(tool: ToolkitToolDefinition): ToolkitScriptSnapshot {
  return {
    schema: "agentmux.toolkit.v1",
    kind: "script",
    toolId: tool.id,
    definition: tool,
    state: "succeeded",
    reason: null,
    admission: null,
    consumerCount: 1,
    sequence: 1,
    latestConfirmed: {
      executionId: "original-result",
      invocationId: "original-request",
      definition: tool,
      expectedLatestExecutionId: null,
      target: { workspacePath: tool.workspacePath },
      run: { hostId: "fixture", runId: "fixture-presentation-only" },
      startedAt: 1,
      endedAt: 2,
      exitCode: 0,
      state: "succeeded",
      reason: null,
      text: "Workspace report\n\n8 workspaces checked\n2 notes ready for review\n\nThe original output remains available while another action is selected.",
    },
  };
}
let current = result(definition);
api.toolkit = {
  ...api.toolkit,
  async get(id) {
    effects.push({ method: "get", id });
    return structuredClone(current);
  },
  observe(id, read) {
    effects.push({ method: "observe", id });
    read(structuredClone(current));
    return {
      dispose() {
        effects.push({ method: "release", id });
      },
    };
  },
  async run(...args) {
    effects.push({ method: "run", args });
    return current as any;
  },
  async action(...args) {
    effects.push({ method: "action", args });
    return current as any;
  },
  async stop(...args) {
    effects.push({ method: "stop", args });
    return current as any;
  },
  async evaluate(...args) {
    effects.push({ method: "evaluate", args });
    return current as any;
  },
  async script() {
    effects.push({ method: "script" });
    return {
      toolId: "performance",
      path: "performance.sh",
      sha256: "a".repeat(64),
      text: "exec amux metrics watch\n",
    };
  },
};
api.ui.writeClipboardText = async (text) => {
  effects.push({ method: "clipboard", text });
};
for (const type of ["pointerdown", "click", "keydown"])
  document.addEventListener(
    type,
    (event) => {
      const node = event.target as Element;
      inputs.push({
        type,
        trusted: event.isTrusted,
        target: node?.closest("button")?.textContent ?? node?.tagName,
        key: event instanceof KeyboardEvent ? event.key : undefined,
      });
    },
    true,
  );
let setScene!: (name: string) => void,
  setSelected!: (id: string | symbol | null) => void;
function Scene() {
  const [scene, change] = useState("custom"),
    [selected, select] = useState<string | symbol | null>(null),
    [paused, pause] = useState(false),
    [source, showSource] = useState(false);
  setScene = (name) => {
    select(null);
    pause(false);
    showSource(false);
    change(name);
  };
  setSelected = select;
  const tool = current.definition;
  return (
    <DesktopClientUiProvider>
      <SettingsNavigation.Provider
        value={{
          open(section) {
            effects.push({ method: "settings", section });
          },
          openToolkit(id) {
            effects.push({ method: "configure", id });
          },
        }}
      >
        <main
          style={{
            height: "calc(100vh - var(--window-status-bar-height))",
            padding: 24,
            background: "var(--surface-0)",
          }}
        >
          <p className="settings-hint">
            Toolkit · selected component presentation
          </p>
          <label>
            Working note
            <input
              aria-label="Original draft"
              defaultValue="Keep the original draft"
              style={{ display: "block", width: 280, marginTop: 6 }}
            />
          </label>
          {scene === "compact" ? (
            <section style={{ marginTop: 120, maxWidth: 400 }}>
              <h2 style={{ fontSize: "var(--fs-body)" }}>TUI execution</h2>
              <TuiToolkitSettings definition={tool} active />
            </section>
          ) : null}
        </main>
        <footer
          className="window-status-bar"
          style={{ position: "fixed", bottom: 0, left: 0, right: 0 }}
        >
          <span>Ready</span>
          <div className="window-status-bar__right">
            <WindowUtilityBar
              toolkit={
                <ToolkitPopover
                  toolId="frame"
                  name={
                    scene === "performance"
                      ? "Performance"
                      : scene === "phone"
                        ? "Phone connection"
                        : tool.name
                  }
                  icon={
                    <ToolkitIcon
                      icon={
                        scene === "performance"
                          ? "gauge"
                          : scene === "phone"
                            ? "smartphone"
                            : "terminal"
                      }
                      size={14}
                    />
                  }
                  selectedToolId={selected}
                  onSelectTool={select}
                >
                  {(close) =>
                    scene === "performance" ? (
                      source ? (
                        <PerformanceScript
                          api={api.toolkit}
                          close={close}
                          back={() => showSource(false)}
                        />
                      ) : (
                        <PerformanceOverview
                          snapshot={performanceSnapshot}
                          paused={paused}
                          close={close}
                          onPause={() => {
                            effects.push({ method: "pause" });
                            pause(!paused);
                          }}
                          onViewScript={() => {
                            effects.push({ method: "view-script" });
                            showSource(true);
                          }}
                          onManageBrowsers={() =>
                            effects.push({ method: "manage-browsers" })
                          }
                          onConfigure={() => {
                            effects.push({ method: "configure-performance" });
                            close();
                          }}
                        />
                      )
                    ) : scene === "phone" ? (
                      <MobileConnectionResult active close={close} />
                    ) : (
                      <UserToolkitResult
                        definition={tool}
                        active
                        close={close}
                        {...(scene === "long"
                          ? {
                              runLabel:
                                "Run the complete workspace report and retain all original execution details",
                            }
                          : {})}
                      />
                    )
                  }
                </ToolkitPopover>
              }
            />
          </div>
        </footer>
      </SettingsNavigation.Provider>
    </DesktopClientUiProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Scene />);
w.toolkitFrameProof = {
  ready: true,
  effects,
  inputs,
  select: (id: string | symbol | null) => setSelected(id),
  theme(mode: "dark" | "light") {
    updateThemeSelection({ appAppearance: mode });
  },
  scene(name: string) {
    let tool = { ...definition };
    current = result(tool);
    if (name === "long") {
      tool = {
        ...tool,
        name: "Workspace review and retained execution details",
      };
      current = result(tool);
      current.latestConfirmed!.text +=
        "\n\nConnection details could not be confirmed. The original report is preserved.";
    }
    if (name === "unknown" || name === "compact") {
      tool = { ...tool, mode: name === "compact" ? "tui" : "script" };
      current = {
        ...result(tool),
        state: "unknown",
        reason:
          "The original request has no confirmed launch receipt. Continue it or check its status; its result and input are retained.",
        admission: {
          executionId: "retained-request",
          invocationId: "retained-invocation",
          definition: tool,
          expectedLatestExecutionId: "original-result",
          target: { workspacePath: tool.workspacePath },
          run: null,
          startedAt: 3,
          state: "unknown",
          reason: null,
          text: "",
        },
      };
    }
    if (name === "tui") {
      tool = { ...tool, mode: "tui", name: "Workspace terminal" };
      current = { ...result(tool), state: "idle", latestConfirmed: null };
    }
    if (name === "phone") {
      tool = {
        ...tool,
        id: MOBILE_CONNECTION_TOOL_ID,
        name: "Phone connection",
        display: { script: "return {}", args: [] },
      };
      const phone = result(tool);
      const confirmed = {
        ...phone.latestConfirmed!,
        document: {
          schema: "agentmux.toolkit.result.v1" as const,
          summary: "Devices",
          items: [
            { label: "Connected", value: "1" },
            { label: "Authorized", value: "2" },
          ],
          links: [
            {
              label: "Connect phone",
              url: "https://agentmux.invalid/connect?token=fixture-only",
            },
          ],
        },
      };
      current = {
        ...phone,
        latestConfirmed: confirmed,
        display: {
          state: "succeeded",
          reason: null,
          admission: null,
          latestConfirmed: confirmed,
          lastSucceeded: confirmed,
        } as any,
      };
    }
    setScene(name);
  },
  current: () => current,
};
