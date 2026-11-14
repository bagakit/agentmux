const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { writeFile } = require("node:fs/promises");
const { dirname, join } = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const [html, privateRoot, evidence] = process.argv.slice(2);
for (const key of ["home", "userData", "sessionData"]) app.setPath(key, join(privateRoot, key));
app.on("window-all-closed", () => {});

const toolId = "launch-receipt-fixture", executionId = "original-launch-fixture", invocationId = "original-invocation-fixture";
const definition = {
  id: toolId, revision: "original-definition", name: "Workspace monitor", icon: "terminal",
  mode: "tui", enabled: true, statusBar: "icon", workspacePath: privateRoot,
  script: "echo Workspace monitor", args: [],
};
const execution = {
  executionId, invocationId, definition, expectedLatestExecutionId: null,
  target: { workspacePath: definition.workspacePath }, run: null, startedAt: 1, text: "",
};
const reason = "The original terminal launch receipt is unconfirmed.";
const base = { schema: "agentmux.toolkit.v1", kind: "script", toolId, definition, consumerCount: 1 };
let current = {
  ...base, state: "unknown", pendingLaunch: "dispatched", reason, sequence: 1,
  admission: { ...execution, state: "unknown", reason }, latestConfirmed: null,
};
const receipt = {
  completed: false, assertion: "bootstrap", frames: [], nativeInput: [], inputs: [], errors: [], ipc: [], requests: [],
  ownership: { toolId, executionId, invocationId, firstState: current.state, pendingLaunch: current.pendingLaunch },
};
const ambiguity = "The original launch retirement could not be confirmed.";
let stopCount = 0, releaseCount = 0, retirementReads = 0;
const port = {
  subscribe(id, snapshot) {
    assert.equal(id, toolId);
    snapshot(current);
    return { dispose() { releaseCount++; } };
  },
  async execute({ operation, ...request }) {
    receipt.requests.push({ operation, ...request });
    assert.equal(request.toolId, toolId);
    if (operation === "toolkit.get") {
      if (current.pendingLaunch === "retirement-unconfirmed" && ++retirementReads === 2) {
        current = {
          ...base, state: "stopped", reason: null, sequence: 3, admission: null,
          latestConfirmed: { ...execution, state: "stopped", reason: null, endedAt: 2, exitCode: null, cancelledPendingLaunch: true },
        };
      }
      return { operation, snapshot: current };
    }
    if (operation === "toolkit.stop") {
      assert.equal(request.executionId, executionId);
      assert.equal(request.cancelPendingLaunch, true);
      if (++stopCount === 1) throw new Error(ambiguity);
      current = { ...current, pendingLaunch: "retirement-unconfirmed", reason: ambiguity, sequence: 2,
        admission: { ...current.admission, reason: ambiguity } };
      return { operation, snapshot: current };
    }
    throw new Error("Unexpected fixture operation: " + operation);
  },
};

const apiButton = text => `[...document.querySelectorAll("button")].find(button => (button.getAttribute("aria-label") ?? button.textContent.trim()) === ${JSON.stringify(text)})`;
const trigger = `document.querySelector('[data-toolkit-id="${toolId}"]')`;
const empty = ".toolkit-tui";
const labels = { check: "Check launch status", end: "End pending launch", retry: "Continue original request", run: "Run saved command" };
const hasRunIpc = () => receipt.ipc.some(({ channel }) => /^toolkit:(?:run|action|evaluate)$/u.test(channel));
const stopCalls = () => receipt.ipc.filter(({ channel }) => channel === "toolkit:stop");
const getCalls = () => receipt.ipc.filter(({ channel }) => channel === "toolkit:get");
const usefulContent = `document.querySelector("${empty}")?.innerText ?? ""`;
const sameDraft = 'document.querySelector("[aria-label=\\"Original draft\\"]")?.value === "Keep the original draft"';

