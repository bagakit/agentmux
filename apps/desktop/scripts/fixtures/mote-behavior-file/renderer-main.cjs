const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'userData'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, images: [], operations: [] }
app.whenReady().then(async () => {
  let win
  try {
    Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 1080, height: 850, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } })
    await win.loadFile(html, { query: { workspacePath: privateRoot } })
    const read = script => win.webContents.executeJavaScript(script)
    for (let i = 0; i < 100 && !(await read('!!window.moteCompanion')); i++) await pause(30)
    const click = async selector => {
      const rect = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing control');n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 })
      await pause(120)
    }
    const capture = async name => {
      await pause(200)
      const facts = await read(`(()=>{const n=document.querySelector('[data-mote-details]');return{overflow:n.scrollWidth>n.clientWidth,text:n.textContent,selected:[...document.querySelectorAll('.mote-behavior-dialog input:checked')].map(n=>n.value),dialog:document.querySelector('.mote-behavior-dialog')?.textContent,...moteCompanion.facts()}})()`)
      assert.equal(facts.overflow, false)
      assert.equal(facts.drafts['original-region'], 'An original unsent question stays here.')
      assert.equal(facts.drafts['second-region'], 'The other Mote keeps its own unsent draft.')
      await fs.writeFile(path.join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG())
      result.images.push(name + '.png'); result.operations.push({ name, ...facts })
    }
    await read('moteCompanion.theme(false)'); await click('[aria-label="Edit behavior settings"]')
    await read(`document.querySelector('.mote-behavior-dialog input[value="E"]').focus()`)
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'RIGHT' })
    await pause(100)
    assert.equal(await read(`document.querySelector('.mote-behavior-dialog input[value="I"]').checked`), true)
    for (const value of ['N', 'F', 'J']) await click(`.mote-behavior-dialog label:has(input[value="${value}"])`)
    await click('[aria-label="Extra preferences"]'); await click('[aria-label="Custom cooperation preferences"]')
    win.webContents.insertText('Use concrete examples and explain the next useful step.'); await pause(100)
    await capture('behavior-selected-wide-dark')
    const rect = await read(`(()=>{const n=[...document.querySelectorAll('.mote-behavior-dialog button')].find(n=>n.textContent==='Save');const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 })
    for (let i = 0; i < 100 && await read('!!document.querySelector(".mote-behavior-dialog")'); i++) await pause(30)
    assert.equal(await read('!!document.querySelector(".mote-behavior-dialog")'), false)
    assert.equal(await read(`document.querySelector('[data-mote-details]').textContent.includes('MBTI style · INFJ')`), true)
    await capture('behavior-saved-profile-wide-dark')
    await click('[aria-label="Edit behavior settings"]')
    assert.deepEqual(await read(`[...document.querySelectorAll('.mote-behavior-dialog input:checked')].map(n=>n.value)`), ['I', 'N', 'F', 'J'])
    await capture('behavior-reopened-wide-dark')
    win.setContentSize(320, 760); await read('moteCompanion.theme(true)'); await capture('behavior-reopened-narrow-light')
    await click('[aria-label="Close behavior settings"]'); await capture('behavior-saved-profile-narrow-light')
    await read('moteCompanion.unknown()'); await pause(200); await capture('behavior-read-unknown-narrow-light')
    await click('[aria-label="Edit behavior settings"]'); await capture('behavior-read-unknown-dialog-narrow-light')
    result.passed = true
  } catch (error) {
    result.error = { message: error.message, stack: error.stack }
    if (win) await fs.writeFile(path.join(evidence, 'failed.png'), (await win.webContents.capturePage()).toPNG())
  } finally {
    await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2) + '\n')
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
