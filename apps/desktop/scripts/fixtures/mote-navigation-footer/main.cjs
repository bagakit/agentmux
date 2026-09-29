const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence, frameSelection] = process.argv.slice(2)
const narrowFrames = ['narrow-long-names-all-motes-cards', 'narrow-avatars-custom-original-draft']
const affectedEntryFrames = ['wide-closed-low-footer-circle', 'wide-hover-cards-original-input',
  ...narrowFrames, 'settings-bridge-original-mote-input-unsent', 'settings-retained-circle-entry-focus']
const selectedFrames = frameSelection ? JSON.parse(frameSelection) : null
const footerFrames = ['footer-320-dark-double-counts', 'footer-420-dark-double-counts',
  'footer-560-dark-double-counts', 'footer-980-dark-double-counts', 'footer-320-light-double-counts']
const resizeFrames = ['resize-wide-cards', 'resize-wide-avatars', 'resize-narrow-cards', 'resize-narrow-avatars', 'resize-storage-issue']
const floatingResize = selectedFrames?.[0] === resizeFrames[0]
const footerOnly = selectedFrames?.[0] === footerFrames[0]
if (selectedFrames) {
  const expected = floatingResize ? resizeFrames : footerOnly ? footerFrames : selectedFrames.length === 2 ? narrowFrames : affectedEntryFrames
  assert.deepEqual(selectedFrames, expected, 'Capture filtering must retain the reviewed bounded scenario selection')
}
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, pid: process.pid, frames: [], checks: [],
  replayedFrames: [],
  scope: floatingResize ? 'One actual production App Renderer: trusted CDP pointer drag and keyboard; DOM-dispatched pointercancel/blur boundaries; UI storage failure/recovery and private reload. Five complete frames, no OS/Core Run claim.' : footerOnly ? 'Only actual Footer count geometry: four widths and four count variants; five actual complete Renderer frames. No rail/Settings/native/OS/Core Run sign-off.' : selectedFrames?.length === 2 ? 'All original interactions and assertions replayed; two affected narrow Renderer frames captured from an explicitly derived CSS archive.' : selectedFrames ?
    'New actual Renderer compile; all original interactions and assertions replayed; six affected Entry/Settings/narrow frames captured.' :
    'Eight actual Renderer frames in one private process. Controlled public data; no native/OS/Core Run sign-off.' }
