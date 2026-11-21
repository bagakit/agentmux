const { app, BrowserWindow } = require('electron'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  { createHash } = require('node:crypto')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
let win
const result = {
  schema: 'agentmux.mailbox-badge-native.v2',
  passed: false,
  userRunTouched: false,
  captureOnly: true,
  aestheticReview: 'not-performed',
  frames: [],
  scenes: [],
  mutations: [],
  keyboard: [],
  console: []
}
const surface = `document.querySelector('[data-workbench-region-id="result-input-owner"] .agent-surface')`,
  trigger = `${surface}.querySelector('.composer__mailbox')`,
  popover = `${surface}.querySelector('.composer-mailbox:popover-open')`
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
async function evaluate(expression) {
  const value = await win.webContents.executeJavaScript(
    `
      ;(async () => {
        try {
          return await eval(${JSON.stringify(expression)})
        } catch (error) {
          return {
            __probeError: true,
            name: error.name,
            message: error.message,
            stack: error.stack
          }
        }
      })()
    `
  )
  if (value?.__probeError) {
    const error = new Error(value.message)
    error.name = value.name
    error.stack = value.stack
    throw error
  }
  return value
}
async function waitFor(expression) {
  for (let i = 0; i < 160; i++) {
    if (await evaluate(expression)) return
    await delay(25)
  }
  assert.fail('Actual Renderer fact did not arrive: ' + expression)
}
async function painted() {
  await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  await delay(30)
}
async function click(expression) {
  const p = await evaluate(
    `
      ;(() => {
        const e = ${expression}
        if (!e) throw Error('Missing actual click target')
        e.scrollIntoView({ block: 'nearest' })
        const r = e.getBoundingClientRect()
        const p = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        if (!e.contains(document.elementFromPoint(p.x, p.y)))
          throw Error('Original target is occluded')
        return p
      })()
    `
  )
  for (const type of ['mousePressed', 'mouseReleased'])
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type,
      ...p,
      button: 'left',
      clickCount: 1
    })
  await painted()
}
async function geometry() {
  return evaluate(
    `
      ;(() => {
        const s = ${surface},
          t = ${trigger},
          rect = (e) => {
            if (!e) return null
            const r = e.getBoundingClientRect()
            return {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              right: r.right,
              bottom: r.bottom
            }
          },
          b = t.querySelector('.composer-mailbox__unread')
        let text = null
        if (b) {
          const range = document.createRange()
          range.selectNodeContents(b)
          text = {
            content: b.textContent,
            rect: rect(range),
            font: getComputedStyle(b).fontSize,
            background: getComputedStyle(b).backgroundColor,
            transform: getComputedStyle(b).transform
          }
        }
        return {
          trigger: rect(t),
          mark: rect(t.querySelector('.composer-mailbox__mark')),
          envelope: rect(t.querySelector('.composer-mailbox__envelope')),
          badge: rect(b),
          attention: rect(t.querySelector('.composer-mailbox__attention')),
          progress: rect(t.querySelector('.composer-mailbox__progress')),
          avatar: rect(s.querySelector('.composer-agent-identity')),
          composer: rect(s.querySelector('.composer')),
          editor: rect(s.querySelector('.composer [role="textbox"]')),
          text,
          label: t.getAttribute('aria-label'),
          coarse: matchMedia('(pointer:coarse)').matches,
          terminal: mailboxBadge.terminal(),
          facts: mailboxBadge.facts()
        }
      })()
    `
  )
}
const separated = (a, b) =>
  a.right <= b.x + 0.1 || b.right <= a.x + 0.1 || a.bottom <= b.y + 0.1 || b.bottom <= a.y + 0.1
