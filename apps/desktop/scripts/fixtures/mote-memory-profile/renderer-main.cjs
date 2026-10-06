const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'userData'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, pid: process.pid, images: [], operations: [] }
app.whenReady().then(async () => {
  let win
  try {
    Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 1080, height: 850, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html, { query: { workspacePath: path.join(privateRoot, 'workspace') } })
    const read = async script => {
      try { return await win.webContents.executeJavaScript(script) }
      catch (error) { throw new Error('Renderer operation failed: ' + script.slice(0, 180), { cause: error }) }
    }
    const has = selector => '!!document.querySelector(' + JSON.stringify(selector) + ')'
    const until = async script => {
      for (let i = 0; i < 150; i++) { if (await read(script)) return; await pause(30) }
      throw new Error('Expected Renderer state did not appear: ' + script)
    }
    const click = async selector => {
      const rect = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing observed control: '+${JSON.stringify(selector)});n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 })
    }
    const capture = async name => {
      if (name !== 'profile-collapsed-wide-dark') await read('document.querySelector("[data-mote-memory]").scrollIntoView({block:"start"})')
      await pause(150)
      const facts = await read(`(()=>{const n=document.querySelector('[data-mote-details]');return{overflow:n.scrollWidth>n.clientWidth,text:n.textContent,...moteMemoryScenario.facts()}})()`)
      assert.equal(facts.overflow, false)
      assert.equal(facts.drafts['original-region'], 'An original unsent question stays here.')
      assert.equal(facts.drafts['second-region'], 'The other Mote keeps its own unsent draft.')
      await fs.writeFile(path.join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG())
      result.images.push(name + '.png'); result.operations.push({ name, ...facts })
    }
    await until('!!window.moteMemoryScenario && !!window.moteCompanion && !!document.querySelector("[data-mote-memory]")')
    assert.equal(await read('moteMemoryScenario.facts().calls.length'), 0, 'Collapsed Memory must not read its body')
    await capture('profile-collapsed-wide-dark')
    await click('[data-mote-memory] summary')
    await until('document.querySelector("[data-mote-memory]").textContent.includes("Start with the conclusion")')
    await capture('memory-open-wide-dark')
    await read('moteMemoryScenario.set("unknown")')
    await click('[data-mote-memory] summary'); await until('!document.querySelector(".mote-memory__body")'); await click('[data-mote-memory] summary')
    await until('document.querySelector("[data-mote-memory]").textContent.includes("temporarily unavailable")')
    assert.equal(await read('document.querySelector("[data-mote-memory]").textContent.includes("Start with the conclusion")'), true)
    await capture('memory-unknown-retained-wide-dark')
    await read('moteMemoryScenario.set("saved")')
    await click('[data-mote-memory] summary'); await until('!document.querySelector(".mote-memory__body")'); await click('[data-mote-memory] summary')
    await until('document.querySelector("[data-mote-memory]").textContent.includes("Saved in MEMORY.md") && !document.querySelector("[data-mote-memory]").textContent.includes("temporarily unavailable")')
    await click('[aria-label="Correct or remove a memory detail in editor"]')
    await until(has('.monaco-editor') + ' || ' + has('[aria-label="Show source"]'))
    if (await read(has('[aria-label="Show source"]'))) await click('[aria-label="Show source"]')
    await until('!!document.querySelector(".monaco-editor textarea")')
    await click('.monaco-editor textarea')
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'A', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] })
    await pause(100)
    const correction = '# Working together\n\nStart with one concrete example, then give the conclusion.\n\nSource: the user’s explicit correction, 16 October. Scope: this project.\n\n## Open commitment\n\nReview the small experiment when its result is ready.\n'
    await win.webContents.insertText(correction)
    await until(has('[aria-label="Save file"]'))
    await capture('memory-original-editor-unsaved-wide-dark')
    await click('[aria-label="Save file"]')
    await until(has('[aria-label="File saved"]'))
    assert.equal(await read('moteMemoryScenario.facts().content'), correction, 'Native editing must save the exact correction')
    assert.equal(await read('moteMemoryScenario.facts().content.includes("Review the small experiment")'), true, 'Correction preserves unrelated commitment')
    await capture('memory-original-editor-saved-wide-dark')
    await click('[data-mote-memory] summary'); await until('!document.querySelector(".mote-memory__body")')
    await click('[data-mote-memory] summary')
    await until('document.querySelector("[data-mote-memory]").textContent.includes("Start with one concrete example")')
    await capture('memory-corrected-profile-wide-dark')
    await click('.mote-memory__source summary')
    await capture('memory-source-version-wide-dark')
    await click('.mote-memory__source summary')
    win.setContentSize(320, 760); await read('moteMemoryScenario.theme(true)')
    await capture('memory-corrected-narrow-light')
    await click('[data-mote-memory] summary'); await until('!document.querySelector(".mote-memory__body")'); await read('moteMemoryScenario.set("long")'); await click('[data-mote-memory] summary')
    await until('document.querySelector("[data-mote-memory]").textContent.includes("Decision 10")')
    await capture('memory-long-narrow-light')
    await read('moteMemoryScenario.set("unknown")'); await click('[data-mote-memory] summary'); await until('!document.querySelector(".mote-memory__body")'); await click('[data-mote-memory] summary')
    await until('document.querySelector("[data-mote-memory]").textContent.includes("temporarily unavailable")')
    await capture('memory-unknown-retained-narrow-light')
    await click('[data-mote-memory] summary'); await until('!document.querySelector(".mote-memory__body")'); await read('moteMemoryScenario.set("missing")'); await click('[data-mote-memory] summary')
    await until('document.querySelector("[data-mote-memory]").textContent.includes("no longer present")')
    await capture('memory-missing-narrow-light')
    result.passed = true
  } catch (error) {
    result.error = { message: error.message, stack: error.stack }
    if (win) {
      result.failureState = await win.webContents.executeJavaScript('({text:document.body.textContent,facts:window.moteMemoryScenario?.facts()})').catch(() => null)
      await fs.writeFile(path.join(evidence, 'failed.png'), (await win.webContents.capturePage()).toPNG())
    }
  } finally {
    await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2) + '\n')
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
