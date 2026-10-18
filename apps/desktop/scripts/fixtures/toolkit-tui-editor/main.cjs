const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, output] = process.argv.slice(2)
for (const key of ['home', 'userData', 'sessionData']) { const directory = path.join(privateRoot, key); fs.mkdirSync(directory, { recursive: true }); app.setPath(key, directory) }
const result = { passed: false, boundary: 'Actual ToolkitScriptEditor, Monaco model/tokenizer and shared Root theme in an isolated Electron window. Fixture buttons change adapter props; no full Settings, save, Runtime, execution or aesthetic qualification.', errors: [], samples: [] }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 920, height: 500, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
    win.webContents.on('console-message', details => { if (details.level === 'error') result.errors.push(details.message) })
    const read = expression => win.webContents.executeJavaScript(expression)
    const until = async expression => { const end = Date.now() + 15000; while (!await read(expression)) { assert.ok(Date.now() < end, expression); await new Promise(resolve => setTimeout(resolve, 25)) } }
    const facts = () => read('toolkitEditorProof.facts()')
    const click = async selector => {
      const point = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point })
    }
    await win.loadFile(html); win.show(); win.focus(); win.webContents.focus()
    await until('toolkitEditorProof.facts()?.spans.some(span=>span.text.includes("Workspace monitor"))')
    result.initial = await facts()
    assert.equal(result.initial.language, 'shell')
    await until('toolkitEditorProof.facts()?.tokens.flat().some(token=>token.type === "comment.shell")')
    await until('toolkitEditorProof.facts()?.spans.some(span=>span.text.trim() === "export")')
    const original = await facts(); result.samples.push(original)
    assert.equal(original.language, 'shell')
    const tokens = original.tokens.flat()
    for (const role of ['comment', 'string', 'variable', 'keyword', 'type.identifier']) assert.ok(tokens.some(token => token.type.startsWith(role + '.')), 'Native shell role: ' + role)
    assert.ok(tokens.some(token => token.text.includes('workspace-report') && token.type === ''), 'Unknown command keeps the original default token')
    const rgb = hex => `rgb(${[1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`
    const checkColors = sample => {
      const rendered = text => { const span = sample.spans.find(item => item.text.trim() === text); assert.ok(span, 'Rendered source token: ' + text); return span.color }
      for (const [text, color] of [['# Rendered shell syntax', 'textSubtle'], ['export', 'special'], ["'Workspace monitor'", 'success'], ['echo', 'info'], ['$TOOL_LABEL', 'info'], ['$1', 'info'], ['exec workspace-report', 'text']]) assert.equal(rendered(text), rgb(sample.theme.colors[color]), 'Rendered shared syntax role: ' + text)
    }
    checkColors(original)
    await click('[data-mode="script"]'); await until('toolkitEditorProof.facts()?.language === "javascript"')
    const javascript = await facts(); result.samples.push(javascript)
    assert.equal(javascript.id, original.id); assert.equal(javascript.uri, original.uri); assert.equal(javascript.value, original.value)
    await click('[data-mode="tui"]'); await until('toolkitEditorProof.facts()?.language === "shell"')
    await until('toolkitEditorProof.facts()?.spans.some(span=>span.text.trim() === "export")')
    const returned = await facts(); result.samples.push(returned)
    assert.equal(returned.id, original.id); assert.equal(returned.value, original.value); checkColors(returned)
    await click('[data-theme="light"]'); await until('toolkitEditorProof.facts()?.theme.mode === "light"')
    const lightComment = rgb((await facts()).theme.colors.textSubtle)
    await until(`toolkitEditorProof.facts()?.spans.find(span=>span.text === '# Rendered shell syntax')?.color === ${JSON.stringify(lightComment)}`)
    const light = await facts(); result.samples.push(light); checkColors(light)
    assert.deepEqual(result.errors, [])
    result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally { if (win && !win.isDestroyed()) win.destroy(); fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n'); app.exit(result.passed ? 0 : 1) }
})
