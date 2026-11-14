const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, privateRoot, phase, evidence] = process.argv.slice(2)
const profileOnly = process.env.MOTE_INITIALIZATION_PROFILE_ONLY === '1'
app.setPath('userData', path.join(privateRoot, 'user-data'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, phase, profileOnly, pid: process.pid, frames: [], input: [], errors: [] }
app.whenReady().then(async () => {
  let win
  try {
    Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 1180, height: 820, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.errors.push(String(message)) })
    await win.loadFile(html, { query: { phase: 'initialization-' + phase } })
    const read = expression => win.webContents.executeJavaScript(expression)
    const until = async expression => {
      const end = Date.now() + 12000
      do { if (await read('Boolean(' + expression + ')')) return; await pause(25) } while (Date.now() < end)
      throw Error('Original App did not settle: ' + expression + '; ' + JSON.stringify(await read('({setup:window.sharedFrameSetup,body:document.body.textContent.slice(-1500)})')))
    }
    await until('window.moteInit?.ready && document.querySelector("[data-mote-page]")')
    win.showInactive(); win.webContents.debugger.attach('1.3')
    const input = (method, params) => win.webContents.debugger.sendCommand(method, params)
    await input('Emulation.setFocusEmulationEnabled', { enabled: true })
    await pause(250)
    result.baseline = await read('window.moteInit.facts()')
    const lifecycleCounts = calls => Object.fromEntries(['stop', 'launchAgent', 'launchTerminal', 'write', 'submitPrompt'].map(operation => [operation, calls.filter(call => call.operation === operation).length]))
    const visible = 'e=>!e.closest("[hidden],[inert]")&&e.getClientRects().length'
    const button = (label, scope = 'document') => `[...${scope}.querySelectorAll('button,[role="tab"]')].filter(${visible}).find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.textContent.trim()===${JSON.stringify(label)})`
    const click = async (expression, settle = 160) => {
      const point = await read(`(()=>{const e=${expression};if(!e)throw Error('Missing original control: '+${JSON.stringify(expression)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(r.width<=0||r.height<=0)throw Error('Unpresented original control');return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
      result.input.push({ kind: 'click', expression }); if (settle) await pause(settle)
    }
    const key = async name => { for (const type of ['keyDown', 'keyUp']) await input('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: name === 'Escape' ? 27 : 0 }); await pause(160) }
    const capture = async (name, settle = 150) => {
      if (settle) await pause(settle)
      const facts = await read('window.moteInit.facts()')
      result.lastFacts = facts
      assert.ok(facts.tabs['original-initialization-tab'], 'Original Tab remains')
      // Preserve ordinary initialization/prewarming; compare only new requests
      // against the settled original App, never a lifetime total.
      assert.deepEqual(lifecycleCounts(facts.calls), lifecycleCounts(result.baseline.calls), 'Profile/Quick actions add no lifecycle or input request')
      const file = phase + '-' + name + '.png'
      await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      result.frames.push({ name, file, page: facts.profilePage, theme: facts.theme, dimensions: win.getContentSize(), drafts: facts.drafts })
    }
    const profile = async () => {
      await click(button('Profile', 'document.querySelector(".mote-space-frame__header")'))
      await until('document.querySelector("[data-mote-page=profile]")')
    }
    if (phase === 'restore') {
      result.restored = await read('window.moteInit.facts()')
      const original = JSON.parse(await fs.readFile(path.join(evidence, 'seed.json'), 'utf8')).original
      assert.deepEqual(result.restored.drafts, original.drafts, 'The exact original persistent draft returns in a second process')
      const drafts = Object.values(result.restored.drafts).filter(value => value.moteProfile)
      assert.equal(drafts.length, 1); assert.equal(drafts[0].moteProfile.name, 'Mote retained profile draft')
      assert.ok(drafts[0].moteProfile.body.includes('Original draft survives the process restart.'))
      await profile(); await click(button('Edit profile'))
      await until('document.querySelector(".mote-profile-dialog input")?.value==="Mote retained profile draft"')
      await capture('restored-profile-draft-dark-wide')
      result.passed = true; return
    }
    for (const [theme, width, height] of [['dark', 1180, 820], ['dark', 420, 740], ['light', 1180, 820], ['light', 420, 740]]) {
      win.setContentSize(width, height); await read(`window.moteInit.theme(${JSON.stringify(theme)})`); await pause(180)
      if (!profileOnly) {
        await click(button('Discussion', 'document.querySelector(".mote-space-frame__header")'))
        await click(button('Mote 快捷配置'), 25)
        await until('document.querySelector(".mote-quick-mode-dialog") && [...document.querySelectorAll(".mote-quick-mode-dialog button")].some(e=>e.textContent==="Save and continue"&&!e.disabled)')
        if (theme === 'dark' && width === 1180) await capture('quick-opening-intermediate-dark-wide', 0)
        await capture('quick-' + theme + '-' + (width > 600 ? 'wide' : 'narrow'))
        if (theme === 'dark' && width === 1180) {
          await click('document.querySelector(".mote-quick-mode__advanced summary")')
          await capture('quick-advanced-dark-wide')
        }
        await key('Escape')
      }
      await profile(); await click(button('Edit profile'))
      await until('document.querySelector(".mote-profile-dialog input")?.value==="Mote"')
      assert.equal(await read('window.moteInit.facts().profilePage'), 'profile')
      await capture('profile-' + theme + '-' + (width > 600 ? 'wide' : 'narrow'))
      await key('Escape')
    }
    await input('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await click(button('Edit profile')); await until('document.querySelector(".mote-profile-dialog")')
    await capture('profile-reduced-motion-light-narrow')
    const fill = async (selector, value) => {
      await click('document.querySelector(' + JSON.stringify(selector) + ')')
      await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.select();return{start:e.selectionStart,end:e.selectionEnd}})()`)
      await input('Input.insertText', { text: value }); await pause(80)
    }
    await fill('[aria-label="Mote name"]', 'Mote retained profile draft')
    await fill('[aria-label="Mote profile and working notes"]', 'Original draft survives the process restart.\n\n## Original context\nKeep the same Mote and its original workface.')
    await click(button('Cancel', 'document.querySelector(".mote-profile-dialog")'))
    if (!profileOnly) {
      await click(button('Discussion', 'document.querySelector(".mote-space-frame__header")')); await click(button('Mote 快捷配置'))
      await until('[...document.querySelectorAll(".mote-quick-mode-dialog button")].some(e=>e.textContent==="Save and continue"&&!e.disabled)')
      await click(button('Save and continue', 'document.querySelector(".mote-quick-mode-dialog")'))
      await until('!document.querySelector(".mote-quick-mode-dialog") && document.querySelector("[data-mote-page=discussion]")')
      await capture('continued-welcome-light-narrow')
    }
    await until('window.sharedFrameProof.persistence().spatial?.graph.tabs.some(tab=>tab.tabId==="original-initialization-tab")')
    result.original = await read('window.moteInit.facts()'); result.persisted = await read('window.sharedFrameProof.persistence()')
    result.passed = true
  } catch (error) { result.failure = { message: error.message, stack: error.stack } }
  finally {
    await fs.writeFile(path.join(evidence, phase + '.json'), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) { win.webContents.session.flushStorageData(); win.destroy() }
    app.exit(result.passed ? 0 : 1)
  }
})
