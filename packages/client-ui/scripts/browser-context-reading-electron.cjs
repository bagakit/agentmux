const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path')
const [url, privateRoot, output] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], errors: [], scope: 'Production shared ConversationView, complete-resource reader and input mailbox mounted with private fixed records. No Agent or live Browser is operated.' }
let window
app.whenReady().then(async () => {
  try {
    window = new BrowserWindow({ show: false, width: 1000, height: 900, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true } })
    window.webContents.on('console-message', event => { if (event.level === 'error') result.errors.push(event.message) })
    const read = value => window.webContents.executeJavaScript(value)
    const settle = () => read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const wait = async source => {
      const deadline = Date.now() + 10000
      while (!await read(source)) { assert.ok(Date.now() < deadline, 'Actual shared reader must mount'); await new Promise(resolve => setTimeout(resolve, 20)) }
    }
    await window.loadURL(url); await wait('!!window.readingProof && !!document.querySelector(".conversation-browser-context")')
    for (const [scene, theme, width] of [['conversation', 'dark', 1000], ['mailbox', 'light', 1000], ['conversation', 'light', 332], ['mailbox', 'dark', 332]]) {
      window.setContentSize(width, 900)
      await read(`window.readingProof.setTheme(${JSON.stringify(theme)});window.readingProof.setScene(${JSON.stringify(scene)})`); await settle()
      if (scene === 'mailbox') {
        await wait('!!document.querySelector("[data-input-mailbox-key] > details > summary")')
        await read('document.querySelector("[data-input-mailbox-key] > details > summary").click()'); await settle()
      } else {
        await wait('!!document.querySelector(".conversation-resource-text__controls button")')
        await read('document.querySelector(".conversation-resource-text__controls button").click()'); await settle()
        await wait('!!document.querySelector(".conversation-resource-text .conversation-browser-context")')
      }
      await read('document.querySelector(".conversation-browser-context > summary").click()'); await settle()
      const actual = await read(`(() => ({scene:document.querySelector('[data-reading-scene]').dataset.readingScene,width:innerWidth,appearance:document.documentElement.dataset.appearance,
        icons:!!document.querySelector('[data-semantic-icon-sprite] symbol'),
        overflow:document.documentElement.scrollWidth>innerWidth,contexts:[...document.querySelectorAll('.conversation-browser-context')].map(e=>({source:e.dataset.browserContextSource,open:e.open,text:e.textContent})),
        authors:[...document.querySelectorAll('.log-turn__who')].map(e=>e.textContent),body:document.body.textContent}))()`)
      assert.equal(actual.scene, scene); assert.equal(actual.width, width); assert.equal(actual.overflow, false)
      assert.equal(actual.appearance, theme); assert.equal(actual.icons, true)
      assert.ok(actual.contexts.length > 0 && actual.contexts.every(context => context.source === 'host-capture'))
      assert.ok(actual.contexts[0].text.includes('selection-navigation')); assert.ok(actual.contexts[0].text.includes('Observed during'))
      const file = `${scene}-${theme}-${width}.png`
      await fs.writeFile(path.join(output, file), (await window.webContents.capturePage()).toPNG())
      result.frames.push({ file, scene, theme, width, actual })
    }
    assert.deepEqual(result.errors, []); result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (window && !window.isDestroyed()) {
      result.failure.body = await window.webContents.executeJavaScript('document.body.textContent')
      await fs.writeFile(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG())
    }
  }
  finally { await fs.writeFile(path.join(output, 'actual.json'), JSON.stringify(result, null, 2)); if (window && !window.isDestroyed()) window.destroy(); app.exit(result.passed ? 0 : 1) }
})
