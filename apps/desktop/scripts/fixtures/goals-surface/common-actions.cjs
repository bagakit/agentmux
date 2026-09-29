const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto')
const [html, privateRoot, evidence, mode] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.goals-common-actions-render.v1', passed: false, frames: [], observations: [], userRunTouched: false, consoleErrors: [], simulatedBoundary: 'Private config expected/conflict merge and preview Sessions; no native CLI or installed App.' }
let win
const evaluate = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(expression) { for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await delay(25) } throw new Error('Timed out: ' + expression) }
async function paint() { await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(60) }
async function size(width) { await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: 780, deviceScaleFactor: 1, mobile: false }); await paint() }
async function seed(scenario, appearance) { await evaluate(`goalsVisual.seedCommon(${JSON.stringify(scenario)});goalsVisual.appearance(${JSON.stringify(appearance)})`); await paint() }
async function clickText(text) { await evaluate(`(()=>{const b=[...document.querySelectorAll('.goals-common button')].find(b=>b.textContent===${JSON.stringify(text)});if(!b)throw new Error('Missing product control '+${JSON.stringify(text)});b.click()})()`); await paint() }
async function capture(name, width) {
  if (mode === 'assertions-only' || mode === 'focus-regression-only') return
  await paint(); const bytes = (await win.webContents.capturePage()).toPNG(), file = name + '.png'
  await fs.writeFile(path.join(evidence, file), bytes); result.frames.push({ name, width, file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
}
async function fillBody(body) { await evaluate(`(()=>{const e=document.querySelector('[data-common-editor] textarea');if(!e)throw new Error('Missing actual body editor');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(body)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`); await paint() }
async function inspect(name) {
  const facts = await evaluate(`(()=>{
    const rect=e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
    const reading=document.querySelector('.goals-common__reading'), collection=document.querySelector('.goals-collection'), common=document.querySelector('.goals-common')
    return {appearance:document.documentElement.dataset.appearance,common:rect(common),collection:rect(collection),reading:reading&&{...rect(reading),scrollHeight:reading.scrollHeight,clientHeight:reading.clientHeight,overflow:getComputedStyle(reading).overflowY,tabIndex:reading.tabIndex},image:document.querySelector('.goals-common__hero img')&&rect(document.querySelector('.goals-common__hero img')),requests:[...document.querySelectorAll('[data-common-action]')].map(button=>{
      const request=button.querySelector('.goals-entry__request'),line=button.querySelector('.goals-common__request-line'),arrow=line.querySelector('svg')
      return{key:button.dataset.commonAction,body:request.textContent,request:rect(request),line:rect(line),arrow:rect(arrow),font:parseFloat(getComputedStyle(button).fontSize),clipped:request.scrollWidth>request.clientWidth,whiteSpace:getComputedStyle(request).whiteSpace,opacity:getComputedStyle(button).opacity,disabled:button.disabled,target:button.querySelector('.goals-common__facts').textContent}
    }),view:document.querySelector('.goals-common__manager')?.dataset.view}
  })()`)
  result.observations.push({ name, ...facts })
  assert.ok(facts.common.width > 0 && facts.common.height > 0, 'Common actions are visibly mounted in the actual Goals surface')
  assert.ok(facts.collection.width > 0 && facts.collection.height >= 80, 'Actual Goals collection keeps a visible reading unit')
  if (facts.reading) {
    assert.ok(facts.reading.height <= 242, 'Initial and expanded actions share a bounded reading budget')
    assert.equal(facts.reading.overflow, 'auto', 'Long complete requests remain scroll-readable')
    assert.equal(facts.reading.tabIndex, 0, 'Complete request reading area is keyboard reachable')
    assert.ok(facts.requests.length > 0, 'Request assertions observe a nonempty actual action set')
    for (const request of facts.requests) {
      assert.ok(request.font >= 13, 'Complete common action body keeps readable prose size')
      assert.equal(request.clipped, false, 'Complete common action body has no horizontal clipping')
      assert.equal(request.whiteSpace, 'pre-wrap', 'Authored line breaks remain in the visible complete body')
      assert.equal(request.opacity, '1', 'Disabled or preparing requests remain readable')
      assert.ok(Math.abs(request.arrow.top - request.request.top) < 7, 'Action arrow aligns with the request first line')
      assert.ok(request.arrow.left - request.request.right <= 13, 'Action arrow stays adjacent to the request')
    }
  }
  return facts
}
async function pointer(type, selector = '[data-common-action="builtin:understand"]') {
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing pointer target');const r=e.getBoundingClientRect();return{x:r.x+20,y:r.y+16}})()`)
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) }); await paint()
}
async function assertInnerFocus(name) {
  const facts = await evaluate('(()=>{const e=document.activeElement,s=getComputedStyle(e);return{tag:e.tagName,classes:e.className,visible:e.matches(":focus-visible"),offset:parseFloat(s.outlineOffset),width:parseFloat(s.outlineWidth),style:s.outlineStyle}})()')
  assert.equal(facts.visible, true, 'Actual common control has keyboard-visible focus')
  assert.ok(facts.offset <= -2 && facts.width >= 2 && facts.style === 'solid', 'Common control focus remains inside its scroll-clipped bounds')
  result.observations.push({ name, ...facts })
}
async function focusScenes() {
  await seed('empty', 'dark'); await size(620)
  await evaluate('document.querySelector("[data-common-action=\\"builtin:understand\\"]").focus()')
  for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  assert.equal(await evaluate('document.activeElement.dataset.commonAction'), 'builtin:ideas')
  await assertInnerFocus('620-dark-execution-focus'); await capture('620-dark-common-keyboard-focus', 620)
  await pointer('mouseMoved'); await capture('620-dark-common-hover', 620)
  await pointer('mousePressed'); await capture('620-dark-common-pressed', 620)
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 1, button: 'left', clickCount: 1 }); await paint()
  await seed('empty', 'light'); await size(620); await clickText('管理'); await clickText('新增操作'); await fillBody('这条尚未保存的操作应回到同一个目录位置。')
  const draftId = await evaluate('document.querySelector("[data-common-editor]").dataset.commonEditor')
  await clickText('返回目录'); assert.equal(await evaluate('document.activeElement.dataset.commonSelect'), `prompt:${draftId}`, 'Unsaved draft returns actual keyboard focus to its stable directory row')
  for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 })
  await assertInnerFocus('620-light-draft-return-focus'); await capture('620-light-common-new-draft-return-focus', 620)
  await evaluate('document.activeElement.click()'); await paint(); assert.equal(await evaluate('document.querySelector("[data-common-editor] textarea").value'), '这条尚未保存的操作应回到同一个目录位置。')
  await evaluate('document.querySelector("[data-common-editor] textarea").focus()'); await assertInnerFocus('620-light-editor-focus'); await capture('620-light-common-new-draft-reopened', 620)
  result.observations.push({ name: 'actual-new-draft-return', id: draftId, sameRefFocused: true, bodyPreserved: true })
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true }); win = new BrowserWindow({ show: false, width: 1280, height: 780, webPreferences: { sandbox: false, backgroundThrottling: false } })
    win.webContents.on('console-message', details => { if (details.level === 'error') result.consoleErrors.push({ message: details.message, line: details.lineNumber, source: details.sourceId }) })
    await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('Boolean(window.goalsVisual) && Boolean(document.querySelector(".goals-common"))')
    const original = await evaluate('goalsVisual.facts().runs')
    if (mode === 'corrections-only' || mode === 'focus-regression-only') {
      await focusScenes()
      if (mode === 'corrections-only') {
        for (const appearance of ['dark', 'light']) {
          await seed('many', appearance); await size(1280); await clickText('管理')
          await evaluate('document.querySelector("[data-common-select=\\"prompt:common-review\\"]").click()'); await paint()
          const columns = await evaluate('[".goals-common__library",".goals-common__editor"].map(s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return{width:r.width,height:r.height}})')
          assert.equal(columns.length, 2); assert.ok(columns.every(column => column.width > 100 && column.height > 0), 'Wide management shows the actual directory and original body editor together')
          await capture(`1280-${appearance}-common-management`, 1280)
        }
        await seed('explicit-empty', 'light'); await size(620)
        assert.equal(await evaluate('document.querySelectorAll("[data-common-action]").length'), 0, 'Explicitly empty authored directory does not silently restore defaults')
        assert.ok(await evaluate('document.querySelector(".goals-common__empty").getBoundingClientRect().height>0'))
        await capture('620-light-common-authored-empty', 620)
      }
    } else if (mode === 'focus-only') {
      await seed('empty', 'light'); await size(620); await clickText('管理'); await clickText('新增操作'); await fillBody('这条尚未保存的操作应回到同一个目录位置。')
      const draftId = await evaluate('document.querySelector("[data-common-editor]").dataset.commonEditor')
      await clickText('返回目录'); assert.equal(await evaluate('document.activeElement.dataset.commonSelect'), `prompt:${draftId}`, 'Unsaved draft returns actual keyboard focus to its stable directory row')
      await capture('620-light-common-new-draft-return-focus', 620)
      await evaluate('document.activeElement.click()'); await paint(); assert.equal(await evaluate('document.querySelector("[data-common-editor] textarea").value'), '这条尚未保存的操作应回到同一个目录位置。')
      await capture('620-light-common-new-draft-reopened', 620)
      result.observations.push({ name: 'actual-new-draft-return', id: draftId, sameRefFocused: true, bodyPreserved: true })
    } else {
    for (const appearance of mode === 'assertions-only' ? ['dark'] : ['dark', 'light']) {
      for (const scenario of mode === 'assertions-only' ? ['project', 'many', 'long'] : ['empty', 'project', 'many']) {
        for (const width of mode === 'assertions-only' ? [620] : [1280, 620]) {
          await seed(scenario, appearance); await size(width)
          if (scenario === 'many') await clickText('全部操作（6）')
          const facts = await inspect(`${width}-${appearance}-${scenario}`)
          if (scenario === 'empty') assert.deepEqual(facts.requests.map(request => request.body), ['我还不知道能做什么，可以了解我并给我建议吗？', '我有一些点子，我们开始尝试一个项目'])
          if (scenario === 'project') { assert.equal(facts.requests[2].body, '根据最近的项目情况，建议我下一步应该做什么'); assert.ok(facts.requests[2].target.includes('最近项目 · '), 'Exact reliable Project is visible beside its request') }
          await capture(`${width}-${appearance}-common-${scenario}`, width)
        }
      }
      if (mode !== 'assertions-only') {
        await seed('empty', appearance); await size(620); await clickText('管理'); await clickText('新增操作'); await fillBody('帮我检查今天的笔记，指出一个值得尝试的方向。')
        assert.equal(await evaluate('document.querySelector(".goals-common__manager").dataset.view'), 'editor')
        await inspect(`620-${appearance}-custom-editor`); await capture(`620-${appearance}-common-custom-editor`, 620)
        await clickText('返回目录'); await capture(`620-${appearance}-common-custom-library`, 620)
        await evaluate('document.querySelector(".goals-common__draft").click()'); await paint(); assert.equal(await evaluate('document.querySelector("[data-common-editor] textarea").value'), '帮我检查今天的笔记，指出一个值得尝试的方向。')
        await clickText('保存操作'); await waitFor('document.querySelector(".goals-common").getAttribute("aria-busy")==="false"'); await clickText('完成'); await capture(`620-${appearance}-common-custom-saved`, 620)
      }
    }
    await seed('long', 'light'); await size(320)
    const first = await inspect('320-light-long-top'); assert.ok(first.reading.scrollHeight > first.reading.clientHeight, 'A real long body exceeds the same reading budget')
    await capture('320-light-common-long-top', 320)
    await evaluate('(()=>{const r=document.querySelector(".goals-common__reading"),body=r.querySelector(".goals-entry__request");r.scrollTop=body.offsetHeight-r.clientHeight+35})()'); await paint(); await capture('320-light-common-long-body-scroll', 320)
    const scrolling = await evaluate('(()=>{const r=document.querySelector(".goals-common__reading");const body=r.querySelector(".goals-entry__request"),range=document.createRange(),at=body.textContent.indexOf("9. 阅读当前记录");if(at<0)throw new Error("Missing final authored line");range.setStart(body.firstChild,at);range.setEnd(body.firstChild,body.textContent.length);const end=range.getBoundingClientRect(),view=r.getBoundingClientRect();return{top:r.scrollTop,body:body.textContent,finalLineVisible:end.top>=view.top&&end.bottom<=view.bottom}})()')
    assert.ok(scrolling.top > 0, 'Actual complete request reading scroll moved'); assert.equal(scrolling.finalLineVisible, true, 'Long request final line was actually scrolled into the visible reading area')
    result.observations.push({ name: 'long-body-actual-scroll', ...scrolling })
    if (mode !== 'assertions-only') {
      await seed('empty', 'dark'); await size(620)
      await evaluate('document.querySelector("[data-common-action=\\"builtin:understand\\"]").focus()')
      for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      assert.equal(await evaluate('document.activeElement.dataset.commonAction'), 'builtin:ideas'); assert.equal(await evaluate('document.activeElement.matches(":focus-visible")'), true)
      await capture('620-dark-common-keyboard-focus', 620)
      await pointer('mouseMoved'); await capture('620-dark-common-hover', 620)
      await pointer('mousePressed'); await capture('620-dark-common-pressed', 620)
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 1, button: 'left', clickCount: 1 }); await paint()
      await seed('unavailable', 'dark'); await size(620); const unavailable = await inspect('620-dark-unavailable'); assert.equal(unavailable.requests[0].disabled, true); await capture('620-dark-common-no-matching-agent', 620)
      await seed('many', 'dark'); await size(620); await clickText('管理'); await evaluate('document.querySelector("[data-common-select=\\"prompt:common-review\\"]").click()'); await paint(); await fillBody('保留这次编辑的正文。')
      await evaluate('goalsVisual.failConfigSave(true)'); await clickText('保存操作'); await waitFor('Boolean(document.querySelector(".goals-common [role=alert]"))'); await capture('620-dark-common-save-failure', 620)
      assert.equal(await evaluate('document.querySelector("[data-common-editor] textarea").value'), '保留这次编辑的正文。')
      await evaluate('goalsVisual.failConfigSave(false);goalsVisual.externalPromptBody("common-review","他人刚保存的正文")'); await clickText('保存操作'); await waitFor('document.querySelector(".goals-common [role=alert]").textContent.includes("composerShortcuts.common-review.body")'); await capture('620-dark-common-save-conflict', 620)
      await seed('project', 'dark'); await size(620); await evaluate('goalsVisual.holdPreparation()'); await pointer('mousePressed', '[data-common-action="builtin:next"]'); await pointer('mouseReleased', '[data-common-action="builtin:next"]'); await waitFor('!document.querySelector(".goals-common")')
      await evaluate('document.querySelector("[aria-label=\\"Goals: show goals and progress\\"]").click()'); await waitFor('Boolean(document.querySelector(".goals-entry__preparing"))')
      if (await evaluate('Boolean(document.querySelector("[aria-label=\\"Back to goals\\"]"))')) await evaluate('document.querySelector("[aria-label=\\"Back to goals\\"]").click()')
      await waitFor('document.querySelector(".goals-common__reading").getBoundingClientRect().width>0'); await inspect('620-dark-preparing'); await capture('620-dark-common-preparing', 620)
      assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-common-action]")].map(button=>button.disabled)'), [true, true, true])
      await evaluate('goalsVisual.finishPreparation()'); await waitFor('!document.querySelector(".goals-entry__preparing")')
      await seed('project', 'light'); await size(320)
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-reduced-transparency', value: 'reduce' }, { name: 'prefers-contrast', value: 'more' }] })
      assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-common-action]")).transitionDuration'), '0s'); await capture('320-light-common-preferences', 320)
    }
    }
    assert.deepEqual(await evaluate('goalsVisual.facts().runs'), original, 'Original preview Run identities remain intact')
    assert.deepEqual(result.consoleErrors, []); result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win) await capture('failure-state', await evaluate('innerWidth')) }
  finally { await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
