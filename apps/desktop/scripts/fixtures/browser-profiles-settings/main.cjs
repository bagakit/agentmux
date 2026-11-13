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
    const win = new BrowserWindow({ width: 1250, height: 900, show: false, title: 'Browser Profiles · private review', webPreferences: { contextIsolation: true, nodeIntegration: false } })
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') console.error('Renderer:', details.message) })
    win.webContents.debugger.attach('1.3')
    const evaluate = async expression => { const result = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value }
    const ready = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await wait(100) } throw new Error('Private visual document not ready: ' + expression) }
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
    await win.loadFile(process.env.PROFILES_VISUAL_HTML)
    await ready('Boolean(window.profilesVisual && document.querySelectorAll(\'[data-settings-pane="browser-profiles"] [data-resource-row]\').length === 4)')
    win.showInactive()
    if (receipt.scene === 'service-notice' || receipt.scene === 'environment-notice') {
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
