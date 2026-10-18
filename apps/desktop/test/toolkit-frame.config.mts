import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import base from "../scripts/fixtures/settings-overview/vitest.config.mts";

const root = resolve(import.meta.dirname, "../../..");
const inputs: Record<string, string> = {};
const loaded: { path: string; diskSHA256: string; loadedSHA256: string }[] = [];
const loadedPath = resolve(root, ".local/toolkit-frame/components-loaded.json");
function bind(file: string) {
  const path = relative(root, file);
  if (path.startsWith("../") || path.includes("/node_modules/")) return;
  inputs[path] = createHash("sha256").update(readFileSync(file)).digest("hex");
}
for (const path of [
  "apps/desktop/test/toolkit-frame.config.mts",
  "apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts",
  "package.json",
  "apps/desktop/package.json",
  "pnpm-lock.yaml",
])
  bind(resolve(root, path));
const output = process.env.AGENTMUX_TOOLKIT_FRAME_COMPONENT_INPUTS;
const report = resolve(root, ".local/toolkit-frame/components.json");
if (output) {
  rmSync(output, { force: true });
  rmSync(report, { force: true });
  process.once("exit", (code) => {
    if (code !== 0 || !existsSync(report)) return;
    const result = JSON.parse(readFileSync(report, "utf8"));
    assert.equal(result.success, true);
    assert.ok(result.numPassedTests > 0);
    for (const [file, hash] of Object.entries(inputs))
      assert.equal(
        createHash("sha256")
          .update(readFileSync(resolve(root, file)))
          .digest("hex"),
        hash,
        "Actual consumed input remains unchanged: " + file,
      );
    writeFileSync(loadedPath, JSON.stringify(loaded, null, 2) + "\n");
    bind(loadedPath);
    bind(report);
    writeFileSync(output, JSON.stringify(inputs, null, 2) + "\n");
  });
}
export default {
  ...base,
  resolve: {
    ...base.resolve,
    conditions: ["browser", "module", "development|production"],
  },
  esbuild: { jsx: "automatic" as const },
  plugins: [
    {
      name: "toolkit-frame-consumer-inputs",
      enforce: "pre" as const,
      transform(_source: string, id: string) {
        const file = id.split("?")[0]!;
        if (
          !file.startsWith(root + "/") ||
          file.includes("/node_modules/") ||
          !/\.[cm]?[jt]sx?$/.test(file)
        )
          return;
        bind(file);
        const path = relative(root, file),
          loadedSHA256 = createHash("sha256").update(_source).digest("hex");
        loaded.push({ path, diskSHA256: inputs[path]!, loadedSHA256 });
        if (
          /\/(ToolkitActions|UserToolkitResult|TuiToolkitResult|PerformanceOverview|PerformancePopover)\.tsx$/.test(
            path,
          )
        )
          assert.equal(
            loadedSHA256,
            inputs[path],
            "Actual owning presenter bytes: " + path,
          );
      },
    },
  ],
  test: {
    ...base.test,
    include: [
      "apps/desktop/test/toolkit-frame.test.tsx",
      "apps/desktop/test/performance-themed-controls.test.tsx",
      "apps/desktop/test/toolkit-tui-ui.test.tsx",
      "apps/desktop/test/toolkit-custom-navigation.test.tsx",
      "apps/desktop/test/toolkit-motion-eligibility.test.tsx",
      "apps/desktop/test/toolkit-agent-cards-performance.test.tsx",
      "apps/desktop/test/performance-attribution.test.tsx",
      "apps/desktop/test/toolkit-custom-ui.test.tsx",
      "apps/desktop/test/toolkit-current-link.test.tsx",
      "apps/desktop/test/toolkit-current-reason-ui.test.tsx",
      "apps/desktop/test/toolkit-custom-identity.test.tsx",
      "apps/desktop/test/toolkit-display-retained-ui.test.tsx",
      "apps/desktop/test/toolkit-result-themed-state.test.tsx",
    ],
  },
};
