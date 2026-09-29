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
const footerOnly = selectedFrames?.[0] === footerFrames[0]
if (selectedFrames) {
  const expected = footerOnly ? footerFrames : selectedFrames.length === 2 ? narrowFrames : affectedEntryFrames
  assert.deepEqual(selectedFrames, expected, 'Capture filtering must retain the reviewed bounded scenario selection')
}
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, pid: process.pid, frames: [], checks: [],
  replayedFrames: [],
  scope: footerOnly ? 'Only actual Footer count geometry: four widths and four count variants; five actual complete Renderer frames. No rail/Settings/native/OS/Core Run sign-off.' : selectedFrames?.length === 2 ? 'All original interactions and assertions replayed; two affected narrow Renderer frames captured from an explicitly derived CSS archive.' : selectedFrames ?
    'New actual Renderer compile; all original interactions and assertions replayed; six affected Entry/Settings/narrow frames captured.' :
    'Eight actual Renderer frames in one private process. Controlled public data; no native/OS/Core Run sign-off.' }
let win
const selectors = {
  entry: '[data-pmo-teams-topic-launcher] button', panel: '[data-pmo-teams-topic-floating]',
  toggle: '[data-pmo-teams-topic-floating] [aria-label="Show Mote avatars only"]',
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
