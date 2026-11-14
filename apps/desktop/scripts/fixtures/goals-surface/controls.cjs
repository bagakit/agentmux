const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto')
const [html, privateRoot, evidence, mode] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.goals-entry-controls-render.v1', passed: false, frames: [], observations: [], userRunTouched: false, consoleErrors: [] }
let win
const evaluate = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(expression) { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(25) } throw new Error('Timed out: ' + expression) }
async function paint() { await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(80) }
async function size(width) { await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: 780, deviceScaleFactor: 1, mobile: false }); await paint() }
async function pointer(type, target = '[data-goals-entry-action="understand"]') {
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(target)});if(!e)throw new Error('Missing actual target');const r=e.getBoundingClientRect();return{x:r.x+20,y:r.y+r.height/2}})()`)
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) }); await paint()
}
async function capture(name, width, preservePointer = false) {
  if (!preservePointer) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  await paint(); const bytes = (await win.webContents.capturePage()).toPNG(), file = name + '.png'
  await fs.writeFile(path.join(evidence, file), bytes); result.frames.push({ name, width, file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
}
async function inspect(name, projectSource) {
  const facts = await evaluate(`(()=>{
    const group=document.querySelector('.goals-entry__actions'), rect=e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
    if(!group)throw new Error('Missing Goals entry group')
    return {group:rect(group), rowGap:parseFloat(getComputedStyle(group).rowGap), buttons:[...group.querySelectorAll('button')].map(button=>{
      const request=button.querySelector('.goals-entry__request'), strong=request?.querySelector('strong'), project=button.querySelector('small'), arrow=button.querySelector('svg'), copy=button.querySelector('.goals-common__copy')
      return {id:button.dataset.goalsEntryAction,text:request?.textContent,strong:strong?.textContent,font:parseFloat(getComputedStyle(button).fontSize),weight:strong&&getComputedStyle(strong).fontWeight,rect:rect(button),copy:copy&&rect(copy),arrow:arrow&&rect(arrow),project:project&&{text:project.textContent,title:project.title,rect:rect(project),display:getComputedStyle(project).display,visibility:getComputedStyle(project).visibility,opacity:getComputedStyle(project).opacity},clipped:button.scrollWidth>button.clientWidth,opacity:getComputedStyle(button).opacity}
    }),list:!!document.querySelector('.goals-collection'),heading:document.querySelector('.goals-common__heading')?.textContent,appearance:document.documentElement.dataset.appearance}
  })()`)
  result.observations.push({ name, ...facts })
  assert.equal(facts.heading, 'Common actions'); assert.ok(facts.list, 'The CTA is mounted beside its real Goals collection')
  assert.deepEqual(facts.buttons.map(button => button.id), projectSource ? ['understand', 'ideas', 'next'] : ['understand', 'ideas'])
  assert.deepEqual(facts.buttons.slice(0, 2).map(button => button.text), ['我还不知道能做什么，可以了解我并给我建议吗？', '我有一些点子，我们开始尝试一个项目'])
  assert.deepEqual(facts.buttons.slice(0, 2).map(button => button.strong), ['了解我并给我建议吗？', '开始尝试一个项目'])
  assert.ok(facts.group.width > 0 && facts.group.height > 0, 'The real entry surface is visible rather than merely mounted')
  assert.equal(facts.rowGap, 8, 'Actions keep the current 8px spacing token')
  // The current responsive grid owns full available width; per-button clipping checks carry readability.
  for (const button of facts.buttons) {
    assert.ok(button.font >= 13, `Complete request ${button.id} keeps readable prose size`)
    assert.ok(Number(button.weight) >= 550, `Request ${button.id} has inline semantic emphasis`)
    assert.equal(button.clipped, false, `Complete request ${button.id} is not clipped`)
    assert.ok(button.rect.height >= 44, `Request ${button.id} keeps its full hit area`)
    assert.ok(button.arrow.left - button.copy.right <= 13, `Request ${button.id} keeps its arrow adjacent`)
    assert.equal(button.opacity, '1', `Request ${button.id} remains readable in its actual state`)
  }
  if (projectSource) {
    const next = facts.buttons[2], project = await evaluate('goalsVisual.project()')
    assert.equal(next.text, projectSource === 'recent' ? '根据最近的项目情况，建议我下一步应该做什么' : '根据当前项目的情况，建议我下一步应该做什么')
    assert.equal(next.strong, '建议我下一步应该做什么')
    assert.equal(next.project?.text, `${projectSource === 'recent' ? 'Recent project' : 'Current project'} · ${project.name}`, 'Exact acting Project is visible adjacent to the request')
    assert.ok(next.project.rect.width > 0 && next.project.rect.height > 0 && next.project.display !== 'none' && next.project.visibility === 'visible' && next.project.opacity === '1', 'Exact acting Project metadata is actually visible')
    assert.equal(next.project.title, `${project.hostId} · ${project.path}`)
    assert.ok(next.project.rect.bottom <= next.rect.bottom, 'The complete Project metadata stays inside its action')
  }
  for (let i = 1; i < facts.buttons.length; i++) if (facts.buttons[i].rect.top > facts.buttons[i - 1].rect.top) assert.ok(Math.abs(facts.buttons[i].rect.top - facts.buttons[i - 1].rect.bottom - facts.rowGap) < 1, 'Actions form complete rows with the declared spacing token')
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true }); win = new BrowserWindow({ show: false, width: 1280, height: 780, webPreferences: { sandbox: false, backgroundThrottling: false } })
    win.webContents.on('console-message', details => { if (details.level === 'error') result.consoleErrors.push({ message: details.message, line: details.lineNumber, source: details.sourceId }) })
    await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('Boolean(window.goalsVisual) && Boolean(document.querySelector(".goals-entry"))')
    const original = await evaluate('goalsVisual.facts().runs')
    for (const appearance of mode === 'assertions-only' ? ['dark'] : ['dark', 'light']) {
      for (const scenario of mode === 'assertions-only' ? ['current'] : ['empty', 'one', 'many', 'recent', 'current']) {
        await evaluate(`goalsVisual.seed(${JSON.stringify(scenario)});goalsVisual.appearance(${JSON.stringify(appearance)})`)
        for (const width of mode === 'assertions-only' ? [620] : [1280, 620]) {
          await size(width); await inspect(`${width}-${appearance}-${scenario}`, ['recent', 'current'].includes(scenario) ? scenario : undefined)
          if (mode !== 'assertions-only') await capture(`${width}-${appearance}-entry-${scenario}`, width)
        }
      }
    }
    if (mode !== 'assertions-only') {
      await evaluate('goalsVisual.seed("long-current");goalsVisual.appearance("light")'); await size(320); await inspect('320-light-long-current', 'current'); await capture('320-light-entry-long-current', 320)
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-reduced-transparency', value: 'reduce' }, { name: 'prefers-contrast', value: 'more' }] }); await paint()
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".goals-entry__actions > button")).transitionDuration'), '0s')
      await inspect('320-light-accessibility-preferences', 'current'); await capture('320-light-entry-preferences', 320)
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
      await evaluate('goalsVisual.seed("current");goalsVisual.appearance("dark")'); await size(620)
      await evaluate('document.querySelector("[data-goals-entry-action=understand]").focus()')
      for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      assert.equal(await evaluate('document.activeElement.dataset.goalsEntryAction'), 'ideas')
      assert.equal(await evaluate('document.activeElement.matches(":focus-visible")'), true, 'Real keyboard focus is visibly represented')
      await capture('620-dark-entry-keyboard-focus', 620)
      await pointer('mouseMoved'); assert.equal(await evaluate('document.querySelector("[data-goals-entry-action=understand]").matches(":hover")'), true); await capture('620-dark-entry-hover', 620, true)
      await pointer('mousePressed'); assert.equal(await evaluate('document.querySelector("[data-goals-entry-action=understand]").matches(":active")'), true); await capture('620-dark-entry-pressed', 620, true)
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 1, button: 'left', clickCount: 1 }); await paint()
      await evaluate('goalsVisual.seed("recent");goalsVisual.appearance("dark");goalsVisual.holdPreparation()'); await pointer('mousePressed', '[data-goals-entry-action="next"]'); await pointer('mouseReleased', '[data-goals-entry-action="next"]')
      await waitFor('document.querySelector("[data-pmo-teams-topic-floating]")?.dataset.state === "open"')
      assert.equal(await evaluate('Boolean(document.querySelector(".goals-entry"))'), true, 'Background preparation keeps the original Goals surface')
      await pointer('mousePressed', '[aria-label="Close Mote"]'); await pointer('mouseReleased', '[aria-label="Close Mote"]')
      await waitFor('document.querySelector("[data-pmo-teams-topic-floating]")?.dataset.state === "closed"')
      await waitFor('Boolean(document.querySelector(".goals-entry__preparing"))')
      await paint()
      assert.equal(await evaluate('document.querySelector(".goals-entry__preparing").textContent'), 'Preparing discussion…')
      assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-goals-entry-action]")].map(e=>e.disabled)'), [true, true, true])
      await inspect('620-dark-pending', 'recent'); await capture('620-dark-entry-preparing', 620)
      await evaluate('goalsVisual.finishPreparation()'); await waitFor('!document.querySelector(".goals-entry__preparing")')
      assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-goals-entry-action]")].map(e=>e.disabled)'), [false, false, false])
    }
    assert.deepEqual(await evaluate('goalsVisual.facts().runs'), original, 'Original preview Run identities remain intact')
    assert.deepEqual(result.consoleErrors, []); result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && mode !== 'assertions-only') await capture('failure-state', await evaluate('innerWidth')) }
  finally { await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