let win
const selectors = {
  entry: '[data-pmo-teams-topic-launcher] button', panel: '[data-pmo-teams-topic-floating]',
  toggle: '[data-pmo-teams-topic-floating] [aria-label="Show Mote avatars only"]',
  resize: '[data-pmo-teams-topic-floating] [aria-label="Resize Mote window"]',
  close: '[data-pmo-teams-topic-floating] [aria-label="Close Mote"]',
  prompt: '[data-pmo-teams-topic-floating] [aria-label="Message Agent"]',
  settings: '.surface-navigation__settings[aria-label="Settings"]'
}
app.whenReady().then(async () => {
  const read = expression => win.webContents.executeJavaScript(expression)
  const call = (method, ...args) => read(`window.motePresentationReview[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
  const facts = () => call('facts')
  const until = async (expression, label) => {
    const end = Date.now() + 5000
    do {
      if (await read(expression)) return
      await new Promise(resolve => setTimeout(resolve, 25))
    } while (Date.now() < end)
    throw new Error('Stage did not settle: ' + label)
  }
  const input = (method, parameters) => win.webContents.debugger.sendCommand(method, parameters)
  const point = selector => read(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})]
    if (nodes.length !== 1) throw new Error('Expected one actual control: ' + ${JSON.stringify(selector)})
    const r = nodes[0].getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) throw new Error('Actual control is not visible')
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  const move = async position => input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position })
  const click = async selector => {
    const position = await point(selector); await move(position)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await input('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...position })
    }
  }
  const key = async (name, code) => {
    for (const type of ['keyDown', 'keyUp']) {
      await input('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code })
    }
  }
  const paint = async () => {
    await read('Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))')
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  }
  const capture = async name => {
    await paint()
    const one = await facts()
    assert.equal(one.errors.length, 0, 'Unexpected Renderer/controlled-data error')
    const actualCss = await read(`(() => {
      const panel = document.querySelector(${JSON.stringify(selectors.panel)})
      if (!panel?.matches(':popover-open')) return null
      const rect = node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom } }
      const describe = node => {
        if (!node) return null
        const s = getComputedStyle(node)
        return { rect:rect(node), display:s.display, width:s.width, minWidth:s.minWidth, fontSize:s.fontSize,
          lineHeight:s.lineHeight, overflowWrap:s.overflowWrap, whiteSpace:s.whiteSpace, position:s.position, zIndex:s.zIndex }
      }
      const editor = panel.querySelector('[aria-label="Message Agent"]')
      const composer = editor?.closest('[data-agent-composer]')
      const tip = panel.querySelector('.mote-chooser__identity[role="tooltip"]')
      const controls = [...(composer?.querySelectorAll('button') ?? [])].map(node => ({ label:node.getAttribute('aria-label') || node.textContent, ...describe(node) }))
      return { body:describe(panel.querySelector('.pmo-teams-topic-floating__content')), composer:describe(composer), editor:describe(editor),
        draft:editor?.value ?? editor?.textContent, toolbar:describe(composer?.querySelector('.composer__toolbar')),
        controls, tip:describe(tip), tipPointerEvents:tip ? getComputedStyle(tip).pointerEvents : null }
    })()`)
    result.replayedFrames.push({ name, captured: !selectedFrames || selectedFrames.includes(name),
      appearance: one.ui.appearance, rail: one.ui.rail, panel: one.ui.panelRect,
      identityTip: one.ui.identityTip, actualCss, input: one.ui.input && { rect: one.ui.input.rect, text: one.ui.input.text, token: one.ui.input.token } })
    if (selectedFrames && !selectedFrames.includes(name)) return
    const image = await win.webContents.capturePage(), bytes = image.toPNG(), file = name + '.png'
    fs.writeFileSync(path.join(evidence, file), bytes)
    const dimensions = image.getSize()
    assert.ok(dimensions.width > 0 && dimensions.height > 0)
    result.frames.push({ name, file, sha256: createHash('sha256').update(bytes).digest('hex'), dimensions, facts: one, actualCss })
  }
  const circle = one => {
    const { entryRect: entry, entryWrapperRect: hitbox, entryPaintRect: painted, footerRect: footer, avatarRect: avatar, statusRect: status } = one.ui
    assert.ok(entry && hitbox && painted && footer && avatar && status, 'Actual invoker/paint/footer/avatar/state geometry is nonempty')
    assert.ok(entry.width > 0 && entry.height > 0)
    assert.equal(entry.width, entry.height, 'The actual invoker has a complete square hitbox')
    assert.deepEqual(hitbox, entry, 'The original wrapper retains the complete entry hitbox')
    assert.equal(one.ui.entryPaintNodeCount, 1, 'There is only one actual mounted opaque paint surface')
    assert.deepEqual(painted, entry, 'The round paint and original full button have the same bounding geometry')
    assert.equal(parseFloat(one.ui.entryCollector.invokerRadius), 0, 'The actual native invoker retains the square corner hitbox')
    assert.equal(one.ui.entryCollector.invokerBackground, 'rgba(0, 0, 0, 0)', 'The square invoker is transparent and not projected as chrome')
    assert.equal(one.ui.entryPaint.pointerEvents, 'none', 'Actual input belongs to the original button, not a second inner owner')
    assert.equal(one.ui.entryPaint.dataState, 'open', 'The painted node exposes the unchanged generic collector fact')
    assert.equal(one.ui.entryPaint.opacity, '1')
    assert.match(one.ui.entryPaint.background, /^rgb\(/, 'The round projected surface is actually opaque')
    const radius = parseFloat(one.ui.entryPaint.radius)
    assert.ok(radius >= painted.width / 2, 'The actual opaque inner surface paints a circle')
    assert.equal(one.ui.entryCollector.matchingRegions.length, 1, 'The actual collector publishes one matching round region')
    assert.equal(one.ui.entryCollector.matchingRegions[0].radius, radius * one.ui.entryCollector.zoomFactor, 'Paint and original collector radius agree at the actual private zoom')
    assert.ok(footer.height < 32, 'The whole bar is lower than the old 32px contract')
    assert.ok(entry.y < footer.y, 'Only Mote is locally raised above the low bar')
    assert.ok(entry.bottom <= footer.bottom, 'Local lift stays within the window')
    for (const part of [avatar, status]) {
      assert.ok(part.width > 0 && part.height > 0)
      assert.ok(part.x >= entry.x && part.right <= entry.right && part.y >= entry.y && part.bottom <= entry.bottom)
    }
    assert.ok(one.ui.ordinarySlots.length > 0, 'Ordinary footer consumers are nonempty')
    for (const slot of one.ui.ordinarySlots) {
      assert.ok(slot.rect.width > 0 && slot.rect.height > 0, 'Ordinary hit area remains visible')
      assert.ok(slot.rect.y >= footer.y && slot.rect.bottom <= footer.bottom, 'Ordinary consumers stay in the low bar')
      assert.ok(slot.rect.x >= hitbox.right || slot.rect.right <= hitbox.x, 'Complete box does not overlap a neighboring hit area')
    }
  }
  const allMotes = async one => {
    const ids = await read('window.motePresentationReview.moteIds')
    assert.equal(ids.length, 3)
    assert.deepEqual(one.ui.choices.map(choice => choice.id), ids, 'Both forms use the entire original Mote directory')
    assert.ok(one.ui.railRect?.width > 0 && one.ui.bodyRect?.width > 0, 'Real rail and original body both have positive area')
    assert.ok(one.ui.railRect.right <= one.ui.bodyRect.x, 'Objects stay left of the original Tab/Region work surface')
    for (const choice of one.ui.choices) {
      assert.ok(choice.name && choice.status && choice.rect.width > 0 && choice.rect.height > 0)
      assert.ok(choice.rect.x >= one.ui.panelRect.x && choice.rect.right <= one.ui.panelRect.right)
    }
    assert.equal(one.ui.titleRows, 0)
    assert.equal(one.ui.globalChrome, 0)
    assert.equal(one.ui.panelInert, false, 'Actual Panel is outside dormant workspace ownership')
    assert.ok(one.ui.input?.rect.width > 0 && one.ui.input.rect.height > 0, 'Actual original Composer is present')
  }
  const bridge = async () => {
    const one = await facts(), first = one.ui.choices[0].rect
    await move({ x: one.ui.entryRect.x + one.ui.entryRect.width / 2, y: one.ui.panelRect.bottom + 3 })
    await move({ x: first.x + first.width / 2, y: first.y + first.height / 2 })
    await new Promise(resolve => setTimeout(resolve, 230))
    assert.equal((await facts()).ui.visible, true, 'Actual pointer crossing keeps preview usable')
  }
  const hover = async () => {
    await move(await point(selectors.entry))
    await until('window.motePresentationReview.facts().ui.visible && window.motePresentationReview.facts().ui.choices.length === 3', 'hover/all objects')
    await paint(); await bridge()
  }
  const forbidden = one => one.calls.filter(call => ['warm', 'launch', 'apiLaunch', 'apiLaunchTerminal', 'send', 'queue', 'stop', 'write', 'submit'].includes(call.operation))
  const rail = async value => {
    if ((await facts()).ui.rail !== value) await click(selectors.toggle)
    await until(`window.motePresentationReview.facts().ui.rail === ${JSON.stringify(value)}`, 'actual rail form')
    assert.equal((await facts()).ui.railControl, value === 'avatars' ? 'true' : 'false')
  }
  try {
    result.stage = 'load-actual-production-app'
    win = new BrowserWindow({ width: 980, height: 740, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html)
    await until('window.motePresentationReview?.ready && window.motePresentationReview.facts().ready', 'actual App/footer ready')
    win.webContents.debugger.attach('1.3')
    await input('Emulation.setFocusEmulationEnabled', { enabled: true })
    if (floatingResize) {
      result.stage = 'actual-floating-resize'
      await hover(); await click(selectors.prompt); await paint()
      const original = await facts(), anchor = { x: original.ui.panelRect.x, offset: original.ui.entryRect.y - original.ui.panelRect.bottom }
      const record = async label => {
        const one = await facts()
        assert.equal(one.errors.length, 0); assert.equal(forbidden(one).length, 0)
        assert.deepEqual(one.protected, original.protected, 'Resize preserves original Tabs, layout, draft, execution and view facts')
        assert.equal(one.ui.tabId, original.ui.tabId); assert.equal(one.ui.input.token, original.ui.input.token)
        assert.equal(one.ui.input.text, original.ui.input.text)
        const p = one.ui.panelRect, h = one.ui.resizeRect
        assert.ok(p && h && h.width > 0 && h.height > 0, 'Actual corner handle has a positive hit area')
        assert.ok(p.x >= 7.9 && p.y >= 7.9 && p.right <= win.getContentSize()[0] - 7.9, 'Effective panel fits current viewport horizontally and above')
        assert.ok(Math.abs(p.x - anchor.x) <= .2 && Math.abs(p.bottom + anchor.offset - one.ui.entryRect.y) <= .2, 'Resize preserves original left/bottom anchor and offset')
        await allMotes(one)
        const controls = one.ui.actions
        assert.ok(one.ui.actions.length === 3 && one.ui.workfaceControls.length > 0, 'Original navigation, Tab actions and Composer consumers are nonempty')
        for (const control of controls) {
          const r = control.rect
          assert.ok(r.width > 0 && r.height > 0 && r.x >= p.x - .1 && r.right <= p.right + .1 && r.y >= p.y - .1 && r.bottom <= p.bottom + .1, 'Original visible action/input is contained in actual panel: ' + control.label)
          assert.ok(h.right <= r.x + .1 || r.right <= h.x + .1 || h.bottom <= r.y + .1 || r.bottom <= h.y + .1, 'Corner handle does not overlap original action/input: ' + control.label)
        }
        const hits = await read(`(() => {
          const handle = document.querySelector(${JSON.stringify(selectors.resize)})
          const r = handle.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
          const controls = [...document.querySelectorAll(${JSON.stringify(selectors.panel + ' .mote-chooser__actions button')})]
          const body = document.querySelector(${JSON.stringify(selectors.panel + ' .pmo-teams-topic-floating__content')})
          const visible = n => { const b=n.getBoundingClientRect(), s=getComputedStyle(n);return b.width>0&&b.height>0&&s.visibility==='visible'&&Number(s.opacity)>0 }
          const required = [...body.querySelectorAll('.pane-tabbar__actions button, .workbench-tab-strip__nav, [data-agent-composer] button, [aria-label="Message Agent"]')].filter(visible)
          const essentialInput = body.querySelector('[aria-label="Message Agent"]')
          const essentialNewTab = body.querySelector('button[title="New tab"]')
          const active = body.querySelector('.workbench-tab--active')
          // Required input/New tab bypass visibility filtering: missing, hidden,
          // clipped or zero-area consumers must fail rather than disappear.
          const bodyControls = [...new Set([essentialInput, essentialNewTab, ...required, active])]
          const p = document.querySelector(${JSON.stringify(selectors.panel)}).getBoundingClientRect()
          return { essentialInputFound:!!essentialInput, essentialNewTabFound:!!essentialNewTab, handle: hit === handle || handle.contains(hit), actions: controls.map(n => { const b=n.getBoundingClientRect(); return n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)) }),
            body:bodyControls.map(n=>{
              if(!n)return {label:'missing active Tab/input',hit:false,contained:false}
              const b=n.getBoundingClientRect();let left=b.left,right=b.right,top=b.top,bottom=b.bottom
              // A scrollable Tab owns a clipped viewport. Test its actual visible
              // intersection, while preserving all raw rectangles in facts.
              if(n===active){const clip=n.closest('.pane-tabbar__tabs').getBoundingClientRect();left=Math.max(left,clip.left);right=Math.min(right,clip.right);top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.bottom)}
              const h=document.elementFromPoint((left+right)/2,(top+bottom)/2)
              return {label:n.getAttribute('aria-label')??n.textContent,rect:{left,right,top,bottom},positive:right>left&&bottom>top,
                contained:left>=p.left-.1&&right<=p.right+.1&&top>=p.top-.1&&bottom<=p.bottom+.1,
                hit:!!h&&(h===n||n.contains(h)),hitNode:h?.outerHTML.slice(0,220)}
            }) }
        })()`)
        assert.equal(hits.handle, true, 'Real corner is hit-testable'); assert.equal(hits.actions.length, 3); assert.deepEqual(hits.actions, [true, true, true]); assert.equal(hits.essentialInputFound, true, 'Required original Message Agent exists'); assert.equal(hits.essentialNewTabFound, true, 'Required original New tab exists'); assert.ok(hits.body.length >= 2, 'Input and original Tab controls are nonempty'); for (const hit of hits.body) { assert.equal(hit.positive, true, 'Required body control has visible area: ' + hit.label); assert.equal(hit.contained, true, 'Required body control is contained: ' + hit.label); assert.equal(hit.hit, true, 'Original body control center is operable: ' + hit.label + ' / ' + hit.hitNode) }
        result.checks.push({ label, viewport: win.getContentSize(), saved: one.saved, floating: one.floating, ui: one.ui, hits })
        return one
      }
      let pressed, oldSaved, oldStyles
      const start = async () => {
        pressed = await point(selectors.resize)
        const before = await facts(); oldSaved = before.saved; oldStyles = before.ui.bodyStyles
        await move(pressed); await input('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...pressed })
        await until('window.motePresentationReview.facts().ui.resizing === "true"', 'real pointer gesture started')
        assert.equal(await read(`document.querySelector(${JSON.stringify(selectors.resize)}).hasPointerCapture(1)`), true, 'Trusted mouse owns actual pointer capture')
      }
      const draft = async (width, height) => {
        const current = await facts(), p = current.ui.panelRect
        await input('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: pressed.x + width - p.width, y: pressed.y + p.height - height })
        await paint()
        assert.deepEqual((await facts()).saved, oldSaved, 'Pointer draft never writes durable preferences')
      }
      const release = async () => {
        await input('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...pressed }); await paint()
        const one = await facts()
        assert.equal(one.ui.resizing, 'false'); assert.deepEqual(one.ui.bodyStyles, oldStyles, 'End restores cursor and selection styles')
        return one
      }
      const resize = async (width, height) => { await start(); await draft(width, height); return release() }
      let one = await resize(620, 430)
      assert.deepEqual(one.saved.size, { width: 620, height: 430 }); assert.equal(one.ui.panelRect.width, 620); assert.equal(one.ui.panelRect.height, 430)
      await record('wide cards drag committed'); await capture('resize-wide-cards')
      await rail('avatars'); await resize(610, 420); await record('wide avatars drag committed'); await capture('resize-wide-avatars')
      await rail('cards'); await resize(1, 1); one = await record('wide cards lower bound')
      assert.equal(one.ui.panelRect.width, 404); assert.equal(one.ui.panelRect.height, 250)
      await rail('avatars'); await resize(1, 1); one = await record('wide avatars lower bound')
      assert.equal(one.ui.panelRect.width, 288); assert.equal(one.ui.panelRect.height, 250)
      await resize(9000, 9000); one = await record('viewport upper bound'); assert.ok(one.ui.panelRect.width <= 964 && one.ui.panelRect.height <= 740)
      await resize(620, 650); const preference = (await facts()).saved.size
      win.setContentSize(420, 460); await paint(); await rail('cards')
      one = await record('narrow cards viewport clamp'); assert.deepEqual(one.saved.size, preference)
      await start(); await release(); assert.deepEqual((await facts()).saved.size, preference, 'No-motion click does not persist the temporary viewport clamp')
      const effective = (await facts()).ui.panelRect
      await resize(380, effective.height); one = await record('horizontal drag preserves unclamped height preference')
      assert.deepEqual(one.saved.size, { width:380, height:preference.height })
      win.setContentSize(980, 740); await paint(); await resize(620, 650)
      win.setContentSize(420, 460); await paint(); one = await facts()
      await resize(one.ui.panelRect.width, 400); one = await record('vertical drag preserves unclamped width preference')
      assert.deepEqual(one.saved.size, { width:620, height:400 })
      await resize(380, 390); one = await record('both axes commit explicit bounded changes')
      assert.deepEqual(one.saved.size, { width:380, height:390 })
      win.setContentSize(420, 740); await paint()
      await resize(1, 1); one = await record('narrow cards lower bound'); assert.equal(one.ui.panelRect.width, 368); assert.equal(one.ui.panelRect.height, 250)
      await resize(395, 430); await record('narrow cards real drag'); await capture('resize-narrow-cards')
      await rail('avatars'); await resize(350, 430); await record('narrow avatars real drag'); await capture('resize-narrow-avatars')
      const narrowPreference = (await facts()).saved.size
      win.setContentSize(240, 220); await paint()
      one = await facts(); assert.ok(one.ui.panelRect.width <= 224 && one.ui.panelRect.height < 250, 'Available viewport wins when smaller than the normal minimum')
      assert.ok(one.ui.panelRect.x >= 7.9 && one.ui.panelRect.y >= 7.9 && one.ui.panelRect.bottom <= 220)
      assert.deepEqual(one.saved.size, narrowPreference, 'Small viewport clamp leaves preferred size unchanged')
      result.checks.push({ label: 'small viewport below minimum', viewport: win.getContentSize(), saved: one.saved, panel: one.ui.panelRect })
      win.setContentSize(980, 740); await paint(); one = await record('viewport expands to saved preference')
      assert.deepEqual({ width: one.ui.panelRect.width, height: one.ui.panelRect.height }, narrowPreference)
      for (const termination of ['Escape', 'pointercancel', 'blur']) {
        await start(); await draft(one.ui.panelRect.width + 30, one.ui.panelRect.height + 20)
        if (termination === 'Escape') { await read(`document.querySelector(${JSON.stringify(selectors.resize)}).focus()`); await key('ArrowRight', 39); assert.deepEqual((await facts()).saved, oldSaved); await key('Escape', 27) }
        else if (termination === 'pointercancel') await read(`document.querySelector(${JSON.stringify(selectors.resize)}).dispatchEvent(new PointerEvent('pointercancel', { bubbles:true, pointerId:1, pointerType:'mouse' }))`)
        else await read('window.dispatchEvent(new Event("blur"))')
        await paint(); one = await record('cancel ' + termination)
        assert.equal(one.ui.resizing, 'false'); assert.equal(one.ui.presentation, 'pinned'); assert.deepEqual(one.saved, oldSaved); assert.deepEqual(one.ui.bodyStyles, oldStyles)
        await input('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...pressed })
      }
      const beforeKeyboard = one.saved.size
      await read(`document.querySelector(${JSON.stringify(selectors.resize)}).focus()`); await key('ArrowRight', 39); await paint()
      one = await record('keyboard resize outside gesture'); assert.equal(one.saved.size.width, beforeKeyboard.width + 10)
      await call('preferenceSaveFailure', true); const durableBeforeFailure = one.saved.size
      await resize(one.ui.panelRect.width + 20, one.ui.panelRect.height + 20)
      one = await record('failed storage retains live preference and original work')
      assert.match(one.ui.preferenceNotice, /could not be saved/); assert.deepEqual(one.saved.size, durableBeforeFailure)
      assert.notDeepEqual(one.floating.size, one.saved.size); await capture('resize-storage-issue')
      await call('preferenceSaveFailure', false); await resize(one.ui.panelRect.width + 10, one.ui.panelRect.height + 10)
      one = await record('storage recovered on next explicit resize'); assert.equal(one.ui.preferenceNotice, null); assert.deepEqual(one.saved.size, one.floating.size)
      const restoredPreference = one.saved, target = one.ui.tabId
      await click(selectors.close); await click(selectors.entry); await paint()
      one = await record('close and reopen retained size'); assert.deepEqual(one.saved.size, restoredPreference.size)
      const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve)); win.reload(); await reloaded
      await until('window.motePresentationReview?.ready && window.motePresentationReview.facts().ui.visible && window.motePresentationReview.facts().ui.input', 'private Renderer reload restored Mote')
      await input('Emulation.setFocusEmulationEnabled', { enabled: true }); await paint()
      one = await facts()
      assert.equal(one.errors.length, 0); assert.equal(forbidden(one).length, 0); assert.equal(one.ui.tabId, target)
      assert.deepEqual(one.saved, restoredPreference); assert.deepEqual(one.floating.size, restoredPreference.size)
      assert.deepEqual({ width:one.ui.panelRect.width, height:one.ui.panelRect.height }, restoredPreference.size)
      result.checks.push({ label:'private Renderer reload reads real saved preference; fixture seed is first-load only', saved:one.saved, floating:one.floating, ui:one.ui })
      assert.equal(result.frames.length, resizeFrames.length)
      result.events = await call('events'); result.passed = true; result.stage = 'floating-resize-captured-look-pending'
      return
    }
    if (footerOnly) {
      result.stage = 'actual-footer-count-containment'
      const geometry = () => read(`(() => {
        const rect = node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom } }
        const footer = document.querySelector('.window-status-bar')
        const focus = footer.querySelector('.surface-navigation__focus')
        if (!focus) throw new Error('Actual Focus button is missing')
        const badges = [...focus.querySelectorAll('[data-focus-count]')].map(node => {
          const text = [...node.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())
          if (!text) throw new Error('Actual badge number is missing')
          const range = document.createRange(); range.selectNodeContents(text)
          return { kind:node.dataset.focusCount, text:text.textContent, rect:rect(node), number:rect(range), icons:[...node.querySelectorAll('svg')].map(rect) }
        })
        return { viewport:{ width:innerWidth, height:innerHeight }, footer:rect(footer), focus:rect(focus), badges,
          focusIcons:[...focus.querySelectorAll('svg')].map(rect),
          buttons:[...footer.querySelectorAll('button')].filter(node => !node.closest('[popover]'))
            .map(node => ({ label:node.getAttribute('aria-label'), rect:rect(node) })) }
      })()`)
      const within = (part, owner, label) => {
        assert.ok(part.width > 0 && part.height > 0, label + ' has positive area')
        assert.ok(part.x >= owner.x - .1 && part.right <= owner.right + .1 && part.y >= owner.y - .1 && part.bottom <= owner.bottom + .1, label + ' fits its original button')
      }
      const check = async (width, working, attention) => {
        await call('footerCounts', working, attention); await paint()
        const one = await facts(), measured = await geometry()
        const expected = [...(working ? [{kind:'working', text:String(working)}] : []), ...(attention ? [{kind:'attention', text:String(attention)}] : [])]
        assert.deepEqual(measured.badges.map(({kind,text}) => ({kind,text})), expected, 'Actual badges match nonzero public facts, including explicit zero absence')
        assert.equal(measured.viewport.width, width)
        assert.equal(measured.footer.height, 24)
        assert.equal(measured.focusIcons.length, 1 + expected.length, 'Original Focus icon and each actual count icon are nonempty')
        for (const icon of measured.focusIcons) within(icon, measured.focus, 'Focus icon')
        for (const badge of measured.badges) {
          within(badge.rect, measured.focus, 'Focus badge'); within(badge.number, measured.focus, 'Focus count text')
          assert.equal(badge.icons.length, 1)
        }
        assert.ok(measured.buttons.length >= 7, 'Actual surface, Settings and right-side consumers are nonempty')
        for (const button of measured.buttons) {
          within(button.rect, measured.footer, button.label)
          assert.equal(button.rect.height, 22, 'Ordinary actions retain the low bar height')
        }
        for (let first = 0; first < measured.buttons.length; first++) for (let next = first + 1; next < measured.buttons.length; next++) {
          const a = measured.buttons[first].rect, b = measured.buttons[next].rect
          assert.ok(a.right <= b.x + .1 || b.right <= a.x + .1, 'Actual footer buttons do not overlap')
        }
        circle(one)
        assert.equal(forbidden(one).length, 0, 'Footer observation does not launch, stop or send')
        result.checks.push({ width, working, attention, measured })
      }
      for (const width of [320, 420, 560, 980]) {
        win.setContentSize(width, 740); await paint()
        for (const [working, attention] of [[0,0], [1,0], [0,1], [123,123]]) await check(width, working, attention)
        await capture('footer-' + width + '-dark-double-counts')
      }
      win.setContentSize(320, 740); await call('theme', 'light'); await paint()
      await capture('footer-320-light-double-counts')
      assert.equal(result.checks.length, 16)
      assert.equal(result.frames.length, footerFrames.length)
      result.passed = true; result.stage = 'footer-counts-captured-look-pending'
      return
    }
    await until('document.querySelector(`[data-workbench-tab-id="${window.motePresentationReview.backgroundId}"] [aria-label="Message Agent"]`) !== null', 'original project Composer ready')
    await call('focusBackground'); await paint()
    const closed = await facts(); circle(closed)
    await capture('wide-closed-low-footer-circle')

    result.stage = 'wide-hover-card-rail-and-original-focus'
    await hover()
    let one = await facts(); circle(one); await allMotes(one)
    assert.equal(one.ui.rail, 'cards'); assert.equal(one.ui.panelRect.width, 720)
    assert.deepEqual(one.protected, closed.protected)
    assert.deepEqual(one.ui.active, closed.ui.active, 'Hover keeps original DOM input/caret')
    assert.deepEqual(one.saved, closed.saved)
    assert.equal(forbidden(one).length, 0)
    await capture('wide-hover-cards-original-input')

    result.stage = 'actual-control-avatar-form-and-original-composer'
    const inputToken = one.ui.input.token, target = one.ui.tabId
    await rail('avatars'); await paint()
    one = await facts(); await allMotes(one)
    assert.equal(one.ui.input.token, inputToken, 'Rail form keeps the original projected Composer')
    assert.equal(one.ui.tabId, target)
    assert.deepEqual(one.protected.execution, closed.protected.execution)
    assert.deepEqual(one.protected.viewModes, closed.protected.viewModes)
    assert.equal(forbidden(one).length, 0)
    await capture('wide-avatars-pinned-original-composer')

    result.stage = 'light-theme-real-boundary'
    await rail('cards'); await call('theme', 'light'); await paint()
    one = await facts(); assert.equal(one.ui.appearance, 'light')
    await allMotes(one); await capture('wide-light-cards-clear-edge')

    result.stage = 'narrow-long-names-whole-card-directory'
    await call('theme', 'dark'); await call('longNames')
    win.setContentSize(420, 740); await paint()
    one = await facts(); circle(one); await allMotes(one)
    assert.equal(one.ui.appearance, 'dark')
    assert.equal(one.ui.rail, 'cards', 'Viewport does not silently override presentation preference')
    assert.ok(one.ui.panelRect.x >= 0 && one.ui.panelRect.right <= 420)
    await capture('narrow-long-names-all-motes-cards')

    result.stage = 'narrow-avatar-exact-custom-original-draft'
    await rail('avatars')
    const customId = await read('window.motePresentationReview.customMoteId')
    const customChoice = `[data-mote-topic-id=${JSON.stringify(customId)}]`
    await move(await point(customChoice))
    await until('window.motePresentationReview.facts().ui.identityTip !== null', 'actual long-name hover identity')
    one = await facts()
    const customName = one.ui.choices.find(choice => choice.id === customId).name
    assert.equal(one.ui.identityTip.text, customName, 'Hover shows the original full name and current state')
    await click(customChoice)
    await until(`window.motePresentationReview.facts().ui.topicId === ${JSON.stringify(customId)}`, 'original custom projection')
    await paint(); one = await facts(); await allMotes(one); circle(one)
    assert.equal(one.ui.tabId, await read('window.motePresentationReview.customTabId'))
    assert.equal(one.ui.input.text, one.protected.drafts[one.ui.sessionId])
    const customInput = one.ui.input.token, customDraft = one.ui.input.text
    // Clear the pointer-owned hint, then exercise the actual button's separate
    // DOM focus handler. No fixture-owned tooltip or manual focus event.
    await click(selectors.prompt)
    await until('window.motePresentationReview.facts().ui.identityTip === null', 'pointer hint leaves')
    await read(`document.querySelector(${JSON.stringify(customChoice)}).focus()`)
    await until('window.motePresentationReview.facts().ui.identityTip !== null', 'actual long-name focus identity')
    await paint(); one = await facts()
    assert.equal(one.ui.identityTip.text, customName)
    assert.ok(one.ui.identityTip.rect.width > 0 && one.ui.identityTip.rect.height > 0)
    assert.equal(one.ui.input.token, customInput)
    assert.equal(one.ui.input.text, customDraft)
    assert.equal(one.ui.active.label, customName)
    await capture('narrow-avatars-custom-original-draft')

    result.stage = 'actual-settings-hover-and-original-input'
    win.setContentSize(980, 740); await click(selectors.close)
    await until('!window.motePresentationReview.facts().ui.visible', 'close original Mote')
    await click(selectors.settings)
    await until('window.motePresentationReview.facts().ui.settings', 'actual Settings')
    await paint(); const settings = await facts()
    assert.equal(settings.ui.backgroundInert, true)
    await hover(); one = await facts(); await allMotes(one)
    assert.equal(one.ui.settings, true); assert.equal(one.ui.panelInert, false)
    assert.deepEqual(one.ui.active, settings.ui.active, 'Settings hover preserves original focus/caret')
    assert.deepEqual(one.protected, settings.protected)
    assert.deepEqual(one.saved, settings.saved)
    const oldDraft = one.protected.drafts[one.ui.sessionId], text = ' — private input remains unsent'
    await click(selectors.prompt); await input('Input.insertText', { text }); await paint()
    one = await facts(); assert.equal(one.ui.settings, true)
    assert.equal(one.protected.drafts[one.ui.sessionId].replace(text, ''), oldDraft)
    assert.equal(one.ui.input.text, one.protected.drafts[one.ui.sessionId])
    assert.deepEqual(one.protected.execution, settings.protected.execution)
    assert.deepEqual(one.protected.viewModes, settings.protected.viewModes)
    assert.equal(forbidden(one).length, 0, 'Typed draft never launches, queues or sends')
    await capture('settings-bridge-original-mote-input-unsent')

    result.stage = 'settings-retained-and-keyboard-entry-focus'
    await click(selectors.close)
    await until('!window.motePresentationReview.facts().ui.visible', 'close to original Settings')
    // Escape is sent only while the actual Mote preview owns it, so Settings'
    // own Escape behavior is neither bypassed nor redefined by the fixture.
    await hover(); await key('Escape', 27)
    await until('!window.motePresentationReview.facts().ui.visible', 'preview Escape')
    assert.equal((await facts()).ui.settings, true)
    // One trusted Tab selects keyboard modality. Programmatic focus only locates
    // the actual Entry; it does not claim physical tab-order or OS input proof.
    await key('Tab', 9)
    await read(`document.querySelector(${JSON.stringify(selectors.entry)}).focus()`)
    await paint(); one = await facts(); circle(one)
    assert.equal(one.ui.entryPaint.focusVisible, true, 'The actual keyboard focus ring is present')
    assert.equal(one.ui.settings, true, 'Mote closing does not dismiss Settings')
    await capture('settings-retained-circle-entry-focus')
    result.final = await facts(); result.events = await call('events'); result.publications = await call('publications')
    assert.ok(result.events.length > 0)
    assert.ok(result.events.some(event => event.trusted && event.type === 'pointerdown'), 'Actual trusted input is recorded')
    assert.equal(result.replayedFrames.length, 8, 'The original actual interaction and assertion sequence is retained')
    assert.equal(result.frames.length, selectedFrames ? selectedFrames.length : 8)
    result.passed = true; result.stage = 'renderer-captured-look-pending'
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally {
    if (win && !win.isDestroyed()) {
      result.lastFacts = await facts().catch(error => ({ unavailable: error.message }))
      result.events ??= await call('events').catch(() => [])
      result.publications ??= await call('publications').catch(() => [])
      win.destroy()
    }
    fs.writeFileSync(path.join(evidence, 'renderer.json'), JSON.stringify(result, null, 2))
    app.exit(result.passed ? 0 : 1)
  }
})
