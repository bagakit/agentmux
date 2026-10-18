const assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  { createHash } = require("node:crypto");
const { app, BrowserWindow } = require("electron");
app.on("window-all-closed", () => {});
const [html, privateRoot, evidence, mode] = process.argv.slice(2);
for (const key of ["home", "userData", "sessionData"])
  app.setPath(key, path.join(privateRoot, key));
const receipt = {
  completed: false,
  frames: [],
  geometry: [],
  inputs: [],
  effects: [],
  errors: [],
  boundary:
    "Private Electron selected-component frame presentation; controlled result DTOs and API callbacks. TUI idle and compact unknown only; no Runtime or terminal bytes qualification.",
};
let win;
receipt.windowFocus = [];
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    for (const kind of ["focus", "blur"])
      win.on(kind, () => receipt.windowFocus.push(kind));
    win.webContents.on("console-message", (details) => {
      if (details.level === "error") receipt.errors.push(details.message);
    });
    const read = (code) => win.webContents.executeJavaScript(code),
      pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const until = async (code) => {
      const end = Date.now() + 12000;
      while (!(await read(code))) {
        assert.ok(Date.now() < end, "Connected scene: " + code);
        await pause(25);
      }
    };
    const settle = () =>
      read(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
    const focus = async () => {
      if (win.isFocused() && (await read("document.hasFocus()"))) return;
      app.focus({ steal: true });
      win.moveTop();
      win.focus();
      win.webContents.focus();
      await until("document.hasFocus()");
      assert.equal(
        win.isFocused(),
        true,
        "The isolated fixture window owns native input",
      );
    };
    const click = async (selector) => {
      await focus();
      const point = await read(
        `(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing '+${JSON.stringify(selector)});n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
      );
      await settle();
      assert.equal(
        await read(
          `(()=>{const n=document.querySelector(${JSON.stringify(selector)}),hit=document.elementFromPoint(${point.x},${point.y});return !!n&&(n===hit||n.contains(hit))})()`,
        ),
        true,
        "Actual CSS target remains reachable",
      );
      for (const type of ["mouseMove", "mouseDown", "mouseUp"])
        win.webContents.sendInputEvent({
          type,
          ...point,
          button: "left",
          clickCount: 1,
        });
      await settle();
    };
    const key = async (keyCode) => {
      await focus();
      for (const type of ["keyDown", "keyUp"])
        win.webContents.sendInputEvent({ type, keyCode });
      await settle();
    };
    const frame = async (name, width = 1280, theme = "dark") => {
      win.setContentSize(width, 800);
      await read(
        `toolkitFrameProof.theme(${JSON.stringify(theme)});toolkitFrameProof.scene(${JSON.stringify(name)})`,
      );
      await settle();
      if (name !== "compact") {
        await click('[data-toolkit-id="frame"]');
        await until(
          'document.querySelector(".performance-popover")?.style.visibility==="visible"',
        );
      }
      await settle();
    };
    const geometry = async () => {
      const facts = await read(
        `(()=>{const box=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}},bar=document.querySelector('.window-status-bar');return{bar:box(bar),footers:[...document.querySelectorAll('.performance-actions')].map(n=>({box:box(n),buttons:[...n.querySelectorAll(':scope > button')].map(box),overflow:getComputedStyle(n).overflow,wrap:getComputedStyle(n).flexWrap})),header:document.querySelector('.performance-header')?box(document.querySelector('.performance-header')):null}})()`,
      );
      receipt.geometry.push(facts);
      receipt.assertion = "footer-height";
      assert.ok(facts.footers.length > 0, "A real footer is measured");
      for (const footer of facts.footers) {
        assert.ok(
          footer.box.height <= facts.bar.height + 0.1,
          "Footer actual total height cannot exceed same-window Status Bar",
        );
        for (const button of footer.buttons) {
          assert.ok(
            button.height >= 21.5,
            "Normal action hit height is retained",
          );
          assert.ok(
            button.bottom <= footer.box.bottom + 0.1,
            "Actions stay inside the original footer",
          );
        }
      }
    };
    const capture = async (name, note) => {
      await settle();
      const image = await win.webContents.capturePage(),
        png = image.toPNG();
      await fs.writeFile(path.join(evidence, name), png);
      receipt.frames.push({
        path: name,
        ...image.getSize(),
        sha256: createHash("sha256").update(png).digest("hex"),
        note,
      });
    };
    const menu = async () => {
      const before = await read(
        `(()=>{const r=document.querySelector('.toolkit-actions__more').getBoundingClientRect();return{x:r.x,y:r.y}})()`,
      );
      await click(".toolkit-actions__more");
      await until('!!document.querySelector("[role=menu]")');
      const after = await read(
        `(()=>{const r=document.querySelector('.toolkit-actions__more').getBoundingClientRect();return{x:r.x,y:r.y}})()`,
      );
      assert.ok(
        Math.abs(before.x - after.x) < 0.75 &&
          Math.abs(before.y - after.y) < 0.75,
        "More anchor stays fixed after menu mount",
      );
      const items = await read(
        `(()=>{return[...document.querySelectorAll('[role=menuitem]')].map(n=>{const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return{text:n.textContent,visible:r.width>0&&r.height>0,hit:n===h||n.contains(h),left:r.left,right:r.right,top:r.top,bottom:r.bottom}})})()`,
      );
      assert.ok(items.length > 0);
      for (const item of items) {
        assert.ok(
          item.visible && item.hit,
          "Original menu item remains painted and reachable: " + item.text,
        );
        assert.ok(
          item.left >= 0 &&
            item.right <= win.getContentSize()[0] &&
            item.top >= 0 &&
            item.bottom <= win.getContentSize()[1],
          "Menu remains within the window",
        );
      }
      receipt.menuItems = items;
      receipt.menuStyles = await read(
        `([...document.querySelectorAll('[role=menuitem]')].map(n=>({html:n.outerHTML,justify:getComputedStyle(n).justifyContent,shadow:getComputedStyle(n).boxShadow})))`,
      );
    };
    await win.loadFile(html);
    win.show();
    await focus();
    await until(
      'window.toolkitFrameProof?.ready && !!document.querySelector("[data-toolkit-id=frame]")',
    );
    if (mode === "baseline") {
      await click('[aria-label="Original draft"]');
      await focus();
      await read(
        `document.querySelector('[aria-label="Original draft"]').setSelectionRange(5,9)`,
      );
      const point = await read(
        `(()=>{const r=document.querySelector('[data-toolkit-id=frame]').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
      );
      win.webContents.sendInputEvent({ type: "mouseMove", ...point });
      await until('!!document.querySelector(".performance-popover")');
      assert.equal(
        await read(
          `document.activeElement===document.querySelector('[aria-label="Original draft"]')`,
        ),
        true,
        "Native hover preserves the original input",
      );
      receipt.hover = await read(
        `(()=>{const n=document.activeElement;return{value:n.value,selection:[n.selectionStart,n.selectionEnd]}})()`,
      );
      assert.deepEqual(receipt.hover, {
        value: "Keep the original draft",
        selection: [5, 9],
      });
      await key("Escape");
    }
    await frame("custom");
    await geometry();
    if (mode === "height" || mode === "wrap")
      throw Error("Loaded CSS mutation survived geometry");
    await capture(
      "custom-dark.png",
      "Actual UserToolkitResult, shared frame and same-window status bar",
    );
    await frame("long", 360, "light");
    await geometry();
    await menu();
    const count = await read(
      'toolkitFrameProof.effects.filter(x=>x.method==="run").length',
    );
    await capture(
      "long-menu-light.png",
      "Narrow full original labels and native menu focus",
    );
    await click('[role="menuitem"]');
    receipt.assertion = "original-action";
    assert.equal(
      await read(
        'toolkitFrameProof.effects.filter(x=>x.method==="run").length',
      ),
      count + 1,
      "Original menu primary calls the original toolkit API once",
    );
    if (mode === "action")
      throw Error("Loaded action mutation survived callback oracle");
    assert.equal(
      await read('!!document.querySelector(".performance-popover")'),
      true,
      "Menu item does not close its parent before invoking the action",
    );
    await menu();
    await key("Escape");
    assert.equal(
      await read('!!document.querySelector("[role=menu]")'),
      false,
      "First Escape closes only menu",
    );
    assert.equal(
      await read('!!document.querySelector(".performance-popover")'),
      true,
      "Original panel survives menu Escape",
    );
    assert.equal(
      await read(
        'document.activeElement===document.querySelector(".toolkit-actions__more")',
      ),
      true,
      "Menu Escape restores its invoking control",
    );
    await key("Escape");
    assert.equal(
      await read('!!document.querySelector(".performance-popover")'),
      false,
      "Second Escape closes parent",
    );
    await frame("unknown", 360);
    await geometry();
    assert.match(
      await read(
        'document.querySelector(".performance-actions > button").textContent',
      ),
      /Continue original request/,
    );
    await capture(
      "unknown-dark.png",
      "Original unconfirmed request and explicit continuation remain readable",
    );
    await frame("performance");
    await geometry();
    await capture(
      "performance-dark.png",
      "Actual Performance overview with Pause and original menu actions",
    );
    await menu();
    await read(
      `document.querySelectorAll('[role=menuitem]')[1].setAttribute('data-frame-script','')`,
    );
    await click("[data-frame-script]");
    await until('!!document.querySelector(".performance-script textarea")');
    await capture(
      "script-dark.png",
      "Actual Performance source reader and clipped frame corners without a footer",
    );
    await frame("phone", 360, "light");
    await geometry();
    await until('!!document.querySelector(".connection-link-code")');
    await capture(
      "phone-light.png",
      "Actual MobileConnectionResult and original compact footer",
    );
    await frame("tui");
    await capture(
      "tui-idle-dark.png",
      "Actual TUI result title in idle state; no terminal or Runtime qualification",
    );
    await frame("compact", 480);
    await geometry();
    await menu();
    await capture(
      "compact-menu-dark.png",
      "Actual compact Settings TUI consumer with full continuation labels and reachable menu",
    );
    receipt.effects = await read("toolkitFrameProof.effects");
    receipt.inputs = await read("toolkitFrameProof.inputs");
    assert.ok(
      receipt.inputs.some((event) => event.type === "click" && event.trusted),
    );
    assert.ok(
      receipt.inputs.some((event) => event.type === "keydown" && event.trusted),
    );
    assert.deepEqual(receipt.errors, []);
    receipt.completed = true;
  } catch (error) {
    receipt.failure = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    if (win && !win.isDestroyed())
      receipt.diagnostic = await win.webContents
        .executeJavaScript(
          `({inputs:window.toolkitFrameProof?.inputs,effects:window.toolkitFrameProof?.effects,focus:document.hasFocus(),active:document.activeElement?.outerHTML,body:document.body.innerHTML})`,
        )
        .catch((cause) => ({ failure: String(cause) }));
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    await fs.writeFile(
      path.join(evidence, "scene.json"),
      JSON.stringify(receipt, null, 2) + "\n",
    );
    app.exit(receipt.completed ? 0 : 1);
  }
});
