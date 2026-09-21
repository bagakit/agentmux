const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence, widthText, scenario] = process.argv.slice(2)
const width = Number(widthText)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { width, scenario, passed: false, runtime: process.versions, aestheticReview: 'pending-independent-readback', steps: [],
  boundary: 'Actual production components, Radix and CSS; controlled preview configuration, empty workbench and callback sinks. No actual Main, Runtime, Run, BrowserView, restart or installation claim.' }
let win
const consoleEvents = []
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width, height: 850, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => consoleEvents.push({ level, message, line, sourceId }))
    win.webContents.on('render-process-gone', (_event, details) => consoleEvents.push({ gone: details }))
    await win.loadFile(html, { query: { scenario } })
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    win.webContents.focus()
    const read = expr => win.webContents.executeJavaScript(expr)
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
    const until = async expr => {
      const end = Date.now() + 4000
      do { if (await read(expr)) return; await delay(20) } while (Date.now() < end)
      throw new Error(`did not settle: ${expr}`)
    }
    const n = selector => `document.querySelector(${JSON.stringify(selector)})`
    const row = title => `[...document.querySelectorAll('[role=menuitemradio],[role=menuitem]')].find(node=>node.textContent.trim()===${JSON.stringify(title)})`
    const menu = n('[role=menu]')
    const point = async expr => {
      const value = await read(`(()=>{const node=${expr};if(!node?.isConnected)throw new Error('missing connected target');const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,hits:[[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]].map(([x,y])=>{const at=document.elementFromPoint(r.x+r.width*x,r.y+r.height*y);return at===node||node.contains(at)})}})()`)
      assert(value.width > 0 && value.height > 0, `visible ${expr}`)
      assert.deepEqual(value.hits, [true, true, true, true, true], `five real CSS hits: ${expr}`)
      return value
    }
    const move = async expr => { const p = await point(expr); win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y }); await delay(90) }
    const click = async expr => {
      const p = await point(expr)
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, x: p.x, y: p.y })
      await delay(50)
    }
    const key = async (name, extra = {}) => {
      const code = { Escape: 27, Tab: 9, Enter: 13, ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, End: 35, Home: 36, Backspace: 8, ' ': 32 }[name]
      assert(code, `known key ${name}`)
      for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type, key: name, code: name === ' ' ? 'Space' : name, windowsVirtualKeyCode: code, ...extra,
        ...(name === 'Enter' && type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {})
      })
      await delay(50)
    }
    const replaceText = async (expr, value) => {
      await click(expr)
      for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type, key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65,
        ...(type === 'keyDown' ? { commands: ['selectAll'] } : {})
      })
      await key('Backspace')
      for (const character of value) { await win.webContents.insertText(character); await delay(30) }
    }
    const inputState = expr => read(`(()=>{const node=${expr};return {exact:document.activeElement===node,connected:node?.isConnected,visible:!!node&&node.getClientRects().length>0&&!node.closest('[hidden],[inert]'),value:node?.value,caret:[node?.selectionStart,node?.selectionEnd]}})()`)
    const keep = async (label, expr, value, caret) => {
      const state = await inputState(expr)
      assert.deepEqual(state, { exact: true, connected: true, visible: true, value, caret: [caret, caret] }, label)
      result.steps.push({ label, state })
    }
    const feedback = expr => read(`(()=>{const node=${expr};const style=getComputedStyle(node);return {color:style.color,background:style.backgroundColor,opacity:style.opacity,highlighted:node.hasAttribute('data-highlighted')}})()`)
    const capture = async name => fs.promises.writeFile(path.join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG())
    const closeByLeave = async target => { await move(target); await delay(220); await until(`!${menu}`) }
    const exactTrigger = async expr => {
      assert.deepEqual(await read(`({exact:document.activeElement===${expr},connected:${expr}?.isConnected,visible:${expr}?.getClientRects().length>0&&!${expr}?.closest('[hidden],[inert]')})`),
        { exact: true, connected: true, visible: true }, 'exact visible connected trigger')
    }
    await until('window.__sectionHover?.ready && !!document.querySelector("input")')
    if (scenario === 'settings') {
      const font = n('[aria-label="Terminal font size in pixels"]')
      const picker = n('[aria-label="Settings section"]')
      const search = n('[aria-label="Search settings"]')
      await read(`${font}.scrollIntoView({block:'center'})`)
      await click(font)
      for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, ...(type === 'keyDown' ? { commands: ['selectAll'] } : {}) })
      await key('Backspace')
      for (const character of '18') {
        await win.webContents.insertText(character); await delay(40)
        await keep(`authored font character ${character}`, font, character === '1' ? '1' : '18', null)
      }
      assert.equal(await read(`${n('[data-settings-pane=appearance] .primary-button')}.disabled`), false)
      const pane = n('[data-settings-pane=appearance]')
      await read(`${pane}.scrollTop=100;window.__sectionScroll=${pane}.scrollTop;true`)
      if (width < 700) {
        await point(picker)
        await move(picker)
        assert.equal(await read('document.querySelectorAll("[role=menu]").length'), 1, 'actual Settings hover reveals one menu')
        await until(`!!${menu}`)
        const titles = await read(`[...document.querySelectorAll('[role=menuitemradio]')].map(node=>node.textContent.trim())`)
        const expected = await read('window.__sectionHover.categories("")')
        assert(expected.length > 1); assert.deepEqual(titles, expected)
        assert.equal(await read(`!!document.querySelector('[data-overlay-host] [role=menu]')`), true)
        await keep('trigger hover keeps numeric draft', font, '18', null)
        const normal = await feedback(row('Workspaces'))
        await move(row('Workspaces')); await keep('RadioItem A move', font, '18', null)
        const hovered = await feedback(row('Workspaces'))
        assert.notEqual(hovered.background, normal.background, 'actual RadioItem CSS hover is visible with input focus')
        await move(row('General')); await keep('RadioItem A leave and B move', font, '18', null)
        await capture(`settings-${width}-radio-hover`)
        await move(n('.settings-section-menu__label')); await keep('RadioItem B leave to menu gap', font, '18', null)
        await capture(`settings-${width}-hover`)
        await closeByLeave(search); await keep('leave closes only menu', font, '18', null)
        await move(picker); await until(`!!${menu}`); await move(row('General'))
        await closeByLeave(search); await keep('direct RadioItem exit closes menu and preserves input', font, '18', null)
        await move(picker); await until(`!!${menu}`); await key('Escape'); await until(`!${menu}`)
        await keep('hover Escape preserves font', font, '18', null)
        await move(search); await move(picker); await until(`!!${menu}`)
        await click(row('General'))
        await until(`!${menu} && document.querySelector('.settings-content__header h2').textContent==='General'`)
        await exactTrigger(picker)
        result.steps.push({ label: 'different category selected once', heading: 'General', focusReturn: true })
        await move(search); await move(picker); await until(`!!${menu}`); await click(row('Appearance'))
        await until(`!${menu} && document.querySelector('.settings-content__header h2').textContent==='Appearance'`)
        assert.equal(await read(`${font}.value`), '18')
        assert.equal(await read(`${pane}.scrollTop`), await read('window.__sectionScroll'))
        assert.equal(await read(`${n('[data-settings-pane=appearance] .primary-button')}.disabled`), false)
        // New external focus wins over the trigger's automatic return.
        await move(search); await move(picker); await until(`!!${menu}`); await click(search); await until(`!${menu}`)
        await exactTrigger(search)
        await key('Tab'); await exactTrigger(picker)
        await key('ArrowDown'); await until(`!!${menu}`); await key('ArrowDown')
        assert.equal(await read('document.activeElement?.getAttribute("role")'), 'menuitemradio')
        assert.equal(await read('document.activeElement?.hasAttribute("data-highlighted")'), true)
        await capture(`settings-${width}-keyboard`)
        await key('Escape'); await until(`!${menu}`); await exactTrigger(picker)
        for (const openKey of ['Enter', ' ']) {
          await key(openKey); await until(`!!${menu}`); await key('Escape'); await until(`!${menu}`); await exactTrigger(picker)
        }
        await key('ArrowDown'); await until(`!!${menu}`); await key('End'); await key('ArrowUp')
        assert.equal(await read('document.activeElement?.textContent.trim()'), 'Copy Paths')
        await key('Enter'); await until(`!${menu}`); await exactTrigger(picker)
        assert.equal(await read(`document.querySelector('.settings-content__header h2').textContent`), 'Copy Paths')
        await replaceText(search, 'copy')
        await move(picker); await until(`!!${menu}`)
        const filtered = await read('window.__sectionHover.categories("copy")'); assert(filtered.length > 0)
        assert.deepEqual(await read(`[...document.querySelectorAll('[role=menuitemradio]')].map(node=>node.textContent.trim())`), filtered)
        await closeByLeave(search)
        await replaceText(search, 'zz-no-matches')
        assert.deepEqual(await read('window.__sectionHover.categories("zz-no-matches")'), [])
        assert.equal(await read(`${picker}.disabled`), true)
        await move(picker); await delay(220); assert.equal(await read(`!!${menu}`), false)
        await point(n('[aria-label="Clear settings search"]'))
        await click(n('[aria-label="Clear settings search"]')); await exactTrigger(search)
        assert.equal(await read(`${search}.value`), '')
        await move(picker); await until(`!!${menu}`); await click(row('Appearance')); await until(`!${menu}`)
      } else {
        assert.equal(await read(`${picker}.getClientRects().length`), 0, 'wide workbench keeps original sidebar')
        const nav = title => `[...document.querySelectorAll('nav[aria-label="Settings sections"] button')].find(node=>node.textContent.trim()===${JSON.stringify(title)})`
        await click(nav('General')); await click(nav('Appearance'))
        assert.equal(await read(`${font}.value`), '18')
        assert.equal(await read(`${pane}.scrollTop`), await read('window.__sectionScroll'))
        await replaceText(search, 'copy'); await point(n('[aria-label="Clear settings search"]'))
        await click(n('[aria-label="Clear settings search"]')); await exactTrigger(search)
        assert.equal(await read(`${search}.value`), '')
        await click(nav('Appearance'))
        assert.equal(await read(`${font}.value`), '18')
        assert.equal(await read(`${n('[data-settings-pane=appearance] .primary-button')}.disabled`), false)
      }
      assert.equal(await read('window.__sectionHover.facts()'), await read('window.__sectionHover.initialFacts'), 'committed config and workbench facts unchanged')
      assert.equal(await read('window.__sectionHover.saves'), 0)
      await point(search); await point(n('[aria-label="Close settings"]'))
      const status = await point(n('.window-status-bar')); assert.equal(status.height, 32)
      result.steps.push({ label: 'original search/close/status reachable', status })
      await capture(`settings-${width}-dirty`)
      await click(n('[aria-label="Close settings"]')); await until('!document.querySelector(".settings-page")')
      assert.equal(await read(`${n('.window-status-bar')}.getBoundingClientRect().height`), 32)
    } else {
      const input = n('[aria-label="Controlled authored text"]')
      await click(input); await key('Home'); await key('ArrowRight'); await key('ArrowRight')
      await keep('text caret from trusted keys', input, 'draft', 2)
      const split = n('[aria-label="Choose split direction"]')
      await move(split); await until(`!!${menu}`)
      await move(row('Split Left')); await keep('ordinary Item A', input, 'draft', 2)
      await move(row('Split Right')); await keep('ordinary Item A leave/B move', input, 'draft', 2)
      await capture('ordinary-item-active-hover')
      await move(n('.tab-context-menu__separator')); await keep('ordinary Item gap', input, 'draft', 2)
      await capture('ordinary-item-hover')
      await closeByLeave(input); await keep('ordinary Item leave', input, 'draft', 2)
      await move(split); await until(`!!${menu}`); await move(row('Split Right'))
      await closeByLeave(input); await keep('direct ordinary Item exit', input, 'draft', 2)
      assert.deepEqual(await read('window.__sectionHover.actions'), [])
      await move(split); await until(`!!${menu}`); await click(row('Split Left')); await until(`!${menu}`)
      assert.deepEqual(await read('window.__sectionHover.actions'), [{ kind: 'split', direction: 'left' }])
      await click(input); await key('Home'); await key('ArrowRight'); await key('ArrowRight')
      const browser = n('.browser-operation-status__trigger')
      await move(browser); await until(`!!${menu}`)
      const browserRow = row('Activity'), normal = await feedback(browserRow)
      await move(browserRow); await keep('actual BrowserOperationStatus Item', input, 'draft', 2)
      const hovered = await feedback(browserRow)
      assert.notEqual(hovered.background, normal.background, 'actual browser item CSS hover background')
      assert.notEqual(hovered.color, normal.color, 'actual browser item CSS hover text')
      assert.equal(hovered.highlighted, false, 'hover feedback does not fake keyboard focus')
      result.steps.push({ label: 'actual Browser CSS feedback', normal, hovered })
      await capture('browser-item-hover'); await closeByLeave(input); await keep('Browser Item leave', input, 'draft', 2)
      const posture = n('[aria-label="Controlled posture"]')
      await move(posture); await until(`!!${menu}`)
      for (const tier of ['safe', 'caution', 'danger']) {
        const item = `document.querySelector('.posture-menu__item[data-tier=${tier}]')`
        const label = `${item}.querySelector('.posture-menu__label strong')`, mark = `${item}.querySelector('.posture-menu__mark')`
        await move(n('.posture-menu')); const before = await feedback(label)
        await move(item); await keep(`posture ${tier} input`, input, 'draft', 2)
        const after = await feedback(label), checkedMark = await feedback(mark)
        assert.equal(checkedMark.opacity, '0.55', 'actual mark hover feedback')
        if (tier === 'safe') assert.notEqual(after.color, before.color)
        else assert.equal(after.color, before.color, `${tier} keeps its original tier color priority`)
        result.steps.push({ label: `Posture ${tier} feedback`, before, after, mark: checkedMark })
      }
      await capture('posture-danger-hover'); await closeByLeave(input)
      const project = n('.project-activity')
      await move(project); await until(`!!${menu}`)
      for (const selector of ['.project-activity-group__summary', '.project-activity-group__disclosure']) {
        const item = n(selector), before = await feedback(item)
        await move(item); await keep(`${selector} hover`, input, 'draft', 2)
        const after = await feedback(item)
        assert.notEqual(after.background, before.background, `actual ${selector} feedback`)
        assert.equal(await read(`!!document.querySelector('.project-activity-group--expanded')`), false)
        result.steps.push({ label: selector + ' feedback', before, after })
        await capture(selector.endsWith('__summary') ? 'project-summary-hover' : 'project-disclosure-hover')
        await move(n('.composer-menu__hint')); await keep(`${selector} leave`, input, 'draft', 2)
      }
      await capture('project-activity-hover'); await closeByLeave(input)
      await move(n('[aria-label="Disabled item proof"]')); await until(`!!${menu}`)
      for (const title of ['Disabled Item', 'Disabled Radio']) {
        await move(row(title)); await keep(title + ' hover', input, 'draft', 2)
        await click(row(title)); await keep(title + ' click', input, 'draft', 2)
      }
      await closeByLeave(input)
      assert.deepEqual(await read('window.__sectionHover.actions'), [{ kind: 'split', direction: 'left' }], 'all other hover and disabled paths have no actions')
      await capture('feedback-final')
    }
    result.events = await read('window.__sectionHover.events')
    assert(result.events.length > 0)
    const native = result.events.filter(event => event.type !== 'click'); assert(native.length > 0)
    assert(native.every(event => event.trusted), 'actual input, key and pointer events are trusted')
    const generatedClicks = result.events.filter(event => event.type === 'click' && !event.trusted)
    assert.deepEqual(generatedClicks.map(event => event.label), scenario === 'settings' && width < 700 ? ['Copy Paths'] : [])
    result.eventBoundary = 'Real mouse/key/input events are trusted. Only Radix keyboard selection synthesizes its final click from trusted Enter.'
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win) {
      result.failure.document = await win.webContents.executeJavaScript('({body:document.body.outerHTML,focus:document.activeElement?.outerHTML})').catch(() => null)
      fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
    }
  } finally {
    result.consoleEvents = consoleEvents
    fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2) + '\n')
    win?.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