app.whenReady().then(async () => {
  let win, unregister;
  try {
    const { registerToolkitIpc } = require(join(dirname(html), "owner.cjs"));
    unregister = registerToolkitIpc(port, (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
      assert.equal(event.sender, win.webContents);
      receipt.ipc.push({ channel, args });
      return handler(event, ...args);
    }));
    ipcMain.on("ui:themeBootstrap", event => {
      event.returnValue = { status: "unavailable", message: "The isolated fixture sets the theme before rendering." };
    });
    win = new BrowserWindow({
      width: 1000, height: 600, show: false, useContentSize: true,
      webPreferences: { preload: join(dirname(html), "preload.cjs"), nodeIntegration: false,
        contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.on("console-message", details => {
      if (details.level === "error") receipt.errors.push(details.message);
    });
    win.webContents.on("preload-error", (_event, source, error) => receipt.errors.push(`Failed to load ${source}: ${error.message}`));
    const read = code => win.webContents.executeJavaScript(code);
    const waitFor = async (check, message) => {
      const deadline = Date.now() + 9000;
      while (!(await check())) {
        assert.ok(Date.now() < deadline, message);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const until = code => waitFor(() => read(code), "Connected scene: " + code);
    const settle = () => read("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const box = expression => read(`(() => {
      const button = ${expression};
      if (!button || button.disabled) return null;
      const r = button.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      return { x, y, left: r.left, top: r.top, right: r.right, bottom: r.bottom,
        width: r.width, height: r.height, reachable: hit === button || button.contains(hit),
        withinViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
    })()`);
    const click = async (expression, name) => {
      await settle();
      const point = await box(expression);
      assert.ok(point?.reachable && point.withinViewport, name + " remains pointer reachable");
      const previous = await read("pendingLaunchProof.inputs.length");
      for (const type of ["mouseMove", "mouseDown", "mouseUp"])
        win.webContents.sendInputEvent({ type, x: point.x, y: point.y, button: "left", clickCount: 1 });
      await until(`pendingLaunchProof.inputs.length === ${previous + 1}`);
      const event = await read("pendingLaunchProof.inputs.at(-1)");
      receipt.nativeInput.push({ name, point, event });
      assert.deepEqual(event, { trusted: true, target: name });
    };
    const frame = async (name, width, theme, controls) => {
      win.setContentSize(width, 600);
      assert.equal((await read(`pendingLaunchProof.theme(${JSON.stringify(theme)})`)).applied, true);
      await until(`innerWidth === ${width} && document.documentElement.dataset.appearance === ${JSON.stringify(theme)}`);
      await settle();
      const transitions = await read("Promise.all(document.getAnimations().filter(animation => animation instanceof CSSTransition).map(animation => animation.finished.catch(() => {}))).then(() => true)");
      assert.equal(transitions, true);
      const buttons = {};
      for (const label of controls) {
        const button = await box(apiButton(label));
        assert.ok(button?.reachable && button.withinViewport, label + " visible and reachable in " + name);
        buttons[label] = button;
      }
      const image = await win.webContents.capturePage();
      assert.ok(!image.isEmpty());
      const size = image.getSize(), file = name + ".png", png = image.toPNG();
      await writeFile(join(evidence, file), png);
      receipt.frames.push({ name, file, theme, size, sha256: createHash("sha256").update(png).digest("hex"),
        viewport: await read("({width: innerWidth, height: innerHeight})"), buttons });
    };
    win.on("closed", () => { win = undefined; });
    await win.loadFile(html);
    win.showInactive();
    await until("Boolean(window.agentmux?.toolkit && window.pendingLaunchProof)");
    await until(`Boolean(${trigger})`);

    receipt.assertion = "observe-dispatched-launch";
    await click(trigger, definition.name);
    await until(`Boolean(${apiButton(labels.end)} && ${apiButton(labels.check)})`);
    assert.equal(await read(`Boolean(${apiButton(labels.retry)} || ${apiButton(labels.run)})`), false, "Dispatched launch blocks both new and repeated starts");
    assert.ok((await read(usefulContent)).includes("Launch unconfirmed"));
    assert.equal(hasRunIpc(), false);
    assert.equal(stopCalls().length, 0);
    await frame("pending-wide-dark", 1000, "dark", [labels.check, labels.end]);
    await frame("pending-narrow-light", 380, "light", [labels.check, labels.end]);

    receipt.assertion = "read-without-relaunch";
    const priorCheck = getCalls().length;
    await click(apiButton(labels.check), labels.check);
    await waitFor(() => getCalls().length === priorCheck + 1, "Status check reached the original read channel");
    await until(`!(${apiButton(labels.check)})?.disabled`);
    assert.equal(hasRunIpc(), false);
    assert.equal(stopCalls().length, 0);

    await click(apiButton(labels.end), labels.end);
    await waitFor(() => stopCalls().length === 1, "End action reached the original stop channel");
    receipt.assertion = "exact-stop-ipc-arguments";
    assert.deepEqual(stopCalls()[0].args, [toolId, executionId, { cancelPendingLaunch: true }]);
    receipt.assertion = "unconfirmed-retirement-retains-original";
    await until(`(${usefulContent}).includes(${JSON.stringify(ambiguity)})`);
    assert.equal(await read(`Boolean(${apiButton(labels.end)} && !${apiButton(labels.run)})`), true);
    assert.equal(hasRunIpc(), false);
    assert.equal(current.admission.executionId, executionId);
    assert.equal(current.admission.invocationId, invocationId);
    await frame("end-unconfirmed-narrow-light", 380, "light", [labels.check, labels.end]);

    receipt.assertion = "accepted-retirement-awaits-confirmation";
    await click(apiButton(labels.end), labels.end);
    await until(`(${usefulContent}).includes("End unconfirmed")`);
    assert.deepEqual(stopCalls().map(({ args }) => args), Array.from({ length: 2 }, () => [toolId, executionId, { cancelPendingLaunch: true }]));
    assert.deepEqual([current.admission.executionId, current.admission.invocationId, current.admission.run], [executionId, invocationId, null]);
    assert.equal(await read(`Boolean(${apiButton(labels.end)} || ${apiButton(labels.retry)} || ${apiButton(labels.run)})`), false);
    assert.equal(hasRunIpc(), false);
    await until(`!(${apiButton(labels.check)})?.disabled`);
    await frame("retirement-unconfirmed-narrow-light", 380, "light", [labels.check]);

    receipt.assertion = "confirmed-retirement-allows-explicit-start";
    await click(apiButton(labels.check), labels.check);
    await until(`Boolean(${apiButton(labels.run)})`);
    assert.deepEqual([current.admission, current.latestConfirmed.executionId, current.latestConfirmed.invocationId], [null, executionId, invocationId]);
    assert.equal(await read(`Boolean(${apiButton(labels.end)} || ${apiButton(labels.retry)})`), false);
    assert.ok((await read(usefulContent)).includes("Stopped"));
    assert.equal(hasRunIpc(), false);
    receipt.ownership.finalState = current.state;
    await frame("ended-narrow-light", 380, "light", [labels.run]);
    await frame("ended-wide-dark", 1000, "dark", [labels.run]);

    receipt.assertion = "reopen-preserves-result-and-draft";
    await click(apiButton("Close " + definition.name), "Close " + definition.name);
    await until(`!document.querySelector("${empty}")`);
    await waitFor(() => releaseCount === 1, "Only the original observation was released");
    await click(trigger, definition.name);
    await until(`Boolean(${apiButton(labels.run)})`);
    assert.equal(await read(sameDraft), true);
    assert.equal(hasRunIpc(), false);
    assert.equal(receipt.requests.filter(({ operation }) => operation === "toolkit.stop").length, 2);
    assert.equal(retirementReads, 2, "Retirement requires an explicit check after the automatic reconciliation read");
    assert.deepEqual(receipt.errors, []);
    receipt.inputs = await read("pendingLaunchProof.inputs");
    receipt.completed = true;
    receipt.assertion = "complete";
  } catch (error) {
    receipt.failure = { name: error.name, message: error.message, stack: error.stack };
  } finally {
    unregister?.();
    win?.destroy();
    await writeFile(join(evidence, "scene.json"), JSON.stringify(receipt, null, 2) + "\n");
    app.exit(receipt.completed ? 0 : 1);
  }
});
