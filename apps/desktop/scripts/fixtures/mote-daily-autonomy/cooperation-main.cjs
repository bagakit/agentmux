const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, privateRoot, evidence, subset] = process.argv.slice(2)
const affectedOnly = subset === 'affected-only'
app.setPath('userData', path.join(privateRoot, 'userData'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, pid: process.pid, images: [], operations: [], errors: [] }
app.whenReady().then(async () => {
  let win
  try {
    Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 1080, height: 850, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
    await win.loadFile(html, { query: { workspacePath: path.join(privateRoot, 'workspace', '.agentmux', 'scratch') } })
    const read = script => win.webContents.executeJavaScript(script)
    for (let i = 0; i < 100 && !(await read('!!document.querySelector(".mote-cooperation-entry")')); i++) await pause(30)
    assert.equal(await read('!!document.querySelector(".mote-cooperation-entry")'), true)
    const click = async selector => {
      const rect = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing actual control');n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 })
      await pause(100)
    }
    const type = async text => {
      await click('[aria-label="A question for this Mote"]'); win.webContents.selectAll(); win.webContents.insertText(text); await pause(100)
    }
    const capture = async name => {
      await pause(150)
      const facts = await read(`(()=>{const n=document.querySelector('[data-mote-details]');return {overflow:n.scrollWidth>n.clientWidth,question:n.querySelector('[aria-label="A question for this Mote"]').value,text:n.textContent,...moteCompanion.facts()}})()`)
      assert.equal(facts.overflow, false)
      assert.equal(facts.drafts['original-region'], 'An original unsent question stays here.')
      assert.equal(facts.drafts['second-region'], 'The other Mote keeps its own unsent draft.')
      await fs.writeFile(path.join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG())
      result.images.push(name + '.png'); result.operations.push({ name, ...facts })
    }
    await read('moteCompanion.theme(false)'); if (!affectedOnly) await capture('profile-wide-dark')
    assert.equal(await read(`!!document.querySelector('[aria-label="Prepare this question in a new discussion"]')`), false)
    win.setContentSize(320, 760); await read('moteCompanion.theme(true)'); if (!affectedOnly) await capture('profile-narrow-light')
    await type('Help me compare a small experiment before we choose a direction.')
    if (!affectedOnly) await capture('question-narrow-light')
    await click('[aria-label="Prepare this question in a new discussion"]')
    for (let i = 0; i < 100 && !(await read('moteCompanion.facts().selectedDraft?.includes("compare a small experiment")')); i++) await pause(30)
    assert.equal(await read('moteCooperationNotes().includes("Saved materials read")'), true)
    assert.equal(await read('moteCooperationNotes().includes("Keep this custom paragraph unchanged")'), true)
    assert.equal(await read('moteCompanion.facts().selectedDraft'), 'Help me compare a small experiment before we choose a direction.');
    win.setContentSize(1080, 850); await capture('question-prepared-original-launcher')
    await read('moteCompanion.reset();moteCompanion.unknown()'); await pause(150)
    await type('Work on my question while the saved profile is unconfirmed.')
    await click('[aria-label="Prepare this question in a new discussion"]'); await pause(150)
    assert.equal(await read('moteCooperationNotes().includes("unconfirmed")'), true)
    assert.equal(await read('moteCompanion.facts().selectedDraft'), 'Work on my question while the saved profile is unconfirmed.');
    win.setContentSize(320, 760); await capture('unconfirmed-profile-original-launcher')
    await read('moteCompanion.reset()'); await pause(150)
    await type('Earlier question'); await read('moteCompanion.armLateRead()')
    await click('[aria-label="Prepare this question in a new discussion"]')
    await type('Later question stays here.'); await read('moteCompanion.finishLateRead()'); await pause(150)
    assert.equal(await read('moteCompanion.facts().tabs.length'), 2)
    assert.equal(await read(`document.querySelector('[aria-label="A question for this Mote"]').value`), 'Later question stays here.')
    if (!affectedOnly) await capture('later-question-kept')
    result.passed = true
  } catch (error) {
    result.error = { message: error.message, stack: error.stack }
    if (win) await fs.writeFile(path.join(evidence, 'failed.png'), (await win.webContents.capturePage()).toPNG())
  } finally {
    await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2) + '\n')
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