function stable(a, b) {
  for (const name of ['trigger', 'mark', 'composer', 'editor', 'avatar', 'terminal'])
    assert.deepEqual(b[name], a[name], 'Original geometry/terminal preserved: ' + name)
  for (const name of ['sessions', 'tab', 'layout', 'drafts', 'resizes', 'writes'])
    assert.deepEqual(b.facts[name], a.facts[name], 'Original workface preserved: ' + name)
}
async function verify(count, notices, automation) {
  const g = await geometry(),
    contains = (outer, inner) =>
      inner.x >= outer.x - 0.5 &&
      inner.y >= outer.y - 0.5 &&
      inner.right <= outer.right + 0.5 &&
      inner.bottom <= outer.bottom + 0.5
  assert.equal(g.trigger.width, g.coarse ? 44 : 28, 'Messages owns one fixed tool width')
  assert.equal(g.trigger.height, g.coarse ? 44 : 24, 'Original fine/coarse hit height')
  assert.equal(g.mark.width, 28)
  assert.equal(g.mark.height, 24)
  assert.equal(g.envelope.width, 12)
  assert.equal(g.envelope.height, 12)
  assert.ok(contains(g.trigger, g.mark))
  assert.ok(contains(g.mark, g.envelope))
  assert.equal(Boolean(g.badge), count > 0, 'Only actual journal unread creates a number')
  assert.equal(Boolean(g.attention), notices)
  assert.equal(Boolean(g.progress), automation)
  assert.ok(
    g.label.includes(`Agent messages ${count} unread in loaded messages`),
    'Accessible count remains exact'
  )
  for (const hint of [g.badge, g.attention, g.progress].filter(Boolean)) {
    assert.ok(contains(g.mark, hint), 'Hints stay within the fixed mark')
    assert.ok(separated(hint, g.avatar), 'Messages hints do not invade the Agent avatar')
  }
  for (const status of [g.attention, g.progress].filter(Boolean)) {
    assert.ok(status.y >= g.mark.y + 1, 'A status mark leaves room below the button edge')
  }
  if (g.badge) {
    assert.equal(g.text.content, count > 99 ? '99+' : String(count))
    assert.equal(g.text.font, '10px')
    assert.equal(g.text.background, 'rgba(0, 0, 0, 0)')
    assert.equal(g.text.transform, 'none')
    assert.ok(g.badge.y >= g.envelope.bottom - 0.1, 'Unread is below the envelope')
    assert.ok(
      g.text.rect.x >= g.badge.x - 0.5 && g.text.rect.right <= g.badge.right + 0.5,
      'Complete unread horizontal glyphs remain inside the count'
    )
    assert.ok(contains(g.mark, g.text.rect), 'Natural unread glyphs stay within the fixed mark')
    assert.ok(separated(g.text.rect, g.envelope), 'Unread glyphs do not overlap the envelope')
    assert.ok(
      Math.abs(g.badge.x + g.badge.width / 2 - (g.mark.x + g.mark.width / 2)) < 0.6,
      'Unread is centered'
    )
  }
  if (g.attention) {
    assert.ok(
      g.attention.x >= g.envelope.right - 0.1,
      'Notices stays in the upper-right corner without crossing the envelope'
    )
    assert.ok(separated(g.attention, g.envelope), 'Notices does not overlap the envelope')
  }
  if (g.progress) {
    if (g.attention) {
      assert.ok(g.progress.right <= g.envelope.x + 0.1, 'Automation yields the upper-right corner to Notices')
    } else {
      assert.ok(g.progress.x >= g.envelope.right - 0.1, 'Standalone Automation stays in the upper-right corner')
    }
    assert.ok(separated(g.progress, g.envelope), 'Automation does not overlap the envelope')
  }
  for (const [a, b] of [
    [g.badge, g.attention],
    [g.badge, g.progress],
    [g.attention, g.progress]
  ])
    if (a && b) assert.ok(separated(a, b), 'Independent Messages hints remain separate')
  return g
}
async function frame(scene, name) {
  await painted()
  const file = `${scene.width}-${scene.appearance}-${scene.touch ? 'coarse' : 'fine'}-${name}.png`,
    bytes = (await win.webContents.capturePage()).toPNG()
  await fs.writeFile(path.join(evidence, file), bytes, { flag: 'wx' })
  result.frames.push({ scene, file, sha256: createHash('sha256').update(bytes).digest('hex') })
}
async function cssMutation({ name, selector, inset, failure, count, notices }) {
  const declaration = await evaluate(
    `
      ;(() => {
        const matches = []
        function walk(rules, sheet) {
          for (const rule of rules) {
            if (rule.selectorText === ${JSON.stringify(selector)}) matches.push({ rule, sheet })
            if (rule.cssRules) walk(rule.cssRules, sheet)
          }
        }
        for (const sheet of document.styleSheets) walk(sheet.cssRules, sheet)
        if (matches.length !== 1) throw Error('The original imported status CSS rule must be unique')
        const { rule, sheet } = matches[0]
        globalThis.mailboxOriginalRule = {
          rule,
          declarations: rule.style.cssText,
          cssText: rule.cssText
        }
        const original = rule.cssText
        rule.style.setProperty('inset-inline', ${JSON.stringify(inset)})
        return {
          href: sheet.href,
          selector: rule.selectorText,
          property: 'inset-inline',
          mutatedValue: rule.style.getPropertyValue('inset-inline'),
          original,
          mutated: rule.cssText
        }
      })()
    `
  )
  await painted()
  let failed
  try {
    await verify(count, notices, true)
  } catch (error) {
    failed = { name: error.name, message: error.message }
  }
  assert.equal(
    failed?.name,
    'AssertionError',
    'The loaded CSS mutant must fail an actual geometry assertion'
  )
  assert.match(failed.message, failure)
  await evaluate(
    `
      ;(() => {
        const saved = mailboxOriginalRule
        saved.rule.style.cssText = saved.declarations
        if (saved.rule.cssText !== saved.cssText)
          throw Error('The exact original CSS declaration was not restored')
      })()
    `
  )
  await painted()
  await verify(count, notices, true)
  result.mutations.push({
    name,
    actualImportedCSS: true,
    declaration,
    failed,
    restored: 'same-page geometry green',
    sharedSourceWritten: false
  })
}
async function readAutomation(expected) {
  if (!(await evaluate(`Boolean(${popover})`))) await click(trigger)
  await click(`${popover}.querySelector('[aria-label="Automation"]')`)
  await waitFor(`${trigger}.dataset.progressState===${JSON.stringify(expected)}`)
  await click(`${popover}.querySelector('[aria-label="Close mailbox"]')`)
  await waitFor(`!${popover}`)
}
async function keyboardToggle() {
  const before = await evaluate('mailboxBadge.facts().inputs.length')
  await evaluate(`${trigger}.focus({ preventScroll: true })`)
  assert.equal(await evaluate(`document.activeElement === ${trigger}`), true)
  for (const [key, code] of [
    ['Enter', 13],
    ['Escape', 27]
  ]) {
    for (const type of ['keyDown', 'keyUp']) {
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: code,
        nativeVirtualKeyCode: key === 'Enter' ? 36 : 53,
        ...(key === 'Enter' && type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {})
      })
    }
    await waitFor(key === 'Enter' ? `Boolean(${popover})` : `!${popover}`)
  }
  assert.equal(
    await evaluate(`document.activeElement === ${trigger}`),
    true,
    'The original Messages trigger keeps keyboard focus after dismissal'
  )
  const inputs = await evaluate(`mailboxBadge.facts().inputs.slice(${before})`)
  for (const key of ['Enter', 'Escape']) {
    assert.ok(
      inputs.some((input) => input.type === 'keydown' && input.key === key && input.trusted),
      `The actual Renderer consumed trusted ${key}`
    )
  }
  result.keyboard.push({
    openedWith: 'Enter',
    closedWith: 'Escape',
    originalTriggerFocused: true,
    inputs
  })
}
async function scene(s) {
  result.stage = s
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: s.width * 2 + 1,
    height: 620,
    deviceScaleFactor: 1,
    mobile: Boolean(s.touch)
  })
  await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', {
    enabled: Boolean(s.touch),
    maxTouchPoints: 1
  })
  await evaluate(
    `
      mailboxBadge.seed()
      mailboxBadge.appearance(${JSON.stringify(s.appearance)})
      mailboxBadge.draft(${JSON.stringify(s.draft)})
      mailboxBadge.notices(false)
    `
  )
  await waitFor(`${trigger}&&${trigger}.title.includes('Agent messages 25 unread')`)
  if (s.width === 640 || (!s.touch && s.appearance === 'light')) {
    await evaluate('mailboxBadge.unread(1)')
    await waitFor(`${trigger}.dataset.progressState === 'unconfirmed' && ${trigger}.title.includes('Agent messages 1 unread')`)
    await verify(1, false, true)
    await frame(s, 'unread-1-automation-unconfirmed')
    if (s.width === 640) await cssMutation({
      name: 'standalone-automation-returned-to-left',
      selector: '.composer-mailbox__progress', inset: '0 auto', count: 1, notices: false,
      failure: /Standalone Automation stays in the upper-right corner/
    })
    await evaluate('mailboxBadge.unread(100)')
  }
  // Read the four legitimate 25-message pages through the actual mailbox consumer.
  await click(trigger)
  await waitFor(popover)
  for (let page = 1; page < 4; page++) {
    await waitFor(
      `[...${popover}.querySelectorAll('button')].some(b=>b.textContent==='Read earlier messages'&&!b.disabled)`
    )
    await click(
      `[...${popover}.querySelectorAll('button')].find(b=>b.textContent==='Read earlier messages')`
    )
  }
  await waitFor(
    `!([...${popover}.querySelectorAll('button')].some(b=>b.textContent==='Read earlier messages'))`
  )
  assert.equal(
    await evaluate(
      `Object.keys(mailboxBadge.facts().receipts['mail:'+mailboxBadge.sessionId]??{}).length`
    ),
    100,
    'Actual received-message pagination records the original human-read receipts'
  )
  await readAutomation('active')
  if (s.width === 640) await keyboardToggle()
  await evaluate('mailboxBadge.unread(0)')
  await click(`${surface}.querySelector('.terminal-view__xterm')`)
  await waitFor(`mailboxBadge.terminal().visibleLines.some(line=>line.includes('typed prompt'))`)
  await painted()
  const baseline = await verify(0, false, true)
  assert.equal(baseline.coarse, Boolean(s.touch), 'Actual emulated pointer family is explicit')
  await frame(s, 'unread-0')
  const observations = []
  for (const count of [1, 12, 100]) {
    await evaluate(`mailboxBadge.unread(${count})`)
    await painted()
    const g = await verify(count, false, true)
    stable(baseline, g)
    observations.push({ count, geometry: g })
    if (count === (s.width === 640 ? 1 : s.appearance === 'light' ? 12 : 100))
      await frame(s, `unread-${count > 99 ? '99plus' : count}`)
  }
  await evaluate('mailboxBadge.unread(0);mailboxBadge.progress("inactive")')
  await readAutomation('inactive')
  await evaluate('mailboxBadge.notices(true)')
  await painted()
  const noticesOnly = await verify(0, true, false)
  stable(baseline, noticesOnly)
  await frame(s, 'notices-only')
  await evaluate('mailboxBadge.notices(false);mailboxBadge.progress("active")')
  await readAutomation('active')
  await evaluate('mailboxBadge.unread(100);mailboxBadge.notices(true)')
  await painted()
  const mixed = await verify(100, true, true)
  stable(baseline, mixed)
  await frame(s, 'mixed')
  if (s.width === 640) await cssMutation({
    name: 'notices-moved-onto-envelope',
    selector: '.composer-mailbox__attention', inset: 'auto 8px', count: 100, notices: true,
    failure: /Notices.*(?:envelope|upper-right)/
  })
  result.scenes.push({ scene: s, baseline, observations, noticesOnly, mixed })
}
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({
      width: 1281,
      height: 620,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    win.webContents.on('console-message', (_event, level, message) =>
      result.console.push({ level, message })
    )
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
      enabled: true
    })
    await waitFor('Boolean(window.mailboxBadge)')
    for (const s of [
      { width: 640, appearance: 'dark', draft: 'Original short draft' },
      {
        width: 320,
        appearance: 'light',
        draft: 'Original long draft remains in the same editor, close to its natural wrap boundary.'
      },
      {
        width: 320,
        appearance: 'dark',
        draft: 'Original unsent draft\nSecond retained line\nThird unsent line'
      },
      { width: 320, appearance: 'light', touch: true, draft: 'Original touch draft' }
    ])
      await scene(s)
    assert.equal(result.scenes.length, 4)
    assert.equal(result.mutations.length, 2)
    assert.equal(result.keyboard.length, 1)
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    result.failureFacts = await geometry().catch(() => null)
    result.failureDom = await evaluate('document.body.innerHTML').catch(() => null)
  } finally {
    await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2))
    win?.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
