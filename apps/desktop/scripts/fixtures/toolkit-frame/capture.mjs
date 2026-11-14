import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function captureFrame({ root, evidence, mutation = null, scope = "all" }) {
  assert.ok(["all", "phone-only", "pending-launch"].includes(scope), "Bounded Toolkit capture scope");
  const pendingLaunch = scope === "pending-launch";
  assert.ok(scope === "all" || mutation === null || (pendingLaunch && mutation === "stop-options"), "Mutation belongs to the selected frame");
  const html = pendingLaunch ? "pending-launch.html" : "index.html",
    main = pendingLaunch ? "pending-launch-main.cjs" : "main.cjs",
    entry = pendingLaunch ? "pending-launch-entry.tsx" : "entry.tsx";
  const fixture = resolve(root, "apps/desktop/scripts/fixtures/toolkit-frame"),
    desktop = resolve(root, "apps/desktop");
  const require = createRequire(resolve(desktop, "package.json")),
    { build } = await import(pathToFileURL(require.resolve("vite")).href);
  const { runProbeProcess, listProbeProcesses } = await import(
    pathToFileURL(resolve(desktop, "scripts/probe-process.mjs")).href
  );
  const privateRoot = await mkdtemp(resolve(tmpdir(), "amx-toolkit-frame-")),
    compiled = resolve(evidence, "compiled");
  const receipt = {
    completed: false,
    mutation,
    scope,
    captureOnly: true,
    aestheticReview: "not-performed",
    inputs: {},
    loadedCSS: [],
    frames: [],
    boundary: pendingLaunch
      ? "Private Electron, real Toolkit popover, TUI result, production preload and Main IPC, isolated in-memory Core port. No Runtime, credentials or command execution."
      :
      "Selected actual Result/Popover/WindowUtilityBar/Settings compact consumers and production CSS in private Electron; synthetic DTOs and recorded API callback replies. No full App, semantic Host, live Runtime, OS dialog or installation qualification.",
  };
  async function bind(file) {
    if (!file.startsWith(root + "/") || file.includes("/node_modules/")) return;
    const key = relative(root, file),
      bytes = await readFile(file),
      hash = sha(bytes);
    if (receipt.inputs[key])
      assert.equal(receipt.inputs[key], hash, "Stable capture input: " + key);
    else receipt.inputs[key] = hash;
    return bytes;
  }
  try {
    await mkdir(compiled, { recursive: true });
    for (const key of ["home", "userData", "sessionData"])
      await mkdir(resolve(privateRoot, key));
    for (const name of [html, entry, main, "capture.mjs"])
      await bind(resolve(fixture, name));
    for (const path of [
      "package.json",
      "pnpm-lock.yaml",
      "apps/desktop/package.json",
      "apps/desktop/scripts/probe-process.mjs",
    ])
      await bind(resolve(root, path));
    const { workspaceSourceExport } = await import(pathToFileURL(resolve(root, "packages/core/test/helpers/workspace-source-export.mjs")).href);
    if (pendingLaunch) {
      const { build: buildIpc } = createRequire(require.resolve("vite"))("esbuild");
      const preload = "apps/desktop/src/preload/index.ts", owner = "apps/desktop/src/main/toolkit-ipc.ts";
      for (const [source, target] of [[preload, "preload.cjs"], [owner, "owner.cjs"]]) {
        const preloadBundle = source === preload;
        const result = await buildIpc({
          absWorkingDir: root,
          entryPoints: [source],
          outfile: resolve(compiled, target),
          bundle: true,
          format: "cjs",
          platform: preloadBundle ? "browser" : "node",
          ...(preloadBundle ? { conditions: ["module", "browser", "production"], mainFields: ["browser", "module", "main"] } : {}),
          external: ["electron"],
          metafile: true,
          logLevel: "warning",
          plugins: [{ name: "bind-toolkit-pending-ipc", setup(builder) {
            builder.onResolve({ filter: /^@agentmux\// }, args => {
              // Main imports AgentMuxError via the barrel. Its exact defining export is also on the control entry.
              const id = !preloadBundle && args.path === "@agentmux/core" ? "@agentmux/core/control" : args.path;
              const file = workspaceSourceExport(root, id);
              return file ? { path: file } : undefined;
            });
            if (preloadBundle && mutation === "stop-options") {
              builder.onLoad({ filter: /\/preload\/index\.ts$/ }, async ({ path }) => {
                if (path !== resolve(root, preload)) return;
                const original = (await bind(path)).toString();
                const anchor = "ipcRenderer.invoke('toolkit:stop', toolId, executionId, options)";
                assert.equal(original.split(anchor).length, 2, "One built preload mutation anchor");
                const contents = original.replace(anchor, "ipcRenderer.invoke('toolkit:stop', toolId, executionId)");
                receipt.stopOptionsMutation = { path: preload, source: sha(original), loaded: sha(contents) };
                return { contents, loader: "ts", resolveDir: resolve(root, "apps/desktop/src/preload") };
              });
            }
          } }],
        });
        for (const file of Object.keys(result.metafile.inputs)) await bind(resolve(root, file));
        if (preloadBundle) {
          assert.deepEqual([...new Set(Object.values(result.metafile.outputs).flatMap(output => output.imports.map(item => item.path)))], ["electron"], "Sandbox preload has no Node module imports");
        }
      }
    }
    const { bundleIdentityRuntime } = await import(pathToFileURL(resolve(root, "packages/identity/scripts/runtime-bundle.mjs")).href);
    const identitySource = (await bundleIdentityRuntime()).source;
    const identityId = "\0toolkit-frame-identity-source";
    const identityModule = `export const identityRuntimeSource = ${JSON.stringify(identitySource)};\n`;
    receipt.identityRuntime = { sourceSHA256: sha(identitySource), moduleSHA256: sha(identityModule), loads: 0 };
    for (const file of ["packages/core/test/helpers/workspace-source-export.mjs", "packages/identity/scripts/runtime-bundle.mjs", "packages/identity/src/runtime-entry.ts", "packages/identity/src/index.ts"]) await bind(resolve(root, file));
    const alias = [{ find: "@agentmux/identity/runtime-source", replacement: identityId }];
    for (const name of ["core", "demand", "layout"]) {
      const dir = resolve(root, "packages", name),
        pkg = JSON.parse(await bind(resolve(dir, "package.json")));
      for (const [key, value] of Object.entries(pkg.exports)) {
        const target = typeof value === "string" ? value : value.import;
        alias.push({
          find: new RegExp(
            "^@agentmux/" + name + (key === "." ? "" : key.slice(1)) + "$",
          ),
          replacement: resolve(
            dir,
            target
              .replace("./dist/src/", "./src/")
              .replace("./dist/", "./src/")
              .replace(/\.js$/u, ".ts"),
          ),
        });
      }
    }
    for (const name of [
      "react",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "react-dom/client",
    ])
      alias.push({
        find: new RegExp("^" + name + "$"),
        replacement: require.resolve(name),
      });
    const sourcePlugin = () => ({
          name: "bind-toolkit-frame",
          enforce: "pre",
          resolveId(id) {
            if (id === identityId || id === "@agentmux/identity/runtime-source") return identityId;
            return workspaceSourceExport(root, id);
          },
          load(id) { if (id === identityId) { receipt.identityRuntime.loads++; return identityModule; } },
          async transform(code, id) {
            const file = id.split("?")[0];
            if (!file.startsWith(root + "/") || file.includes("/node_modules/"))
              return;
            await bind(file);
            if (
              mutation === "action" &&
              file.endsWith("/components/toolkit/ToolkitActions.tsx")
            ) {
              const before = "{button}";
              assert.equal(
                code.split(before).length,
                2,
                "One real menu callback anchor",
              );
              const loaded = code.replace(
                before,
                "{{ ...button, props: { ...button.props, onClick: undefined } }}",
              );
              receipt.actionMutation = {
                path: relative(root, file),
                source: sha(code),
                loaded: sha(loaded),
              };
              return { code: loaded, map: null };
            }
          },
        });
    await build({
      configFile: false,
      root: fixture,
      base: "./",
      logLevel: "error",
      resolve: { alias },
      esbuild: { jsx: "automatic" },
      worker: { format: "es", plugins: () => [sourcePlugin()] },
      define: {
        __AGENTMUX_WEB_PREVIEW__: pendingLaunch ? "false" : "true",
        "process.env.NODE_ENV": '"production"',
      },
      plugins: [sourcePlugin()],
      css: {
        postcss: {
          plugins: [
            {
              postcssPlugin: "bind-toolkit-frame-css",
              async Once(sheet) {
                const files = new Set();
                sheet.walk((node) => {
                  if (node.source?.input.file)
                    files.add(node.source.input.file);
                });
                await Promise.all([...files].map(bind));
                const owning = "apps/desktop/src/renderer/src/styles/" +
                  (pendingLaunch ? "toolkit-tui.css" : "performance-toolkit.css");
                const rules = [];
                sheet.walkRules((rule) => {
                  if (relative(root, rule.source?.input.file ?? "") === owning)
                    rules.push(rule);
                });
                if (!rules.length) return;
                const before = rules.map((rule) => rule.toString()).join("\n");
                let changed = 0;
                for (const rule of rules) {
                  if (rule.selector === ".performance-actions") {
                    for (const d of rule.nodes ?? [])
                      if (
                        d.type === "decl" &&
                        d.prop === "height" &&
                        mutation === "height"
                      ) {
                        d.value = "44px";
                        changed++;
                      }
                    if (
                      mutation === "wrap" &&
                      rule.nodes.some(
                        (d) => d.type === "decl" && d.prop === "height",
                      )
                    ) {
                      rule.append({ prop: "flex-wrap", value: "wrap" });
                      rule.nodes.find((d) => d.prop === "height").value =
                        "auto";
                      changed++;
                    }
                  }
                  if (
                    mutation === "wrap" &&
                    rule.selector === ".performance-actions > button"
                  ) {
                    rule.append({ prop: "flex-basis", value: "100%" });
                    changed++;
                  }
                }
                if (["height", "wrap"].includes(mutation))
                  assert.equal(
                    changed,
                    mutation === "height" ? 1 : 2,
                    "Exact owning CSS mutation anchors",
                  );
                receipt.loadedCSS.push({
                  path: owning,
                  source: receipt.inputs[owning],
                  before: sha(before),
                  loaded: sha(rules.map((rule) => rule.toString()).join("\n")),
                  changed,
                });
                await writeFile(
                  resolve(evidence, "consumed-cascade.css"),
                  sheet.toString(),
                );
              },
            },
          ],
        },
      },
      build: {
        target: "esnext",
        outDir: compiled,
        sourcemap: false,
        emptyOutDir: false,
        ...(pendingLaunch ? { rollupOptions: { input: resolve(fixture, html) } } : {}),
      },
    });
    assert.ok(receipt.loadedCSS.length, "Actual product stylesheet loaded");
    receipt.compiled = {};
    async function compiledFiles(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = resolve(dir, entry.name);
        if (entry.isDirectory()) await compiledFiles(file);
        else
          receipt.compiled[relative(compiled, file)] = sha(
            await readFile(file),
          );
      }
    }
    await compiledFiles(compiled);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const lines = [];
    receipt.process = await runProbeProcess(
      require("electron"),
      [
        resolve(fixture, main),
        resolve(compiled, html),
        privateRoot,
        evidence,
        scope === "phone-only" ? scope : mutation ?? "baseline",
      ],
      {
        temporaryRoot: privateRoot,
        cwd: root,
        env,
        timeoutMs: 100000,
        onLine: (line) => lines.push(line),
      },
    );
    await writeFile(resolve(evidence, "process.log"), lines.join("\n") + "\n");
    receipt.scene = JSON.parse(
      await readFile(resolve(evidence, "scene.json"), "utf8"),
    );
    receipt.frames = receipt.scene.frames;
    assert.equal(receipt.process.timedOut, false);
    assert.equal(receipt.process.interruption, null);
    if (pendingLaunch) {
      assert.equal(receipt.process.exitCode, mutation ? 1 : 0, JSON.stringify(receipt.scene.failure));
      assert.equal(receipt.scene.completed, !mutation);
      if (mutation) {
        assert.ok(receipt.stopOptionsMutation, "Compiled the mutated production preload");
        assert.equal(receipt.scene.failure?.name, "AssertionError");
        assert.equal(receipt.scene.assertion, "exact-stop-ipc-arguments");
        receipt.specificAssertionRED = true;
      } else {
        assert.equal(receipt.frames.length, 6);
      }
    } else if (mutation) {
      assert.equal(receipt.process.exitCode, 1);
      assert.equal(receipt.scene.failure?.name, "AssertionError");
      assert.equal(
        receipt.scene.assertion,
        mutation === "action" ? "original-action" : "footer-height",
      );
      receipt.specificAssertionRED = true;
    } else {
      assert.equal(receipt.process.exitCode, 0);
      assert.equal(receipt.scene.completed, true);
      assert.equal(receipt.frames.length, scope === "phone-only" ? 4 : 8);
    }
    receipt.completed = true;
  } catch (error) {
    receipt.failure = String(error?.stack ?? error);
  } finally {
    receipt.sourceIdentity = sha(
      JSON.stringify(
        Object.entries(receipt.inputs).sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
    receipt.drift = [];
    for (const [file, hash] of Object.entries(receipt.inputs))
      if (sha(await readFile(resolve(root, file))) !== hash)
        receipt.drift.push(file);
    if (receipt.drift.length) receipt.completed = false;
    receipt.remainingPrivateProcesses = await listProbeProcesses(
      -1,
      privateRoot,
    );
    if (!receipt.remainingPrivateProcesses.length) {
      await rm(privateRoot, { recursive: true });
      receipt.privateRootRemoved = true;
    } else {
      receipt.privateRootRemoved = false;
      receipt.completed = false;
    }
    await writeFile(
      resolve(evidence, "receipt.json"),
      JSON.stringify(receipt, null, 2) + "\n",
    );
  }
  assert.equal(receipt.completed, true, receipt.failure);
  return receipt;
}
