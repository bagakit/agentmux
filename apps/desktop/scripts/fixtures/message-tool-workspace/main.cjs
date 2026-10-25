const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const [html, privateRoot, evidence, mode = 'full'] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, mode, captureOnly: true, aestheticReview: 'not-performed', userRunTouched: false,
  runtime: { electron: process.versions.electron, chromium: process.versions.chrome }, scenes: [], frames: [] }
let win
const surface = `document.querySelector('[data-workbench-region-id="region-actions-target"]')`
const panel = `${surface}.querySelector('.composer-mailbox')`
const editor = `${surface}.querySelector('.composer [role="textbox"]')`
const visiblePanel = `${panel}.querySelector('[role="tabpanel"]:not([hidden])')`
const query = `${visiblePanel}.querySelector('input[type="search"]')`
const buttons = (name, root = panel) => `([...${root}.querySelectorAll('button')].find(n=>!n.closest('[hidden]')&&(n.getAttribute('aria-label')===${JSON.stringify(name)}||n.textContent.trim()===${JSON.stringify(name)})))`
const tab = name => `([...${panel}.querySelectorAll('[role="tab"]')].find(n=>!n.closest('[hidden]')&&(n.querySelector('.composer-mailbox__folder-label')?.textContent??n.textContent).trim()===${JSON.stringify(name)}))`
const evaluate = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const visible = target => `(()=>{const n=${target};if(!n)return false;const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(n).visibility==='visible'})()`
async function waitFor(expression) {
  for (let i = 0; i < 160; i++) { if (await evaluate(expression)) return; await delay(25) }
  throw new Error('Timed out: ' + expression)
}
async function painted() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await delay(100) }
async function click(target) {
  await waitFor(visible(target))
  await evaluate(`${target}.scrollIntoView({block:'nearest'})`)
  const point = await evaluate(`(()=>{const n=${target},r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(n!==hit&&!n.contains(hit))throw new Error('Original action is not hit: '+n.outerHTML);return{x,y}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  await painted()
}
async function key(key, code, virtual) {
  for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: virtual,
    ...(type === 'keyDown' && key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) })
  await painted()
}
async function replace(target, value) {
  await click(target); win.webContents.selectAll(); await key('Backspace', 'Backspace', 8)
  await win.webContents.insertText(value); await painted()
}
async function choose(name) { await click(tab(name)); await waitFor(`${tab(name)}.getAttribute('aria-selected')==='true'`) }
async function frame(width, theme, state) {
  await painted()
  const file = `${theme}-${width}-${state}.png`, png = (await win.webContents.capturePage()).toPNG()
  assert.ok(png.length > 0); await fs.writeFile(path.join(evidence, file), png)
  result.frames.push({ width, theme, state, file, sha256: createHash('sha256').update(png).digest('hex') })
}
function densityCheck(condition, code, actual, expected) {
  try { assert.ok(condition, `${code}: ${JSON.stringify(actual)}; expected ${expected}`) }
  catch (error) { error.density = { code, actual, expected }; throw error }
}
async function densityOracle({ secondary = false, search = false, coarse = false, record = true } = {}) {
  const actual = await evaluate(`(()=>{
    const p=${panel},content=p.querySelector('.composer-mailbox__content'),bounds=content.getBoundingClientRect();
    const displayed=n=>!n.closest('[hidden]')&&n.getBoundingClientRect().height>0;
    const sizes=selector=>[...p.querySelectorAll(selector)].filter(displayed).map(n=>({height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width}));
    const records=[...p.querySelectorAll('.composer-mailbox__record')].filter(displayed).filter(n=>{const r=n.getBoundingClientRect();return r.top>=bounds.top&&r.bottom<=bounds.bottom&&r.left>=bounds.left&&r.right<=bounds.right&&n.querySelector('[data-record-key]')?.textContent.trim()});
    return{pointer:matchMedia('(pointer: coarse)').matches?'coarse':matchMedia('(pointer: fine)').matches?'fine':'none',
      primary:sizes('.composer-mailbox__folders:not(.composer-mailbox__folders--secondary) > button'),secondary:sizes('.composer-mailbox__folders--secondary > button'),
      search:sizes('.input-history__search > input, .input-history__search > button'),automation:sizes('.composer-mailbox__automation'),actions:sizes('.composer-mailbox__record-actions > button'),
      bodyToken:parseFloat(getComputedStyle(${surface}).getPropertyValue('--fs-body')),bodySizes:[...p.querySelectorAll('.composer-mailbox__preview, .log-turn__body')].filter(displayed).map(n=>parseFloat(getComputedStyle(n).fontSize)),
      fullyVisibleRecords:records.map(n=>n.querySelector('[data-record-key]').dataset.recordKey)}
  })()`)
  assert.equal(actual.pointer, coarse ? 'coarse' : 'fine', 'The density check uses the actual pointer media')
  assert.equal(actual.primary.length, 3, 'The density check consumes all primary navigation controls')
  if (secondary) assert.ok(actual.secondary.length >= 2, 'The secondary navigation is actually mounted')
  if (search) assert.equal(actual.search.length, 3, 'The original query input, submit and refresh controls are mounted')
  assert.equal(actual.automation.length, 1, 'The original Automation entry remains mounted')
  if (coarse) {
    densityCheck([...actual.primary, ...actual.secondary].every(size => size.height >= 44), 'COARSE_NAV_TARGET', [...actual.primary, ...actual.secondary], 'height >= 44px')
    assert.ok(actual.actions.length > 0, 'The coarse check consumes real record actions')
    densityCheck(actual.actions.every(size => size.height >= 44 && size.width >= 44), 'COARSE_ACTION_TARGET', actual.actions, 'width and height >= 44px')
  } else {
    densityCheck(actual.primary.every(size => size.height <= 28), 'PRIMARY_NAV_HEIGHT', actual.primary.map(size => size.height), '<= 28px')
    densityCheck(actual.secondary.every(size => size.height <= 28), 'SECONDARY_NAV_HEIGHT', actual.secondary.map(size => size.height), '<= 28px')
    densityCheck(actual.search.every(size => size.height >= 24 && size.height <= 28), 'SEARCH_HEIGHT', actual.search.map(size => size.height), '24–28px')
    densityCheck(actual.automation[0].height <= 30, 'AUTOMATION_HEIGHT', actual.automation[0].height, '<= 30px')
  }
  assert.equal(actual.bodyToken, 12, 'The shared body text token remains unchanged')
  assert.ok(actual.bodySizes.length > 0, 'Real message bodies are present for font measurement')
  densityCheck(actual.bodySizes.every(size => size === actual.bodyToken), 'MESSAGE_BODY_FONT', actual.bodySizes, 'the shared fs-body token')
  if (record) assert.ok(actual.fullyVisibleRecords.length > 0, 'At least one complete original record is visible without scrolling')
  return actual
}
async function layout(options) {
  const actual = await evaluate(`(()=>{const p=${panel},r=p.getBoundingClientRect();return{width:p.clientWidth,scroll:p.scrollWidth,top:r.top,bottom:r.bottom,tabs:[...p.querySelectorAll('[role="tab"]')].filter(n=>!n.closest('[hidden]')).map(n=>{const l=n.querySelector('.composer-mailbox__folder-label')??n,b=n.getBoundingClientRect();return{label:l.textContent,complete:l.scrollWidth<=l.clientWidth+1,left:b.left,right:b.right,top:b.top,inside:b.left>=r.left-1&&b.right<=r.right+1}})}})()`)
  assert.ok(actual.scroll <= actual.width + 1, 'The actual mailbox has no horizontal overflow')
  assert.ok(actual.top >= 0 && actual.bottom <= await evaluate('innerHeight'), 'The original mailbox stays inside the viewport')
  assert.ok(actual.tabs.length >= 3 && actual.tabs.every(item => item.complete && item.inside), 'All visible navigation labels remain complete and contained')
  assert.deepEqual(actual.tabs.slice(0, 3).map(item => item.label), ['Inputs', 'Agent messages', 'Notices'])
  assert.equal(new Set(actual.tabs.slice(0, 3).map(item => Math.round(item.top))).size, 1, 'Primary navigation keeps one readable row')
  return { ...actual, density: await densityOracle(options) }
}
async function rowAffordances() {
  assert.equal(await evaluate("matchMedia('(hover: hover) and (pointer: fine)').matches"), true, 'The real desktop hover rules are active')
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  await painted()
  const send = await evaluate(`(()=>{const n=${visiblePanel}.querySelector('.composer-outbox__send'),row=n?.closest('.composer-mailbox__record'),footer=n?.closest('.composer-mailbox__record-footer');if(!n||!row||!footer)throw new Error('The original pending Send action is missing');const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2),style=getComputedStyle(footer);return{hovered:row.matches(':hover'),focused:row.matches(':focus-within'),opacity:style.opacity,pointerEvents:style.pointerEvents,visible:getComputedStyle(n).visibility,enabled:!n.disabled,hit:n===hit||n.contains(hit)}})()`)
  assert.equal(send.hovered, false); assert.equal(send.focused, false)
  assert.equal(send.opacity, '1', 'The resting pending footer remains fully visible')
  assert.equal(send.pointerEvents, 'auto'); assert.equal(send.visible, 'visible')
  assert.equal(send.enabled, true); assert.equal(send.hit, true, 'Send remains hit-testable without hover or dispatch')
  const plain = `${visiblePanel}.querySelector('.composer-mailbox__record:not(:has(.composer-mailbox__record-actions, .composer-mailbox__record-status)):has(time)')`
  await waitFor(visible(plain))
  await evaluate(`${plain}.scrollIntoView({block:'nearest'})`)
  const point = await evaluate(`(()=>{const r=${plain}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await painted()
  const metadata = await evaluate(`(()=>{const row=${plain},n=row.querySelector('.composer-mailbox__metadata'),time=n.querySelector('time'),r=time.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{hovered:row.matches(':hover'),visibility:getComputedStyle(n).visibility,opacity:getComputedStyle(n).opacity,text:time.textContent,hit:time===hit||time.contains(hit)}})()`)
  assert.equal(metadata.hovered, true, 'The plain record receives a real pointer hover')
  assert.ok(metadata.text); assert.equal(metadata.visibility, 'visible'); assert.equal(metadata.opacity, '1')
  assert.equal(metadata.hit, true, 'A row without actions keeps its visible time while hovered')
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  await evaluate(`${panel}.querySelector('.composer-mailbox__content').scrollTop=0`)
  await painted()
  return { send, metadata }
}
async function originalSurfacePreserved(original, before) {
  const after = await evaluate('({terminal:messageWorkspace.terminal(),facts:messageWorkspace.facts(),sameEditor:window.workspaceEditor===' + editor + '})')
  assert.equal(after.sameEditor, true, 'Reading keeps the original composer editor')
  assert.equal(after.facts.drafts[original.agentSessionId], original.draft)
  assert.deepEqual(after.facts.queues, before.facts.queues, 'Reading never dispatches or reorders pending inputs')
  assert.deepEqual(after.terminal, before.terminal, 'The original terminal instance and geometry remain unchanged')
  assert.equal(after.facts.calls.filter(item => /dispatch|automation-/.test(item.action)).length, 0)
}
async function emptyOracle(hinted) {
  const actual = await evaluate(`(()=>{
    const p=${panel},n=${visiblePanel}.querySelector('.composer-mailbox__empty'),title=n.querySelector('strong'),hint=n.querySelector('p'),icon=n.querySelector('svg');
    const r=n.getBoundingClientRect(),pr=p.getBoundingClientRect(),tr=title.getBoundingClientRect(),ir=icon.getBoundingClientRect();
    const hs=hint&&getComputedStyle(hint),hr=hint&&hint.getBoundingClientRect(),range=hint&&document.createRange();if(range)range.selectNodeContents(hint);
    return{height:r.height,title:title.textContent,titleFont:parseFloat(getComputedStyle(title).fontSize),titleHeight:tr.height,iconHeight:ir.height,
      inline:Math.abs(tr.top-ir.top)<=2&&ir.right<=tr.left,contentHeight:p.querySelector('.composer-mailbox__content').getBoundingClientRect().height,
      inside:pr.top>=0&&pr.bottom<=innerHeight&&p.scrollWidth<=p.clientWidth+1,
      hint:hint?{text:hint.textContent,height:hr.height,font:parseFloat(hs.fontSize),lineHeight:parseFloat(hs.lineHeight),lines:new Set([...range.getClientRects()].map(r=>r.top)).size,
        complete:hint.scrollHeight<=hint.clientHeight+1&&hint.scrollWidth<=hint.clientWidth+1&&hr.left>=r.left&&hr.right<=r.right&&hr.bottom<=r.bottom,
        whiteSpace:hs.whiteSpace,clamp:hs.webkitLineClamp}:null}
  })()`)
  assert.equal(actual.titleFont, 12); assert.equal(actual.titleHeight, 18); assert.equal(actual.iconHeight, 16)
  assert.equal(actual.inline, true, 'The icon and original-size title share the first row')
  assert.equal(actual.inside, true, 'The content-sized mailbox stays contained')
  densityCheck(Math.abs(actual.height - (26 + (hinted ? 2 + actual.hint.height : 0))) < 0.5,
    'EMPTY_STATE_HEIGHT', actual.height, hinted ? '26px plus a 2px gap and the complete hint' : '26px')
  if (hinted) {
    assert.equal(actual.title, 'No supervised collaboration recorded')
    assert.equal(actual.hint.text, 'This does not describe other Agent messages or execution status.')
    assert.equal(actual.hint.font, 11); assert.equal(actual.hint.complete, true)
    assert.equal(actual.hint.whiteSpace, 'normal'); assert.equal(actual.hint.clamp, 'none')
    assert.ok(actual.hint.lines >= 1 && Math.abs(actual.hint.height - actual.hint.lines * actual.hint.lineHeight) < 0.5, 'The complete original hint wraps into natural text lines')
  } else {
    assert.equal(actual.title, 'No current notices'); assert.equal(actual.hint, null)
    assert.equal(actual.contentHeight, actual.height, 'A plain empty view reserves no unused reading height')
  }
  return actual
}
async function emptyStates(width, theme, original, before, geometry) {
  result.stage.action = 'empty-notices'
  await choose('Notices')
  await waitFor(`${visiblePanel}.querySelector('.composer-mailbox__empty strong')?.textContent==='No current notices'`)
  const notices = await emptyOracle(false)
  const automation = await evaluate(`(()=>{const n=${buttons('Automation')},icon=n.querySelector('svg'),r=icon.getBoundingClientRect(),href=icon.querySelector('use').getAttribute('href'),symbol=document.getElementById(href.slice(1)),box=icon.getBBox();return{semantic:icon.dataset.semanticIcon,width:r.width,height:r.height,entryHeight:n.getBoundingClientRect().height,hidden:icon.getAttribute('aria-hidden'),status:document.getElementById(n.getAttribute('aria-describedby')).textContent,shapes:symbol?.querySelectorAll('path,rect').length??0,drawing:{width:box.width,height:box.height},animation:getComputedStyle(icon).animationName,motion:Boolean(n.querySelector('[data-icon-animation]'))}})()`)
  assert.equal(automation.semantic, 'object.automation'); assert.equal(automation.width, 14); assert.equal(automation.height, 14)
  assert.equal(automation.entryHeight, 28); assert.equal(automation.hidden, 'true'); assert.ok(automation.status)
  assert.ok(automation.shapes > 0 && automation.drawing.width > 0 && automation.drawing.height > 0, 'The original theme sprite supplies actual Automation geometry')
  assert.equal(automation.animation, 'none'); assert.equal(automation.motion, false)
  await frame(width, theme, 'empty-notices')
  result.stage.action = 'empty-collaboration'
  await choose('Agent messages'); await choose('Collaboration')
  await waitFor(`${visiblePanel}.querySelector('.composer-mailbox__empty p')`)
  const collaboration = await emptyOracle(true)
  if (width === 320) assert.ok(collaboration.hint.lines > 1, 'The original necessary hint wraps at the narrow width')
  assert.ok((await evaluate('messageWorkspace.facts().calls')).some(call => call.action === 'collaboration-page' &&
    call.reference.hostId === original.hostId && call.reference.agentSessionId === original.agentSessionId), 'The original collaboration reader consumed the exact empty page')
  await frame(width, theme, 'empty-collaboration')
  await click(buttons('Automation'))
  assert.equal(await evaluate(`document.activeElement===${buttons('Back to messages')}`), true)
  await click(buttons('Back to messages'))
  assert.equal(await evaluate(`${tab('Collaboration')}.getAttribute('aria-selected')`), 'true')
  assert.equal(await evaluate(`document.activeElement===${buttons('Automation')}`), true)
  assert.deepEqual(await emptyOracle(true), collaboration)
  await key('Escape', 'Escape', 27)
  await waitFor(`!${panel}.matches(':popover-open')`)
  assert.equal(await evaluate(`document.activeElement===${surface}.querySelector('.composer__mailbox')`), true)
  await originalSurfacePreserved(original, before)
  result.scenes.push({ width, theme, geometry, notices, collaboration, automation, automationReturn: true, keyboardClose: true, originalSurfacePreserved: true })
}
async function progressActionsScene(width, theme, short, original, before) {
  const suffix = short ? '-short' : ''
  const automation = `${panel}.querySelector('[aria-label="Automation settings"]')`
  const progress = `${automation}.querySelector('.continuous-progress-panel')`
  const resume = `${progress}.querySelector('[aria-label="Resume and check continuous progress"]')`
  const check = `${progress}.querySelector('[aria-label="Check continuous progress now"]')`
  await click(buttons('Automation'))
  await waitFor(`${automation}.querySelector('[data-progress-details="interval"]')`)
  await click(`${automation}.querySelector('[data-progress-details="interval"] > summary')`)
  await waitFor(visible(resume))
  assert.equal(await evaluate(`${resume}.textContent.trim()`), 'Resume and check')
  assert.equal(await evaluate(`${check}===null`), true, 'A paused loop offers resume-and-check instead of a disabled check')
  await frame(width, theme, 'progress-paused' + suffix)
  await click(resume)
  await waitFor(`${progress}.getAttribute('aria-busy')==='true'&&${progress}.textContent.includes('Resuming and checking this Agent')`)
  assert.equal(await evaluate(`[...${progress}.querySelectorAll('button')].length===2&&[...${progress}.querySelectorAll('button')].every(button=>button.disabled)`), true)
  const calls = await evaluate(`messageWorkspace.facts().calls.filter(call=>call.action==='fixture-progress-action')`)
  assert.equal(calls.length, 1); assert.equal(calls[0].query.action, 'resume'); assert.equal(calls[0].reference.agentSessionId, original.agentSessionId)
  assert.equal(calls[0].query.loopId, 'visual-progress')
  await frame(width, theme, 'progress-checking' + suffix)
  await evaluate(`messageWorkspace.settleProgressAction('skipped')`)
  await waitFor(`${progress}.getAttribute('aria-busy')==='false'&&${progress}.textContent.includes('Check complete. No continuation prompt was sent.')`)
  await waitFor(visible(check))
  assert.equal(await evaluate(`${progress}.textContent.includes('The Agent is still working.')&&!${check}.disabled`), true)
  await frame(width, theme, 'progress-skipped' + suffix)
  await click(check)
  await waitFor(`${progress}.textContent.includes('Checking this Agent')`)
  await evaluate(`messageWorkspace.settleProgressAction('failure')`)
  await waitFor(`${progress}.querySelector('[role="status"]')?.textContent.includes('The original check could not be confirmed.')`)
  await evaluate(`document.dispatchEvent(new Event('visibilitychange'))`); await painted()
  assert.equal(await evaluate(`${progress}.querySelector('[role="status"]').textContent.includes('The original check could not be confirmed.')`), true, 'A successful list observation does not erase this original action error')
  const finalCalls = await evaluate(`messageWorkspace.facts().calls.filter(call=>call.action==='fixture-progress-action')`)
  assert.equal(finalCalls.length, 2); assert.equal(finalCalls[1].query.action, 'check'); assert.notEqual(finalCalls[0].query.operationId, finalCalls[1].query.operationId)
  await frame(width, theme, 'progress-error' + suffix)
  const bounds = await evaluate(`(()=>{const r=${panel}.getBoundingClientRect();return{top:r.top,bottom:r.bottom,width:${panel}.clientWidth,scroll:${panel}.scrollWidth}})()`)
  assert.ok(bounds.top>=0&&bounds.bottom<=await evaluate('innerHeight')&&bounds.scroll<=bounds.width+1)
  await key('Escape', 'Escape', 27)
  await originalSurfacePreserved(original, before)
  result.scenes.push({ width, theme, short, originalSurfacePreserved: true, pausedAction: true, pendingFeedback: true, skippedFeedback: true, retainedActionError: true, exactOriginalActions: finalCalls })
}

async function automationScene(width, theme, short, original, before) {
  const suffix = short ? '-short' : ''
  const automation = `${panel}.querySelector('[aria-label="Automation settings"]')`
  await click(buttons('Automation'))
  await waitFor(`${automation} && !${automation}.hidden && ${automation}.querySelector('[data-schedule-id="private-minute-arrangement"]') && ${automation}.querySelector('[data-progress-details="interval"]')`)
  const bounds = await evaluate(`(()=>{const p=${panel},r=p.getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:p.clientWidth,scroll:p.scrollWidth}})()`)
  assert.ok(bounds.top >= 0 && bounds.bottom <= await evaluate('innerHeight') && bounds.scroll <= bounds.width + 1, 'The real Automation popover remains within its workface')
  await frame(width, theme, 'automation-list' + suffix)
  await click(`${automation}.querySelector('[data-progress-details="interval"] > summary')`)
  const resume = `${automation}.querySelector('[aria-label="Resume and check continuous progress"]')`
  await waitFor(visible(resume))
  await evaluate(`${resume}.scrollIntoView({block:'nearest'})`); await painted()
  const control = await evaluate(`(()=>{const n=${resume},p=${panel},r=n.getBoundingClientRect(),b=p.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {enabled:!n.disabled,inside:r.top>=b.top&&r.bottom<=b.bottom&&r.left>=b.left&&r.right<=b.right,hit:n===hit||n.contains(hit)}})()`)
  assert.deepEqual(control, { enabled: true, inside: true, hit: true }, 'The original paused-loop action is visible and hit-testable without activating it')
  await frame(width, theme, 'automation-controls' + suffix)
  const overview = `${automation}.querySelector('[data-automation-view="overview"]')`
  const editView = `${automation}.querySelector('[data-automation-view="editor"]')`
  await evaluate(`(()=>{window.automationMotion=[];${automation}.addEventListener('animationstart',event=>{if(${editView}.contains(event.target))window.automationMotion.push({name:event.animationName,duration:getComputedStyle(event.target).animationDuration})})})()`)
  await click(buttons('Edit continuous progress', automation))
  assert.equal(await evaluate(`${overview}.hidden&&!${editView}.hidden`), true, 'The editor replaces the overview without removing either retained form')
  assert.equal(await evaluate(`(()=>{const chooser=${automation}.querySelector('[aria-label="Automation type"]');return !chooser||!!chooser.closest('[hidden]')})()`), true, 'Editing an existing task does not ask the user to select its type again')
  const motion = await evaluate('window.automationMotion')
  assert.ok(motion.length > 0 && motion.some(item => parseFloat(item.duration) > 0), 'Opening the actual editor produces a short animation')
  const progressForm = `${automation}.querySelector('form[aria-label="Continuous progress setup"]')`
  const progressInterval = `${progressForm}.querySelector('input[type="number"]')`
  const progressPrompt = `${progressForm}.querySelector('textarea')`
  await waitFor(visible(progressInterval))
  const sourceVisibility = await evaluate(`(()=>{const n=${progressForm}.querySelector('[aria-label="Optional task source"]');return {hidden:n.hidden,display:getComputedStyle(n).display}})()`)
  assert.deepEqual(sourceVisibility, { hidden: true, display: 'none' }, 'Editing the original loop does not falsely show an unbound task source')
  assert.equal(await evaluate(`${progressInterval}.value`), '30', 'The exact saved interval is prefilled')
  assert.equal(await evaluate(`${progressPrompt}.value`), Array.from({ length: 12 }, (_, index) => `Saved continuation line ${index + 1}: keep the original user input and finish the assigned task.`).join('\n'), 'The original complete saved prompt is prefilled')
  await evaluate(`${progressInterval}.scrollIntoView({block:'nearest'})`); await frame(width, theme, 'automation-progress-edit' + suffix)
  await replace(progressInterval, '60'); await replace(progressPrompt, '检查新版本并报告真实进展。')
  const saveProgress = `${progressForm}.querySelector('button[type="submit"]')`
  await waitFor(`${saveProgress}?.textContent==='Save changes' && !${saveProgress}.disabled`)
  await click(saveProgress)
  await waitFor(`${progressForm}.textContent.includes('Changes saved.')`)
  const progressResult = await evaluate(`(()=>{const d=${automation}.querySelector('[data-progress-details="interval"]');return {text:d.textContent, calls:messageWorkspace.facts().calls.filter(item=>item.action==='fixture-progress-update')}})()`)
  assert.equal(progressResult.calls.length, 1, 'Exactly one private update is issued')
  assert.equal(progressResult.calls[0].query.intervalMs, 3600000); assert.equal(progressResult.calls[0].query.prompt, '检查新版本并报告真实进展。')
  assert.equal(progressResult.calls[0].query.loopId, 'visual-progress'); assert.equal(progressResult.calls[0].reference.agentSessionId, original.agentSessionId)
  assert.match(progressResult.text, /Paused/); assert.match(progressResult.text, /Every 60 min/)
  await frame(width, theme, 'automation-progress-saved' + suffix)
  await click(buttons('Back to automations', automation))
  assert.equal(await evaluate(`document.activeElement===${buttons('Edit continuous progress', automation)}&&!${overview}.hidden&&${editView}.hidden`), true, 'Back returns keyboard focus to the exact edit entry')
  await click(buttons('New automation', automation))
  const timing = value => `${automation}.querySelector('[aria-label="Arrangement timing"] input[value="${value}"]')`
  assert.deepEqual(await evaluate(`[...${automation}.querySelectorAll('[aria-label="Arrangement timing"] input')].map(n=>n.value)`), ['everyMs','calendar','afterMs'])
  const interval = `${automation}.querySelector('[aria-label="Repeat interval in minutes"]' )`
  const message = `${automation}.querySelector('[aria-label="Arranged message"]')`
  await waitFor(visible(interval)); await replace(interval, '7'); await replace(message, '请检查当前任务，保留原会话。')
  await evaluate(`window.automationInterval=${interval};window.automationMessage=${message}`)
  await frame(width, theme, 'automation-minute-form' + suffix)
  const save = `${automation}.querySelector('.schedule-create[data-embedded] button[type="submit"]')`
  await waitFor(visible(save)); await evaluate(`${save}.scrollIntoView({block:'nearest'})`); await painted()
  const saveControl = await evaluate(`(()=>{const n=${save},p=${panel},r=n.getBoundingClientRect(),b=p.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {enabled:!n.disabled,inside:r.top>=b.top&&r.bottom<=b.bottom&&r.left>=b.left&&r.right<=b.right,hit:n===hit||n.contains(hit)}})()`)
  assert.deepEqual(saveControl, { enabled: true, inside: true, hit: true }, 'The unsent minute-form save is visible and hit-testable without activating it')
  await frame(width, theme, 'automation-save' + suffix)
  // Native radio keys choose the time model without a select popup or direct value mutation.
  await click(`${timing('everyMs')}.closest('label')`)
  await key('ArrowRight', 'ArrowRight', 39)
  await waitFor(`${timing('calendar')}.checked`)
  assert.equal(await evaluate(visible(`${automation}.querySelector('[aria-label="Arrangement local time"]')`)), true)
  await frame(width, theme, 'automation-calendar-form' + suffix)
  await key('ArrowRight', 'ArrowRight', 39)
  await waitFor(`${timing('afterMs')}.checked`)
  assert.equal(await evaluate(visible(`${automation}.querySelector('[aria-label="Countdown duration"]')`)), true)
  await frame(width, theme, 'automation-countdown-form' + suffix)
  await click(`${timing('everyMs')}.closest('label')`)
  // The time-specific field may remount; the message editor is the retained user draft.
  await evaluate(`window.automationInterval=${interval}`)
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await evaluate('window.automationMotion=[]')
  await click(buttons('Back to automations', automation))
  assert.equal(await evaluate(`document.activeElement===${buttons('New automation', automation)}&&!${overview}.hidden`), true, 'Back restores the original new-task entry')
  await click(buttons('New automation', automation))
  assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches&&window.automationMotion.length===0&&${message}===window.automationMessage`), true, 'Reduced motion keeps the same editor and draft without replaying entrance animation')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
  await click(buttons('Back to messages')); await click(buttons('Automation'))
  assert.equal(await evaluate(`window.automationInterval===${interval}&&${interval}.value==='7'&&window.automationMessage===${message}&&${message}.value==='请检查当前任务，保留原会话。'`), true, 'Navigation retains the exact form nodes and unsent automation draft')
  await click(buttons('Back to automations', automation))
  assert.equal(await evaluate(`document.activeElement===${buttons('New automation', automation)}&&!${overview}.hidden&&${editView}.hidden`), true, 'Reopening Automation returns to the current entry, not a disconnected prior DOM node')
  await click(buttons('New automation', automation))
  assert.equal(await evaluate(`${message}===window.automationMessage&&${message}.value==='请检查当前任务，保留原会话。'`), true)
  await key('Escape', 'Escape', 27); await waitFor(`!${panel}.matches(':popover-open')`)
  assert.equal(await evaluate(`document.activeElement===${surface}.querySelector('.composer__mailbox')`), true)
  await originalSurfacePreserved(original, before)
  result.scenes.push({ width, theme, short, controlsReachable: true, retainedAutomation: true, isolatedEditor: true, returnFocus: true, timingChoices: ['everyMs', 'calendar', 'afterMs'], motion, reducedMotion: true, originalSurfacePreserved: true })
}
async function interactionStates(width, theme, original, before, geometry) {
  result.stage.action = 'ordinary-record-hover'
  const ordinary = `${visiblePanel}.querySelector('.composer-mailbox__record:has(.composer-mailbox__record-actions):not(:has(.composer-mailbox__record-status, .composer-outbox__send, [role="status"]))')`
  await waitFor(visible(ordinary))
  await evaluate(`${ordinary}.scrollIntoView({block:'nearest'})`)
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  await painted()
  const resting = await evaluate(`(()=>{const row=${ordinary},footer=row.querySelector('.composer-mailbox__record-footer');return{key:row.querySelector('[data-record-key]').dataset.recordKey,hovered:row.matches(':hover'),focused:row.matches(':focus-within'),opacity:getComputedStyle(footer).opacity,pointerEvents:getComputedStyle(footer).pointerEvents}})()`)
  assert.equal(resting.hovered, false); assert.equal(resting.focused, false)
  assert.equal(resting.opacity, '0'); assert.equal(resting.pointerEvents, 'none')
  const point = await evaluate(`(()=>{const r=${ordinary}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await painted()
  const hover = await evaluate(`(()=>{const row=${ordinary},footer=row.querySelector('.composer-mailbox__record-footer');return{hovered:row.matches(':hover'),opacity:getComputedStyle(footer).opacity,pointerEvents:getComputedStyle(footer).pointerEvents,actions:[...footer.querySelectorAll('button')].map(n=>{const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{label:n.getAttribute('aria-label'),enabled:!n.disabled,hit:n===hit||n.contains(hit)}})}})()`)
  assert.equal(hover.hovered, true); assert.equal(hover.opacity, '1'); assert.equal(hover.pointerEvents, 'auto')
  assert.ok(hover.actions.length > 0 && hover.actions.every(action => action.enabled && action.hit), 'The original secondary actions appear and are hit-testable on real pointer hover')
  await frame(width, theme, 'record-hover')

  result.stage.action = 'search-keyboard-focus'
  await click(query)
  assert.equal(await evaluate(`document.activeElement===${query}`), true)
  await key('Tab', 'Tab', 9)
  const submit = `${query}.closest('form').querySelector('button[type="submit"]')`
  const focus = await evaluate(`(()=>{const n=${submit},style=getComputedStyle(n),r=n.getBoundingClientRect();return{active:document.activeElement===n,visible:n.matches(':focus-visible'),outlineStyle:style.outlineStyle,outlineWidth:parseFloat(style.outlineWidth),outlineColor:style.outlineColor,height:r.height,label:n.getAttribute('aria-label'),query:${query}.value}})()`)
  assert.equal(focus.active, true, 'A real Tab moves from the query input to its original search button')
  assert.equal(focus.visible, true); assert.notEqual(focus.outlineStyle, 'none'); assert.ok(focus.outlineWidth > 0)
  assert.ok(focus.height >= 24 && focus.height <= 28); assert.equal(focus.query, '')
  await frame(width, theme, 'search-focus')
  await key('Escape', 'Escape', 27)
  await waitFor(`!${panel}.matches(':popover-open')`)
  await originalSurfacePreserved(original, before)
  result.scenes.push({ width, theme, geometry, resting, hover, focus, originalSurfacePreserved: true })
}
async function manualNotification(width, theme, original, before) {
  await choose('Agent messages'); await choose('Received')
  await waitFor(`${visiblePanel}.querySelectorAll('button[data-record-key^="a2a:"]').length===25`)
  const selected = `${visiblePanel}.querySelector('.composer-mailbox__record:has([data-mailbox-notification-action="notify"])')`
  const mid = await evaluate(`${selected}.querySelector('[data-record-key]').dataset.recordKey.slice(4)`)
  const target = `${selected}.querySelector('[data-mailbox-notification-action="notify"]')`
  await evaluate(`${selected}.scrollIntoView({block:'nearest'})`)
  await frame(width, theme, 'notify-list')
  await click(target)
  await waitFor(`${visiblePanel}.querySelector('[data-notification-operation]')`)
  const operationId = await evaluate(`${visiblePanel}.querySelector('[data-notification-operation]').dataset.notificationOperation`)
  const calls = await evaluate('messageWorkspace.facts().calls')
  assert.deepEqual(calls.filter(call=>call.action==='notify-reference').map(call=>[call.reference,call.query]),
    [[{hostId:original.hostId,agentSessionId:original.agentSessionId},{messageId:mid,operationId}]])
  assert.equal(await evaluate(`${selected}.textContent.includes('This notification: unconfirmed')`), true)
  await frame(width, theme, 'notify-unconfirmed')
  await click(`${selected}.querySelector('[data-record-key]')`)
  await waitFor(`${visiblePanel}.querySelector('.log-turn__body')`)
  assert.equal(await evaluate(`${visiblePanel}.querySelector('[data-notification-operation]').dataset.notificationOperation`), operationId)
  await click(buttons('Refresh receipt'))
  await waitFor(`${visiblePanel}.querySelector('[data-notification-operation] summary').textContent==='This notification: submitted'`)
  assert.equal((await evaluate('messageWorkspace.facts().calls')).filter(call=>call.action==='notify-reference').length, 1)
  assert.equal((await evaluate('messageWorkspace.facts().calls')).filter(call=>call.action==='inspect-notification').length, 1)
  await frame(width, theme, 'notify-detail')
  await key('Escape', 'Escape', 27)
  await originalSurfacePreserved(original, before)
  result.scenes.push({width,theme,mid,operationId,explicitNotification:true,observationOnlyRefresh:true,originalSurfacePreserved:true})
}
async function notificationRecovery(width, theme, original, before) {
  await choose('Agent messages'); await choose('Received')
  await waitFor(`${visiblePanel}.querySelectorAll('button[data-record-key^="a2a:"]').length===25`)
  const selected = `${visiblePanel}.querySelector('.composer-mailbox__record:has([data-mailbox-notification-action="notify"])')`
  const mid = await evaluate(`${selected}.querySelector('[data-record-key]').dataset.recordKey.slice(4)`)
  await evaluate(`${selected}.scrollIntoView({block:'nearest'})`)
  await layout({ secondary: true });
  await frame(width, theme, 'recovery-list')
  await click(`${selected}.querySelector('[data-mailbox-notification-action="notify"]')`)
  await waitFor(`${selected}.textContent.includes('This notification: unconfirmed')`)
  const operation = await evaluate(`${selected}.querySelector('[data-notification-operation]').dataset.notificationOperation`)
  assert.equal(await evaluate(`${selected}.querySelector('[data-mailbox-notification-action="notify"]').textContent.includes('Notify again')`), true)
  await layout({ secondary: true });
  await frame(width, theme, 'recovery-unconfirmed')
  await key('Escape', 'Escape', 27)
  await waitFor(`!${panel}.matches(':popover-open')`)
  assert.equal(await evaluate(`document.activeElement===${surface}.querySelector('.composer__mailbox')`), true)
  await key('Enter', 'Enter', 13); await waitFor(`${panel}.matches(':popover-open')`)
  await choose('Agent messages'); await choose('Received')
  await click(`${visiblePanel}.querySelector('[data-record-key="a2a:${mid}"]')`)
  await waitFor(`${visiblePanel}.querySelector('.log-turn__body')`)
  assert.equal(await evaluate(`${visiblePanel}.querySelector('[data-notification-operation]').dataset.notificationOperation`), operation)
  await click(`${visiblePanel}.querySelector('[data-mailbox-notification-action="notify"]')`)
  await waitFor(`${visiblePanel}.querySelectorAll('[data-notification-operation]').length===2`)
  const current = await evaluate(`${visiblePanel}.querySelector('[data-notification-operation]').dataset.notificationOperation`)
  assert.notEqual(current, operation)
  const history = `([...${visiblePanel}.querySelectorAll('summary')].find(n=>n.textContent.includes('Other notification attempts')))`
  const latestSummary=`${visiblePanel}.querySelector('[data-notification-operation] > .composer-mailbox__notification-feedback > details > summary')`
  await click(latestSummary)
  await click(history)
  const previous = `${visiblePanel}.querySelector('[data-notification-operation="${operation}"]')`
  assert.equal(await evaluate(`${previous}.textContent.includes('unconfirmed')`), true)
  await frame(width, theme, 'recovery-history')
  const inspect = `${previous}.querySelector('[data-mailbox-notification-action="inspect"]')`
  let reached = false
  for (let index=0;index<40;index++) {
    await key('Tab','Tab',9)
    if (await evaluate(`document.activeElement===${inspect}`)) { reached=true;break }
  }
  assert.equal(reached,true,'Original receipt is reachable with actual Tab navigation')
  assert.equal(await evaluate(`${inspect}.matches(':focus-visible')`),true)
  await key('Enter','Enter',13)
  await waitFor(`${previous}.textContent.includes('submitted')`)
  const calls=await evaluate('messageWorkspace.facts().calls')
  assert.equal(calls.filter(call=>call.action==='notify-reference').length,2)
  assert.equal(calls.filter(call=>call.action==='inspect-notification').length,1)
  assert.equal(calls.find(call=>call.action==='inspect-notification').query.operationId,operation)
  await frame(width, theme, 'recovery-checked')
  await click(buttons('Back to Received')); await choose('Sent')
  await waitFor(`${visiblePanel}.querySelector('[data-mailbox-notification-action="notify"]')`)
  const sentRow=`${visiblePanel}.querySelector('.composer-mailbox__record:has([data-mailbox-notification-action="notify"])')`
  const sentMid=await evaluate(`${sentRow}.querySelector('[data-record-key]').dataset.recordKey.slice(4)`)
  const sentOriginal=await evaluate(`messageWorkspace.originalMessage(${JSON.stringify(sentMid)})`)
  await click(`${sentRow}.querySelector('[data-record-key]')`)
  await waitFor(`${visiblePanel}.querySelector('.log-turn__body')`)
  const label=await evaluate(`${visiblePanel}.querySelector('[data-mailbox-notification-action="notify"]').getAttribute('aria-label')`)
  const title=await evaluate(`${visiblePanel}.querySelector('[data-mailbox-notification-action="notify"]').title`)
  assert.ok(label.includes(':'),'Sent notification names the recipient')
  assert.ok(title.includes(original.hostId),'Sent notification keeps its exact Host')
  assert.ok(title.includes(sentOriginal.message.envelope.recipientSessionId),'Sent notification names its original recipient ID')
  assert.notEqual(sentOriginal.message.envelope.recipientSessionId,original.agentSessionId)
  const sentLayout=await evaluate(`(()=>{const p=${visiblePanel},title=p.querySelector('.log-turn__title').getBoundingClientRect(),actions=p.querySelector('.log-turn__actions').getBoundingClientRect();return{titleBottom:title.bottom,actionsTop:actions.top}})()`)
  assert.ok(sentLayout.actionsTop>=sentLayout.titleBottom-1,'Notification actions use their own row and retain the original author width')
  await frame(width,theme,'recovery-sent')
  await key('Escape','Escape',27)
  await originalSurfacePreserved(original,before)
  let reloadedIdentity = false
  if (width===640) {
    const loaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve))
    win.webContents.reload(); await loaded
    await waitFor('Boolean(window.messageWorkspace)')
    assert.equal((await evaluate('messageWorkspace.facts().calls')).filter(call=>call.action==='notify-reference').length,0)
    await evaluate(`messageWorkspace.restore(${JSON.stringify(theme)},${JSON.stringify(theme+'-'+width)})`)
    await waitFor(`${surface}?.querySelector('.xterm')`)
    await click(`${surface}.querySelector('.composer__mailbox')`); await waitFor(`${panel}.matches(':popover-open')`)
    await choose('Agent messages'); await choose('Received')
    await click(`${visiblePanel}.querySelector('[data-record-key="a2a:${mid}"]')`)
    await waitFor(`${visiblePanel}.querySelector('[data-notification-operation="${operation}"]')`)
    assert.ok(await evaluate(`${visiblePanel}.querySelector('[data-notification-operation="${current}"]')!==null`),'Reload retains both original operations')
    assert.equal((await evaluate('messageWorkspace.facts().calls')).filter(call=>call.action==='notify-reference').length,0,'Reload does not replay')
    reloadedIdentity=true
    await key('Escape','Escape',27)
  }
  result.scenes.push({width,theme,mid,operationId:operation,explicitNotification:true,observationOnlyRefresh:true,
    retainedUnknown:true,keyboardReceipt:true,sentRecipient:{label,title},reloadedIdentity,originalSurfacePreserved:true})
}
async function resumedNotification(width, theme, original, before) {
  await choose('Agent messages'); await choose('Received')
  await waitFor(`${visiblePanel}.querySelector('[data-mailbox-notification-action="notify"]')`)
  const selected = `${visiblePanel}.querySelector('.composer-mailbox__record:has([data-mailbox-notification-action="notify"])')`
  const mid = await evaluate(`${selected}.querySelector('[data-record-key]').dataset.recordKey.slice(4)`)
  const message = await evaluate(`messageWorkspace.originalMessage(${JSON.stringify(mid)})`)
  await evaluate('messageWorkspace.resumed()')
  await click(`${selected}.querySelector('[data-mailbox-notification-action="notify"]')`)
  await waitFor(`${selected}.textContent.includes('This notification: unconfirmed')`)
  const operation = await evaluate(`${selected}.querySelector('[data-notification-operation]').dataset.notificationOperation`)
  const reason = `${selected}.querySelector('.composer-mailbox__notification-reason')`
  assert.equal(await evaluate(`${reason}.textContent.includes('response was lost')`), true)
  assert.equal(await evaluate(`${reason}.closest('details')===null`), true, 'The precise failure reason is visible without opening details')
  await layout({ secondary: true })
  await frame(width, theme, 'resumed-response-lost')
  await key('Escape', 'Escape', 27); await originalSurfacePreserved(original, before)
  let reloadedIdentity = false
  if (width === 640) {
    const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve))
    win.webContents.reload(); await loaded; await waitFor('Boolean(window.messageWorkspace)')
    await evaluate(`messageWorkspace.restore(${JSON.stringify(theme)},${JSON.stringify(theme+'-'+width)})`)
    await waitFor(`${surface}?.querySelector('.xterm')`)
    assert.equal((await evaluate('messageWorkspace.facts().calls')).filter(call=>call.action==='notify-reference').length,0,'Reload does not replay an unknown notification')
    reloadedIdentity = true
  }
  await click(`${surface}.querySelector('.composer__mailbox')`); await waitFor(`${panel}.matches(':popover-open')`)
  await choose('Agent messages'); await choose('Received')
  await click(`${visiblePanel}.querySelector('[data-record-key="a2a:${mid}"]')`)
  await waitFor(`${visiblePanel}.querySelector('[data-notification-operation="${operation}"]')`)
  const inspect = `${visiblePanel}.querySelector('[data-notification-operation="${operation}"] [data-mailbox-notification-action="inspect"]')`
  await click(inspect)
  await waitFor(`${visiblePanel}.textContent.includes('This notification: submitted')`)
  const details = `${visiblePanel}.querySelector('[data-notification-operation] > .composer-mailbox__notification-feedback > details')`
  await click(`${details}.querySelector('summary')`)
  const inputRun = 'private-resumed-' + message.message.envelope.recipientSessionId
  assert.notEqual(inputRun, message.message.envelope.recipientRunId)
  assert.equal(await evaluate(`${details}.textContent.includes(${JSON.stringify('Original message Run '+message.message.envelope.recipientRunId)})`), true)
  assert.equal(await evaluate(`${details}.textContent.includes(${JSON.stringify('Notification input Run '+inputRun)})`), true)
  const calls = await evaluate('messageWorkspace.facts().calls')
  assert.equal(calls.filter(call=>call.action==='notify-reference').length,reloadedIdentity?0:1)
  assert.deepEqual(calls.filter(call=>call.action==='inspect-notification').map(call=>call.query),[{messageId:mid,operationId:operation}])
  await frame(width, theme, 'resumed-confirmed')
  await evaluate('messageWorkspace.resumed()')
  await click(`${visiblePanel}.querySelector('[data-mailbox-notification-action="notify"]')`)
  const second = await evaluate(`${visiblePanel}.querySelector('[data-notification-operation]').dataset.notificationOperation`)
  assert.notEqual(second, operation)
  await evaluate(`messageWorkspace.forgetNotification(${JSON.stringify(second)})`)
  await click(`${visiblePanel}.querySelector('[data-notification-operation="${second}"] [data-mailbox-notification-action="inspect"]')`)
  const nullReason = `${visiblePanel}.querySelector('.composer-mailbox__notification-reason')`
  await waitFor(`${nullReason}.textContent.includes('No original notification record was found')`)
  assert.equal(await evaluate(`${nullReason}.closest('details')===null`), true)
  assert.equal(await evaluate(`${visiblePanel}.textContent.includes('This notification: unconfirmed')`), true)
  assert.equal((await evaluate('messageWorkspace.facts().calls')).filter(call=>call.action==='notify-reference').length,reloadedIdentity?1:2)
  await frame(width, theme, 'resumed-not-found')
  await key('Escape', 'Escape', 27)
  result.scenes.push({ width, theme, mid, operationId: operation, explicitNotification: true, observationOnlyRefresh: true,
    historicalRun: message.message.envelope.recipientRunId, inputRun, reloadedIdentity, nullIsNotRefusal: true, visibleFailureReason: true, originalSurfacePreserved: true })
}
async function scenario(width, theme, short = false) {
  result.stage = { width, theme, short, action: 'seed' }
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: width * 2 + 1, height: short ? 540 : 800, deviceScaleFactor: 1, mobile: false })
  const original = await evaluate(`messageWorkspace.seed(${JSON.stringify(theme)},${JSON.stringify(theme + '-' + width + (short ? '-short' : ''))},${mode === 'empty-states' || mode === 'empty-mutation'})`)
  if (mode === 'automation') await evaluate('messageWorkspace.automation()')
  if (mode === 'progress-actions') await evaluate('messageWorkspace.progressActions()')
  await waitFor(`${surface}?.querySelector('.xterm') && ${editor}?.textContent.includes('尚未发送')`)
  await painted()
  await evaluate(`window.workspaceEditor=${editor}`)
  const before = await evaluate('({terminal:messageWorkspace.terminal(),facts:messageWorkspace.facts()})')
  await click(`${surface}.querySelector('.composer__mailbox')`)
  await waitFor(`${panel}.matches(':popover-open')`)
  if (mode === 'automation') { await automationScene(width, theme, short, original, before); return }
  if (mode === 'progress-actions') { await progressActionsScene(width, theme, short, original, before); return }
  if (mode === 'notification-resumed') { await resumedNotification(width, theme, original, before); return }
  if (mode === 'notification-recovery') { await notificationRecovery(width, theme, original, before); return }
  if (mode === 'manual-notify') { await manualNotification(width, theme, original, before); return }
  await choose('Inputs')
  await waitFor(`${visiblePanel}.querySelectorAll('button[data-record-key]').length===5`)
  const geometry = await layout({ search: true })
  if (mode === 'empty-states' || mode === 'empty-mutation') {
    await emptyStates(width, theme, original, before, geometry)
    return
  }
  if (mode === 'interaction-states') {
    await interactionStates(width, theme, original, before, geometry)
    return
  }
  if (mode === 'density') {
    await choose('Agent messages'); await choose('Received')
    await waitFor(`${visiblePanel}.querySelectorAll('button[data-record-key^="a2a:"]').length===25`)
    const agentGeometry = await layout({ secondary: true })
    result.scenes.push({ width, theme, short, geometry, agentGeometry })
    await key('Escape', 'Escape', 27)
    return
  }
  const affordances = short ? undefined : await rowAffordances()
  await frame(width, theme, short ? 'inputs-short' : 'inputs')
  if (short) {
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    await painted()
    const coarseInputs = await densityOracle({ search: true, coarse: true, record: false })
    await choose('Agent messages'); await choose('Received')
    await waitFor(`${visiblePanel}.querySelectorAll('button[data-record-key^="a2a:"]').length===25`)
    const coarseAgents = await densityOracle({ secondary: true, coarse: true, record: false })
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
    result.short = { geometry, coarseInputs, coarseAgents }
    await key('Escape', 'Escape', 27); return
  }
  if (width === 380 && theme === 'dark') {
    await click(buttons('编辑这条待发消息'))
    const queuedEditor = `${panel}.querySelector('textarea[aria-label="编辑待发消息"]')`
    await replace(queuedEditor, '保留在编辑器中的候选文本；取消不会改动原消息。')
    await frame(width, theme, 'queue-edit')
    await click(buttons('取消'))
    assert.deepEqual((await evaluate('messageWorkspace.facts()')).queues, before.facts.queues)
  }

  result.stage.action = 'search'
  await replace(query, 'Mercury'); await key('Enter', 'Enter', 13)
  await waitFor(`${visiblePanel}.querySelectorAll('button[data-record-key]').length===2`)
  assert.ok(await evaluate(`[...${visiblePanel}.querySelectorAll('button[data-record-key]')].every(n=>n.textContent.includes('Mercury'))`))
  const prior = await evaluate('messageWorkspace.facts().calls')
  await click(buttons('Refresh inputs'))
  await waitFor(`messageWorkspace.facts().calls.length>=${prior.length + 3}`)
  const reads = await evaluate(`messageWorkspace.facts().calls.slice(${prior.length})`)
  assert.equal(reads.filter(item => item.action === 'journal').length, 1)
  assert.deepEqual(reads.filter(item => item.action === 'history').map(item => item.query.query), ['Mercury', 'Mercury'])
  if (width === 380 && theme === 'dark') await frame(width, theme, 'search')

  result.stage.action = 'journal-detail'
  const journal = `([...${visiblePanel}.querySelectorAll('button[data-record-key]')].find(n=>n.textContent.includes('Mercury · 核对')))`
  const journalKey = await evaluate(`${journal}.dataset.recordKey`)
  await click(journal)
  await waitFor(`${visiblePanel}.querySelector('.log-turn__body')?.textContent.includes('原文末尾仍然可读')`)
  assert.equal(await evaluate(`${panel}.querySelectorAll('.log-turn__body').length`), 1)
  const detailDensity = await densityOracle({ record: false })
  await click(buttons('Copy message'))
  await waitFor(`messageWorkspace.facts().clipboard.at(-1)===${JSON.stringify(original.journalWire)}`)
  const scroll = await evaluate(`(()=>{const n=${panel}.querySelector('.composer-mailbox__content');n.scrollTop=37;return n.scrollTop})()`)
  await click(buttons('Automation'))
  assert.equal(await evaluate(`document.activeElement===${buttons('Back to messages')}`), true, 'Automation entry transfers focus to its Back action')
  await click(buttons('Back to messages'))
  assert.equal(await evaluate(`${panel}.querySelector('.composer-mailbox__detail[data-record-key]')?.dataset.recordKey`), journalKey, 'Automation returns to the original journal detail')
  assert.equal(await evaluate(`${panel}.querySelector('.composer-mailbox__content').scrollTop`), scroll)
  assert.equal(await evaluate(`document.activeElement===${buttons('Automation')}`), true)
  if (width === 380 && theme === 'dark') await frame(width, theme, 'journal-detail')
  await click(`${panel}.querySelector('.composer-mailbox__back button')`)
  assert.equal(await evaluate('document.activeElement.dataset.recordKey'), journalKey)
  assert.equal(await evaluate(`${query}.value`), 'Mercury')
  await replace(query, ''); await key('Enter', 'Enter', 13)
  await waitFor(`${visiblePanel}.querySelectorAll('button[data-record-key]').length===5`)

  result.stage.action = 'agent-messages'
  await choose('Agent messages'); await choose('Received')
  await waitFor(`${visiblePanel}.querySelectorAll('button[data-record-key^="a2a:"]').length===25`)
  const agentGeometry = await layout({ secondary: true })
  if (width === 380 || width === 320) await frame(width, theme, 'received')
  assert.equal((await evaluate('identityMenu.mailboxLayoutFacts().calls')).filter(item => item.action === 'read').length, 0, 'A2A metadata does not read full bodies per row')
  const incoming = `([...${visiblePanel}.querySelectorAll('button[data-record-key]')].find(n=>n.dataset.recordKey===${JSON.stringify('a2a:' + original.incoming)}))`
  await click(incoming)
  await waitFor(`${visiblePanel}.querySelector('.log-turn__body')?.textContent.includes('原文唯一尾段')`)
  const originalReads = (await evaluate('identityMenu.mailboxLayoutFacts().calls')).filter(item => item.action === 'read')
  assert.equal(originalReads.length, 1); assert.equal(originalReads[0].messageId, original.incoming)
  assert.deepEqual(originalReads[0].reference, { hostId: original.hostId, agentSessionId: original.agentSessionId })
  if (width === 380 && theme === 'dark') await frame(width, theme, 'a2a-detail')
  await click(`${panel}.querySelector('.composer-mailbox__back button')`)
  await click(buttons('Read earlier messages'))
  await waitFor(`${visiblePanel}.querySelectorAll('button[data-record-key^="a2a:"]').length===27`)
  await choose('Sent')
  await waitFor(`${visiblePanel}.querySelectorAll('button[data-record-key^="a2a:"]').length===3`)
  if (width === 380 && theme === 'dark') await frame(width, theme, 'sent')
  await choose('Collaboration')
  await waitFor(`${visiblePanel}.querySelector('[data-source-message]')`)
  if (width === 380 && theme === 'dark') await frame(width, theme, 'collaboration')
  await choose('Notices')
  await waitFor(`${visiblePanel}.querySelector('.composer-notice')`)
  if (width === 380 && theme === 'dark') await frame(width, theme, 'notices')

  result.stage.action = 'automation'
  const automation = `([...${panel}.querySelectorAll('button')].find(n=>!n.closest('[hidden]')&&n.textContent.includes('Automation')))`
  await click(automation)
  await click(`${panel}.querySelector('[data-progress-details="interval"] > summary')`)
  const interval = `${panel}.querySelector('.continuous-progress-control input[type="number"]')`
  await waitFor(visible(interval)); await replace(interval, '23')
  await evaluate(`window.workspaceInterval=${interval}`)
  const subscriptions = await evaluate('messageWorkspace.facts().progress.subscribers')
  if (width === 380 || width === 320) await frame(width, theme, 'automation')
  await click(buttons('Back to messages'))
  await choose('Inputs'); await click(automation)
  assert.equal(await evaluate(`window.workspaceInterval===${interval}&&${interval}.value==='23'`), true, 'Automation keeps the original field and unsaved value')
  assert.equal(await evaluate('messageWorkspace.facts().progress.subscribers'), subscriptions, 'Navigation does not duplicate Automation observers')
  await click(buttons('Back to messages'))

  result.stage.action = 'keyboard-close'
  await evaluate(`${tab('Inputs')}.focus()`); await key('ArrowRight', 'ArrowRight', 39)
  assert.equal(await evaluate(`${tab('Agent messages')}.getAttribute('aria-selected')`), 'true')
  await key('Escape', 'Escape', 27)
  await waitFor(`!${panel}.matches(':popover-open')`)
  assert.equal(await evaluate(`document.activeElement===${surface}.querySelector('.composer__mailbox')`), true)
  await originalSurfacePreserved(original, before)
  result.scenes.push({ width, theme, geometry, agentGeometry, detailDensity, affordances, queryAndRefresh: true, journalDetailAndCopy: true, retainedAutomation: true, originalSurfacePreserved: true })
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true })
    win = new BrowserWindow({ show: false, width: 1281, height: 800, webPreferences: { backgroundThrottling: false, sandbox: false } })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('Boolean(window.messageWorkspace)')
    if (mode === 'automation' || mode === 'progress-actions') { await scenario(640, 'light'); await scenario(320, 'dark'); await scenario(320, 'dark', true) }
    else if (mode === 'manual-notify' || mode === 'notification-recovery' || mode === 'notification-resumed') { for (const [width, theme] of [[380,'dark'],[320,'dark'],[640,'light']]) await scenario(width, theme, mode === 'notification-recovery' && width === 320) }
    else if (mode === 'empty-mutation') await scenario(320, 'dark')
    else if (mode === 'empty-states') for (const theme of ['dark', 'light']) for (const width of [320, 380, 440]) await scenario(width, theme)
    else if (mode === 'density') await scenario(320, 'dark', true)
    else if (mode === 'interaction-states') await scenario(380, 'dark')
    else {
      for (const theme of ['dark', 'light']) for (const width of [640, 380, 320]) await scenario(width, theme)
      await scenario(320, 'dark', true)
    }
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack, ...(error.density ? { density: error.density } : {}) }
    if (win && mode !== 'density') await frame(result.stage?.width ?? 0, result.stage?.theme ?? 'unknown', 'failure').catch(() => {})
  } finally {
    await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2) + '\n')
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
