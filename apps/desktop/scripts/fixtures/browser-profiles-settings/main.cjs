const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { writeFile } = require('node:fs/promises')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const directory = process.env.PROFILES_VISUAL_ROOT
for (const key of ['home', 'appData', 'userData', 'sessionData']) { mkdirSync(join(directory, key), { recursive: true }); app.setPath(key, join(directory, key)) }
const wait = ms => new Promise(done => setTimeout(done, ms))
const receipt = { scene: process.env.PROFILES_VISUAL_SCENE ?? 'profiles', captureOnly: true, aestheticReview: 'not-performed', realComponents: ['SettingsPanel', 'BrowserProfilesSettingsPane', 'BrowserPane', 'BrowserOperationWarning', 'ProfileMark'], fixtureConfigOnly: true, userDataTouched: false, screenshots: [] }
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 1250, height: 900, show: false, title: 'Browser Profiles · private review', webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error('Renderer:', event.message) })
    win.webContents.debugger.on('message', (_event, method, payload) => {
      if (method === 'Runtime.exceptionThrown') console.error('Renderer:', payload.exceptionDetails.exception?.description ?? payload.exceptionDetails.text)
    })
    const evaluate = async expression => { const result = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value }
    const ready = async expression => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await wait(100) }
      const observed = await evaluate(`({ document: document.readyState, started: Boolean(window.profilesVisual), rows: document.querySelectorAll('[data-resource-row]').length, text: document.body.innerText.slice(0, 400) })`)
      throw new Error('Private visual document not ready: ' + expression + ' ' + JSON.stringify(observed))
    }
    const click = async selector => {
      const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing real control '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
      await wait(200)
    }
    const type = async (selector, text) => {
      await click(selector)
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`)
      await win.webContents.debugger.sendCommand('Input.insertText', { text })
      await wait(120)
    }
    const toolbarFits = () => evaluate(`(() => {
      const chip = document.querySelector('button.browser-profile-chip'), name = chip.querySelector('span:not(.profile-mark)'), bounds = chip.getBoundingClientRect();
      return [...chip.children].filter(child => getComputedStyle(child).display !== 'none').every(child => {
        const box = child.getBoundingClientRect(); return box.width > 0 && box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
      }) && (innerWidth < 520 ? getComputedStyle(name).display === 'none' : name.getBoundingClientRect().width > 0);
    })()`)
    const capture = async (name, width, height) => {
      win.setContentSize(width, height); await wait(300)
      if (name.startsWith('profiles-toolbar') || name.startsWith('profiles-service-notice') || name.startsWith('profiles-environment-notice')) {
        const bounds = await evaluate('document.querySelector(".browser-surface").getBoundingClientRect().toJSON()')
        if (Math.abs(bounds.width - width) > 1 || Math.abs(bounds.x) > 1) throw new Error('The real BrowserPane must fill its fixture workface')
        if (!await toolbarFits()) throw new Error('The Profile mark, name and disclosure must fit inside their real toolbar chip')
      }
      await writeFile(join(directory, name + '.png'), (await win.webContents.capturePage()).toPNG())
      receipt.screenshots.push({ name, file: name + '.png', width, height })
    }
    win.showInactive()
    await win.loadFile(process.env.PROFILES_VISUAL_HTML, { query: { scene: receipt.scene } })
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    const expectedRows = ['switch', 'trash-empty'].includes(receipt.scene) ? 1 : 4
    await ready(`Boolean(window.profilesVisual && document.querySelectorAll('[data-settings-pane="browser-profiles"] [data-resource-row]').length === ${expectedRows})`)
    if (receipt.scene === 'switch') {
      await click('[data-resource-row="' + await evaluate('profilesVisual.client') + '"]')
      const selector = '.browser-profile-editor__agents > input[role="switch"]'
      const input = 'document.querySelector(' + JSON.stringify(selector) + ')'
      await ready(`Boolean(${input})`)
      await evaluate(`${input}.scrollIntoView({ block: 'center' })`)
      const key = async (key, code, windowsVirtualKeyCode) => {
        for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode })
      }
      const focused = () => evaluate(`document.activeElement === ${input}`)
      const focusWithTab = async () => {
        for (let attempt = 0; attempt < 50 && !await focused(); attempt++) await key('Tab', 'Tab', 9)
        assert.equal(await focused(), true, 'Tab reaches the real Profile switch')
        assert.equal(await evaluate(`${input}.matches(':focus-visible')`), true)
      }
      await focusWithTab()
      assert.equal(await evaluate(`${input}.type`), 'checkbox')
      assert.equal(await evaluate(`${input}.checked`), false)
      await capture('profile-switch-off-focus-dark', 960, 780)
      const size = () => evaluate(`(() => { const { width, height } = ${input}.getBoundingClientRect(); return { width, height }; })()`)
      const footprint = await size()
      assert.deepEqual(footprint, { width: 32, height: 19 })
      await key(' ', 'Space', 32)
      await ready(`${input}.checked && !${input}.disabled`)
      assert.deepEqual(await size(), footprint, 'The checked track keeps the same bounds')
      await evaluate('profilesVisual.appearance("light")')
      await capture('profile-switch-on-narrow-light', 560, 780)
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      assert.equal(await evaluate(`getComputedStyle(${input}, '::before').transitionDuration`), '0s')
      await evaluate("document.documentElement.dir = 'rtl'")
      assert.equal(await evaluate(`new DOMMatrix(getComputedStyle(${input}, '::before').transform).m41`), -13)
      await evaluate("document.documentElement.dir = 'ltr'")
      await focusWithTab()
      await key(' ', 'Space', 32)
      await ready(`!${input}.checked && !${input}.disabled`)
      assert.equal(await focused(), true, 'Saving keeps focus on the original Profile control')
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
      await capture('profile-switch-off-forced-colors', 560, 780)
      await focusWithTab()
      await evaluate('profilesVisual.holdAccessSave()')
      await key(' ', 'Space', 32)
      await ready(`${input}.disabled`)
      const search = 'document.querySelector(".settings-search input")'
      await evaluate(`${search}.focus()`)
      await evaluate('profilesVisual.finishAccessSave()')
      await ready(`${input}.checked && !${input}.disabled`)
      assert.equal(await evaluate(`document.activeElement === ${search}`), true, 'Saving leaves the alternate focus chosen during the request')
      receipt.switchBehavior = { tab: true, space: true, focusRetained: true, otherFocusPreserved: true, rtl: true, reducedMotion: true, footprint }
      receipt.complete = true
    } else if (receipt.scene === 'trash-empty') {
      const filter = 'input[aria-label="Filter profiles"]'
      win.setContentSize(560, 780)
      await evaluate('profilesVisual.appearance("light")')
      await ready('document.querySelector(".settings-resource-back")?.getClientRects().length > 0')
      await click('.settings-resource-back')
      await ready(`document.querySelector(${JSON.stringify(filter)})?.getClientRects().length > 0`)
      await evaluate(`void (window.originalProfileFilter = document.querySelector(${JSON.stringify(filter)}))`)
      await type(filter, 'No matching profile')
      await ready('document.querySelector(".settings-resource-empty.surface-state h2")?.textContent.includes("No matching profile")')
      await capture('profiles-filter-no-match-light', 560, 780)
      await click('[aria-label="Clear profiles filter"]')
      assert.equal(await evaluate('document.activeElement === window.originalProfileFilter && !window.originalProfileFilter.value'), true)
      await ready('document.querySelectorAll("[data-resource-row]").length === 1')
      await evaluate('profilesVisual.appearance("dark")')
      await capture('profiles-filter-restored-dark', 620, 780)
      const trash = 'document.querySelector(".browser-profile-trash")'
      const confirmedEmpty = `${trash}?.querySelector('.surface-state h2')?.textContent === 'No recycled Profiles.'`
      const press = label => evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`)
      await press('Recycled Profiles')
      await ready(confirmedEmpty)
      await evaluate('profilesVisual.refreshTrash()')
      await ready(`${trash}?.textContent.includes('Could not read the original archive.')`)
      assert.equal(await evaluate(`Boolean(${trash}.querySelector('.surface-state'))`), false)
      await capture('profiles-trash-read-failed-dark', 620, 780)
      await press('Retry')
      await ready(`${trash}?.textContent.includes('Reading recycled Profiles…')`)
      assert.equal(await evaluate(`Boolean(${trash}.querySelector('.surface-state'))`), false)
      await capture('profiles-trash-retry-pending-dark', 620, 780)
      await evaluate('profilesVisual.finishTrashRead()')
      await ready(confirmedEmpty)
      await evaluate('profilesVisual.appearance("light")')
      await capture('profiles-trash-confirmed-empty-light', 560, 780)
      receipt.complete = true
    } else if (receipt.scene === 'service-notice' || receipt.scene === 'environment-notice') {
      const prefix='profiles-'+receipt.scene
      await evaluate(receipt.scene==='environment-notice'?'profilesVisual.environmentNotice()':'profilesVisual.serviceNotice()')
      await ready('document.querySelector(".browser-operation-warning")?.textContent.includes("Settings → Browser Profiles")')
      await capture(prefix+'-dark', 900, 520)
      await evaluate('profilesVisual.appearance("light")')
      await capture(prefix+'-narrow-light', 360, 520)
      await click('[aria-label="Dismiss this Browser notice"]')
      if (await evaluate('Boolean(document.querySelector(".browser-operation-warning"))')) throw new Error('Dismiss hides only this service notice')
      receipt.complete = true
    } else {
    await capture('profiles-default-dark', 1250, 860)
    await click('[aria-label="Sites with sign-ins"] button')
    await ready('document.querySelectorAll(\'.browser-profile-editor__sites li\').length === 3')
    await click('[aria-label="Clear figma.com"]')
    await capture('profiles-default-sites-dark', 1250, 860)
    await evaluate('document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
    await click('[data-resource-row="' + await evaluate('profilesVisual.client') + '"]')
    await capture('profiles-client-dark', 1250, 860)
    await click('.browser-profile-editor__mark')
    await capture('profiles-hues-dark', 1250, 860)
    await click('.browser-profile-editor__hues > button[style]:nth-of-type(2)')
    await click('.browser-profile-editor__name')
    await capture('profiles-renaming-dark', 1250, 860)
    await evaluate('document.activeElement && document.activeElement.blur()')
    await evaluate('profilesVisual.appearance("light")')
    await capture('profiles-client-light', 1250, 860)
    await click('[aria-label^="More for "]')
    await capture('profiles-menu-light', 1250, 860)
    await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
    await wait(200)
    await capture('profiles-narrow-light', 560, 860)
    await evaluate('profilesVisual.appearance("dark")')
    await capture('profiles-narrow-dark', 560, 860)
    await click('.settings-resource-back')
    await capture('profiles-library-narrow-dark', 560, 860)
    await evaluate('profilesVisual.appearance("light")')
    await capture('profiles-library-narrow-light', 560, 860)
    await click('[data-resource-row="' + await evaluate('profilesVisual.client') + '"]')
    await evaluate('profilesVisual.appearance("dark")')
    await click('[aria-label="Network route"] [role="radio"]:nth-child(3)')
    await type('[aria-label="Proxy server"]', 'http://gateway.example.test:3128')
    await click('[aria-label="Network"] .browser-profile-editor__link')
    await type('[aria-label="Don’t proxy"]', '*.internal.example, localhost')
    await capture('profiles-network-draft-narrow-dark', 560, 860)
    await click('.browser-profile-editor__route-apply .primary-button')
    await ready('document.querySelector("[aria-label=\\"Proxy sign-in\\"]")?.textContent.includes("No sign-in")')
    await evaluate('document.querySelector(".settings-resource-editor").scrollTop = 0')
    await capture('profiles-network-dark', 1250, 940)
    await click('[aria-label="Exit check"] button')
    await ready('document.querySelector("[aria-label=\\"Exit check\\"] [role=status]")?.textContent.includes("HTTP 200")')
    await evaluate('profilesVisual.appearance("light")')
    await capture('profiles-network-light', 1250, 940)
    await click('[aria-label="Proxy sign-in"] button')
    await type('[aria-label="Proxy user name"]', 'review-user')
    await capture('profiles-proxy-sign-in-light', 1250, 940)
    await evaluate('profilesVisual.appearance("dark")')
    await capture('profiles-proxy-sign-in-narrow-dark', 560, 940)
    await evaluate('profilesVisual.browser()')
    await ready('Boolean(document.querySelector(".browser-profile-chip"))')
    await capture('profiles-toolbar-dark', 900, 520)
    // Mutate the actual compiled production CSS rule, then restore it before any reviewed frame.
    // This proves the full-Pane oracle catches the square toolbar rule overriding this identity chip.
    await evaluate(`(() => {
      const rules = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]);
      const rule = rules.find(rule => rule.selectorText === '.browser-toolbar > .browser-profile-chip');
      if (!rule) throw new Error('The production toolbar Profile rule was not loaded');
      window.profilesToolbarRule = { rule, text: rule.style.cssText }; rule.style.removeProperty('width');
    })()`)
    try { receipt.toolbarMutationRejected = !await toolbarFits() }
    finally { await evaluate('profilesToolbarRule.rule.style.cssText = profilesToolbarRule.text; delete window.profilesToolbarRule') }
    if (!receipt.toolbarMutationRejected || !await toolbarFits()) throw new Error('Toolbar mutation must fail and the restored production rule must pass')
    await click('.browser-profile-chip')
    await capture('profiles-toolbar-menu-dark', 900, 520)
    await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
    await evaluate('profilesVisual.appearance("light")')
    await capture('profiles-toolbar-narrow-light', 360, 520)
    await click('.browser-profile-chip')
    await capture('profiles-toolbar-menu-narrow-light', 360, 520)
    win.setContentSize(1250, 940); await wait(300)
    await evaluate('profilesVisual.signInReadFailure()')
    await ready('document.querySelectorAll("[data-resource-row]").length === 4')
    await click('[data-resource-row="' + await evaluate('profilesVisual.client') + '"]')
    await ready('document.querySelector("[aria-label=\\"Proxy sign-in\\"]")?.textContent.includes("Sign-in unknown")')
    await capture('profiles-sign-in-unknown-light', 1250, 940)
    await evaluate('profilesVisual.restoreSignInRead()')
    await click('[aria-label="Proxy sign-in"] [role="status"] button')
    await ready('document.querySelector("[aria-label=\\"Proxy sign-in\\"]")?.textContent.includes("No sign-in")')
    await evaluate('profilesVisual.partialProxyReconnect()')
    await click('[aria-label="Proxy sign-in"] .browser-profile-editor__route button')
    await type('[aria-label="Proxy user name"]', 'review-user')
    await type('[aria-label="Proxy password"]', 'fixture-only-password')
    await click('[aria-label="Proxy sign-in"] button[type="submit"]')
    await ready('document.querySelector("[aria-label=\\"Proxy sign-in\\"]")?.textContent.includes("Signs in as review-user")')
    await capture('profiles-proxy-saved-reconnect-light', 1250, 940)
    receipt.complete = true
    }
  } catch (error) { receipt.complete = false; receipt.failure = { message: error instanceof Error ? error.message : String(error) } }
  writeFileSync(join(directory, 'capture.json'), JSON.stringify(receipt, null, 2))
  app.quit()
})
