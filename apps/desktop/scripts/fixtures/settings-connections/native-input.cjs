const assert = require('node:assert/strict')

// Native input only: no product navigation, fixture state or business decisions live here.
function nativeRendererInput(win, interactions, pane) {
    const read = code => win.webContents.executeJavaScript(code)
    const until = async (code, label = code) => {
      const end = Date.now() + 6000
      do { if (await read(code)) return; await new Promise(resolve => setTimeout(resolve, 20)) } while (Date.now() < end)
      throw new Error('Renderer setup did not settle: ' + label)
    }
    const settle = () => read('Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))')
    const press = async key => {
      const before = await read('window.__connectionsTrustedEvents.length')
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
      if (key === 'Enter' || key === 'Space') win.webContents.sendInputEvent({ type: 'char', keyCode: key === 'Enter' ? '\r' : ' ' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
      await settle()
      const expected = key === 'Down' ? 'ArrowDown' : key === 'Space' ? ' ' : key
      const events = await read(`window.__connectionsTrustedEvents.slice(${before})`)
      assert.ok(events.some(event => event.type === 'keydown' && event.key === expected && event.trusted), 'Actual native key reaches the Renderer with its exact DOM key')
      if (key === 'Enter') assert.ok(events.some(event => event.type === 'click' && event.trusted), 'Complete native Enter sequence activates the original button')
      interactions.push({ kind: 'native-renderer-key', electronKey: key, expectedDOMKey: expected, events })
    }
    const factsOf = selector => `(() => { const node=${selector.startsWith('js:') ? selector.slice(3) : `document.querySelector(${JSON.stringify(selector)})`}; if(!node)return null; const r=node.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; const hit=document.elementFromPoint(x,y); return {connected:node.isConnected,visible:node.checkVisibility(),bounds:r.toJSON(),value:node.value,disabled:node.disabled,focused:document.activeElement===node,pseudoFocus:node.matches(':focus'),documentHasFocus:document.hasFocus(),cssHit:!!hit&&(hit===node||node.contains(hit)),x,y}; })()`
    async function click(selector) {
      await read(`(${selector.startsWith('js:') ? selector.slice(3) : `document.querySelector(${JSON.stringify(selector)})`})?.scrollIntoView({block:'nearest',inline:'nearest'})`)
      await settle()
      const facts = await read(factsOf(selector))
      assert.ok(facts && facts.connected && facts.visible && facts.bounds.width > 0 && facts.bounds.height > 0, 'Actual connected visible target: ' + selector)
      assert.equal(facts.cssHit, true, 'Actual CSS hit is the exact target: ' + selector)
      assert.notEqual(facts.disabled, true, 'Target is operable: ' + selector)
      const before = await read('window.__connectionsTrustedEvents.length')
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(facts.x), y: Math.round(facts.y) })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(facts.x), y: Math.round(facts.y) })
      await settle()
      const events = await read(`window.__connectionsTrustedEvents.slice(${before})`)
      assert.ok(events.some(event => event.type === 'click' && event.trusted), 'Actual native click creates a trusted Renderer event')
      interactions.push({ kind: 'native-renderer-click', selector, facts, events })
    }
    async function type(selector, value) {
      await click(selector)
      await until(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`, 'Exact input focus')
      win.webContents.selectAll()
      await until(`(() => {const n=document.querySelector(${JSON.stringify(selector)});return n.selectionStart===0&&n.selectionEnd===n.value.length})()`, 'Native Edit selectAll prepares the entire actual value')
      const beforeInsert = await read('window.__connectionsTrustedEvents.length')
      await win.webContents.insertText(value)
      await until(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`, 'Actual input value after native insertText')
      const events = await read(`window.__connectionsTrustedEvents.slice(${beforeInsert})`)
      assert.ok(events.some(event => event.type === 'input' && event.trusted), 'Actual native text entry creates a trusted input event')
      interactions.push({ kind: 'native-edit-selectAll-and-insertText', selector, value, events })
    }
    async function typeField(label, value) {
      const index = await read(`(() => {const nodes=[...document.querySelectorAll(${JSON.stringify(pane + ' [data-resource-editor] input,' + pane + ' [data-resource-editor] textarea')})];const input=[...document.querySelectorAll(${JSON.stringify(pane + ' [data-resource-editor] label')})].find(n=>n.querySelector('span')?.textContent?.startsWith(${JSON.stringify(label)}))?.querySelector('input,textarea');return nodes.indexOf(input)})()`)
      assert.ok(index >= 0, 'Actual editor field exists: ' + label)
      const selector = `${pane} [data-resource-editor] :is(input,textarea)`
      await read(`document.querySelectorAll(${JSON.stringify(selector)})[${index}].scrollIntoView({block:'nearest'})`)
      await settle()
      const position = await read(`(() => {const n=document.querySelectorAll(${JSON.stringify(selector)})[${index}],r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,visible:n.checkVisibility(),hit:n.contains(document.elementFromPoint(x,y)),connected:n.isConnected}})()`)
      assert.ok(position.connected && position.visible && position.hit, 'Actual exact field hit: ' + label)
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(position.x), y: Math.round(position.y) })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(position.x), y: Math.round(position.y) })
      await until(`document.activeElement===document.querySelectorAll(${JSON.stringify(selector)})[${index}]`)
      win.webContents.selectAll(); await until(`(() => {const n=document.querySelectorAll(${JSON.stringify(selector)})[${index}];return n.selectionStart===0&&n.selectionEnd===n.value.length})()`)
      const beforeInsert = await read('window.__connectionsTrustedEvents.length')
      await win.webContents.insertText(value)
      await until(`document.querySelectorAll(${JSON.stringify(selector)})[${index}].value===${JSON.stringify(value)}`)
      const events = await read(`window.__connectionsTrustedEvents.slice(${beforeInsert})`)
      assert.ok(events.some(event => event.type === 'input' && event.trusted), 'Actual native field entry creates a trusted input event')
      interactions.push({ kind: 'native-edit-selectAll-and-insertText', field: label, value, position, events })
    }

  return { read, until, settle, press, factsOf, click, type, typeField }
}
module.exports = { nativeRendererInput }
