const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'userData'))
app.setPath('sessionData', path.join(privateRoot, 'sessionData'))
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', images: [], interactions: [], errors: [] }
let win
app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 1180, height: 850, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
    await win.loadFile(html, { query: { phase: 'seed', retained: '1', zoneSelection: '1' } })
    const { read, until, settle, click } = nativeRendererInput(win, result.interactions, '')
    await until('window.moteCooperationCapture?.ready', 'Original production App bootstrap')
    await read('window.__connectionsTrustedEvents=window.moteCooperationCapture.facts().trustedEvents')
    win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')
    const facts = () => read('window.moteCooperationCapture.facts()')
    const initial = result.initial = await facts()
    assert.ok(initial.runs.length >= 4)
    const floating = 'document.querySelector("[data-pmo-teams-topic-floating]:popover-open")'
    await click('js:' + floating + '.querySelector("[aria-label=\\"Open in Space\\"]")')
    const header = 'document.querySelector(".mote-space-frame__header:not([hidden])")'
    const details = 'document.querySelector("[data-mote-details][data-shared-navigation=\\"true\\"]")'
    const team = 'document.querySelector(".mote-cooperation__popover")'
    await until('!' + floating + ' && !!' + header, 'Original Space takes over the same Mote')
    const page = async name => {
      await click('js:[...' + header + '.querySelectorAll("[role=tab]")].find(n=>n.textContent===' + JSON.stringify(name) + ')')
      await until(header + '.querySelector("[role=tab][aria-selected=true]").textContent===' + JSON.stringify(name))
    }
    async function capture(name) {
      if (process.argv.includes('--unknown-only') && name !== '08-unknown-team-narrow-light') return
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 }); await settle()
      const current = await facts()
      assert.deepEqual(current.identities, initial.identities, 'Original workface identities are kept')
      assert.deepEqual(current.drafts, initial.drafts, 'Every original unsent draft is kept')
      assert.deepEqual(current.writes, [], 'Read-only navigation performs no input or lifecycle effect')
      for (const run of current.runs) assert.deepEqual(run, initial.runs.find(item => item.id === run.id))
      const dom = await read(`({body:document.body.innerText,viewport:{width:innerWidth,height:innerHeight},header:${header}.getBoundingClientRect().toJSON(),identityCount:[...document.querySelectorAll('.mote-details__profile')].filter(n=>n.checkVisibility()).length})`)
      const file = name + '.png'; await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      result.images.push(file); result[name] = { dom, facts: current }
    }
    assert.equal(await read(header + '.querySelector(".mote-cooperation__identity")===null'), true)
    await page('Profile')
    await until('!!' + details + '?.querySelector(".mote-details__profile")')
    assert.equal(await read(details + '.querySelector(".mote-profile__preferences").open'), false)
    await capture('01-profile-wide-dark')
    await page('Ideas')
    assert.equal(await read(details + '.querySelector(".mote-details__profile").checkVisibility()'), false)
    await capture('02-ideas-wide-dark')
    await page('Calendar'); await capture('03-calendar-wide-dark')
    await click('js:' + header + '.querySelector("[aria-label=\\"Team work\\"]")')
    await until('!!' + team + ' && ' + team + '.querySelectorAll("[data-mote-member]").length===2')
    await capture('04-cooperation-overlay-wide-dark')
    await click('js:' + team + '.querySelector("[aria-label=\\"Close team work\\"]")')
    await until('!' + team)
    await read('window.moteCooperationCapture.longNames()')
    win.setContentSize(640, 850); await settle()
    await page('Ideas'); await capture('05-ideas-long-name-narrow-dark')
    await page('Profile'); await capture('06-profile-long-name-narrow-dark')
    await read('window.moteCooperationCapture.theme(true)'); await page('Calendar'); await capture('07-calendar-narrow-light')
    await click('js:' + header + '.querySelector("[aria-label=\\"Team work\\"]")')
    await until('!!' + team)
    await read('window.moteCooperationCapture.unknown()')
    await until(team + '.textContent.includes("暂未确认") || ' + team + '.textContent.includes("Status not confirmed")')
    assert.equal((await read('document.body.innerText')).split('原 Mote 资料暂未确认；原成员、工作和输入保留。').length - 1, 1, 'One directory failure has one cause surface')
    assert.equal(await read(details + '.textContent.includes("No arrangements yet")'), false, 'Unknown scope is not confirmed empty')
    await capture('08-unknown-team-narrow-light')
    result.final = await facts()
    assert.ok(result.interactions.length >= 10 && result.interactions.every(item => item.events.some(event => event.trusted)))
    assert.deepEqual(result.final.writes, []); result.passed = true
  } catch (error) {
    result.error = { message: error.message, stack: error.stack, cause: error.cause?.message }
    if (win && !win.isDestroyed()) {
      result.failureState = await win.webContents.executeJavaScript('({body:document.body.textContent,setup:window.closedTabSetup,facts:window.moteCooperationCapture?.facts()})').catch(error => ({ error: error.message }))
      await fs.writeFile(path.join(evidence, 'failed.png'), (await win.webContents.capturePage()).toPNG())
    }
  } finally {
    if (win && !win.isDestroyed()) {
      try { await win.webContents.executeJavaScript('window.closedTabProof?.dispose()') } catch (error) { result.cleanupError = error.message; result.passed = false }
    }
    await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2) + '\n')
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
