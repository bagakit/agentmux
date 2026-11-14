const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')

const [html, evidence, variant] = process.argv.slice(2)
const narrow = variant === 'long-label' || variant === 'unstable-mailbox-preview'
app.setPath('userData', join(evidence, 'profile'))
const result = { passed: false }
const floating = '.composer-pending:not([hidden]) .composer-queued-editor'
const outbox = '.composer-mailbox:popover-open'
const originalEditor = '.agent-surface .composer [role="textbox"]'
const pending = '.composer-pending:not([hidden])'
let win
async function read(code) {
  const reply = await win.webContents.executeJavaScript(`(async()=>{try{return {value:await eval(${JSON.stringify(code)})}}catch(error){return {error:error.message}}})()`)
  if (reply.error) throw Error(reply.error + ' in ' + code)
  return reply.value
}
const query = selector => `document.querySelector(${JSON.stringify(selector)})`
async function until(code) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await read(`(()=>{try{return Boolean(${code})}catch{return false}})()`)) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail('Original control condition did not arrive: ' + code)
}
const paint = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
async function capture(name) {
  win.webContents.invalidate()
  await paint()
  const image = await win.webContents.capturePage()
  await writeFile(join(evidence, name + '.png'), image.toPNG())
}
async function click(selector) {
  const point = await read(`(()=> {
    const el=${query(selector)}
    if (!el) throw Error('Original action is absent: '+${JSON.stringify(selector)})
    const r=el.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2
    const hit=document.elementFromPoint(x,y)
    if (hit!==el && !el.contains(hit)) throw Error('Actual action is not reachable: '+${JSON.stringify(selector)})
    return {x,y}
  })()`)
  for (const type of ['mousePressed', 'mouseReleased'])
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
}
async function key(key, code, windowsVirtualKeyCode, text) {
  for (const type of ['keyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type, key, code, windowsVirtualKeyCode, ...(type === 'keyDown' && text ? { text, unmodifiedText: text } : {})
  })
}
async function readyPaint(selector) {
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseMoved', x:2, y:2 })
  await until(`!${query(selector)}.disabled && !${query(selector)}.matches(':hover')`)
  await read("Promise.allSettled(document.getAnimations().filter(animation=>Number.isFinite(animation.effect.getComputedTiming().endTime)).map(animation=>animation.finished))")
  await paint()
  return read(`(() => {
    const button=${query(selector)}, style=getComputedStyle(button)
    let opacity=1
    for (let element=button;element;element=element.parentElement) opacity*=Number(getComputedStyle(element).opacity)
    const canvas=document.createElement('canvas'); canvas.width=1; canvas.height=1
    const context=canvas.getContext('2d',{willReadFrequently:true})
    const luminance=color=>{
      context.clearRect(0,0,1,1); context.fillStyle=color; context.fillRect(0,0,1,1)
      const channels=[...context.getImageData(0,0,1,1).data].slice(0,3).map(value=>value/255)
      return channels.map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4)
        .reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0)
    }
    const foreground=luminance(style.color)
    const contrast=['--green','--green-2'].map(token=>{
      const stop=luminance(style.getPropertyValue(token).trim())
      return (Math.max(foreground,stop)+0.05)/(Math.min(foreground,stop)+0.05)
    })
    return {color:style.color,background:style.backgroundImage,opacity,contrast}
  })()`)
}
const actionRects = selector => `[...document.querySelectorAll(${JSON.stringify(selector)})].map(el => {
  const r=el.getBoundingClientRect()
  return { label:el.getAttribute('aria-label')??el.textContent, x:r.x, y:r.y, width:r.width, height:r.height }
})`
const actions = selector => read(actionRects(selector))
async function startSampling(selector) {
  await read(`(() => {
    const frames=[]
    let pending
    const sample=()=>{
      const group=${query(selector)}?.closest('.composer-queued-editor')
      frames.push({actions:${actionRects(selector)}, top:group?.getBoundingClientRect().top,
        scroll:group?.closest('.composer-mailbox__content')?.scrollTop,
        preview:group?.closest('li[data-operation-id]')?.querySelector('.composer-mailbox__preview')?.getBoundingClientRect().height,
        source:group?.closest('li[data-operation-id]')?.querySelector('.composer-mailbox__preview')?.textContent})
      pending=requestAnimationFrame(sample)
    }
    pending=requestAnimationFrame(sample)
    window.stopActionSampling=()=>{ cancelAnimationFrame(pending); return frames }
  })()`)
}
async function stopSampling(resting) {
  const frames = await read('stopActionSampling()')
  assert.ok(frames.length >= 6, 'Actual frame comparison samples the whole operation')
  try {
    for (const frame of frames) if (frame.actions.length) checkStable(resting,frame.actions)
  } catch (error) {
    result.drift = frames
    throw error
  }
  return frames.length
}
function checkStable(before, after) {
  assert.equal(after.length, before.length)
  for (const [index, action] of before.entries()) {
    assert.equal(after[index].label, action.label)
    for (const coordinate of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(after[index][coordinate]-action[coordinate])<=1, `Original action hit box moved: ${action.label} ${coordinate} ${action[coordinate]} → ${after[index][coordinate]}`)
    }
  }
}

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1080, height: 750, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    result.console = []
    win.webContents.on('console-message', event => { if (event.level === 'error') result.console.push(event.message) })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion', value:'no-preference'}]})
    await until('Boolean(window.pendingDelivery)')
    await until(`Boolean(${query(originalEditor)})`)
    await until('Boolean(window.actionGroup)')
    if (narrow) {
      win.setContentSize(640, 780)
      win.webContents.setZoomFactor(1.25)
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion', value:'reduce'}]})
      await until(`innerWidth<=560 && matchMedia('(prefers-reduced-motion: reduce)').matches`)
    }
    const appearance = narrow ? 'light' : 'dark'
    await read(`pendingDelivery.seed(${JSON.stringify(appearance)}); pendingDelivery.queue('原始待发消息，完整正文保留。')`)
    const original = await read('Object.values(pendingDelivery.facts().queues)[0][0]')
    const sid = await read('Object.keys(pendingDelivery.facts().queues)[0]')
    const originalDraft = await read(`window.originalActionDraft=${query(originalEditor)}; originalActionDraft.textContent`)
    const editLabel = ' [aria-label="编辑这条待发消息"]'
    const saveLabel = ' [aria-label="保存待发消息"]'
    const footer = ' .composer-edit-footer button'
    const competitorText = '另一编辑者已在这条原消息保存完毕，刷新后仍应读取准确原文。'

    const replaceDraft = async (selector, text) => {
      await read(`${query(selector)}.focus(); ${query(selector)}.select()`)
      await win.webContents.debugger.sendCommand('Input.insertText', { text })
      await paint()
    }
    const runEdit = async ({ editor, button, originalText, nextText, conflict }) => {
      await until(`Boolean(${query(button)})`)
      await click(button)
      const textarea = editor + ' textarea', save = editor + saveLabel
      await until(`Boolean(${query(textarea)})`)
      await replaceDraft(textarea,nextText)
      const resting = await actions(editor + footer)
      assert.ok(resting.length >= 2)
      await read('actionGroup.beginHoldingEdit()')
      const previous = await read('actionGroup.facts().edits.length')
      await startSampling(editor + footer)
      await click(save)
      await until(`${query(save)}.getAttribute('aria-busy')==='true'`)
      const busy = []
      for (let frame = 0; frame < 4; frame++) {
        await paint()
        busy.push(await actions(editor + footer))
        checkStable(resting,busy.at(-1))
      }
      await click(save)
      assert.equal(await read('actionGroup.facts().edits.length'),previous+1)
      assert.deepEqual(await read('actionGroup.facts().edits.at(-1)'),[sid,original.operationId,originalText,nextText])
      if (conflict) {
        await click(editor + ' .composer-pending__copy')
        assert.equal(await read('pendingDelivery.facts().copies.at(-1)'),originalText)
        await read(`actionGroup.revise(...${JSON.stringify([sid,original.operationId,originalText,competitorText])})`)
        await paint()
        await capture('pending-saving')
      }
      if (!conflict) await capture('mailbox-saving')
      await read('actionGroup.publishEdit()')
      const afterPublication = conflict ? competitorText : nextText
      await until(`Object.values(pendingDelivery.facts().queues)[0][0].text===${JSON.stringify(afterPublication)}`)
      await paint()
      await read('actionGroup.releaseEdit()')
      if (conflict) {
        await until(`Boolean(${query(editor + ' [role="alert"]')})`)
        await paint()
        const failed = await actions(editor + footer)
        checkStable(resting,failed)
        assert.equal(await read(`${query(textarea)}.value`),nextText)
        assert.equal(await read(`document.activeElement===${query(textarea)}`),true)
        await capture('pending-conflict')
        if (narrow) {
          const feedback = editor + ' .agent-action-feedback'
          assert.ok(await read(`${query(feedback)}.scrollHeight>${query(feedback)}.clientHeight`))
          await key('Tab','Tab',9)
          await until(`document.activeElement===${query(feedback)}`)
          await key('End','End',35)
          const recovery = 'The current message is kept.'
          await until(`${query(feedback)}.scrollHeight-${query(feedback)}.clientHeight-${query(feedback)}.scrollTop<=1`)
          assert.equal(await read(`(() => {
            const region=${query(feedback)}, text=region.querySelector('[role="alert"]').firstChild
            const range=document.createRange(), bounds=region.getBoundingClientRect()
            range.setStart(text,text.length-${recovery.length});range.setEnd(text,text.length)
            const rect=range.getBoundingClientRect()
            return range.toString()===${JSON.stringify(recovery)} && rect.top>=bounds.top && rect.bottom<=bounds.bottom
          })()`),true,'Original conflict and preservation statement can be read from the keyboard')
          await capture('pending-conflict-recovery')
        }
        await key('Escape','Escape',27)
        await until(`!${query(editor)}`)
      } else {
        await until(`!${query(editor)}`)
      }
      assert.deepEqual(await read('Object.values(pendingDelivery.facts().queues)[0]'),[{...original,text:conflict?competitorText:nextText}])
      assert.equal(await read('pendingDelivery.facts().attempts.length'),0)
      const frames = await stopSampling(resting)
      if (!conflict) await capture('mailbox-confirmed')
      return { resting, busy, frames }
    }
    result.floating = await runEdit({ editor:floating, button:pending + editLabel, originalText:original.text, nextText:'用户未保存的待发编辑', conflict:true })
    const more = pending + ' .composer-pending__more'
    await until(`Boolean(${query(more)})`)
    await paint()
    await click(more)
    result.mailbox = await runEdit({ editor:outbox + ' .composer-queued-editor',button:outbox + editLabel, originalText:competitorText, nextText:'Mailbox 保存成功后的原消息' })
    assert.equal(await read(`${query(originalEditor)}===originalActionDraft && originalActionDraft.textContent===${JSON.stringify(originalDraft)}`),true)

    await read('pendingDelivery.clear(); actionGroup.openSettings()')
    const field = '[aria-label="Start page title"]'
    const settingBar = '.settings-survey [data-settings-save-bar]'
    const save = settingBar + ' button.primary-button'
    await until(`Boolean(${query(field)})`)
    if (variant === 'long-label') await until(`innerWidth<=560 && matchMedia('(prefers-reduced-motion: reduce)').matches`)
    result.viewport = await read(`({cssWidth:innerWidth,label:${query(save)}.textContent,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches})`)
    result.viewport.zoom = win.webContents.getZoomFactor()
    if (variant === 'long-label') assert.ok(result.viewport.label.length>=36)
    const title = await read(`${query(field)}.value`)
    const edited = 'A named Survey for comparing original sources'
    await replaceDraft(field,edited)
    await read(`${query(save)}.scrollIntoView({block:'nearest'})`)
    await paint()
    const restingPaint = await readyPaint(save)
    assert.equal(restingPaint.opacity,1)
    assert.match(restingPaint.background,/linear-gradient/)
    assert.ok(restingPaint.contrast.every(value=>value>=4.5),'The available action text contrasts at both ends of the real gradient')
    const resting = await actions(save)
    assert.equal(resting.length,1)
    await capture('survey-unsaved')
    await startSampling(save)
    await click(save)
    await until(`${query(save)}.getAttribute('aria-busy')==='true'`)
    const motion = `${query(settingBar + ' [data-icon-animation="spin"]')}`
    assert.ok(await read(`Boolean(${motion})`))
    const animation = await read(`(() => {
      const style=getComputedStyle(${motion})
      return {name:style.getPropertyValue('--icon-spin-animation').trim(),
        iterations:style.getPropertyValue('--icon-motion-iterations').trim()}
    })()`)
    assert.deepEqual(animation,{name:'semantic-icon-spin',iterations:narrow?'0':'infinite'})
    const saving = []
    for(let frame=0; frame<4; frame++) {
      await paint()
      saving.push(await actions(save))
      checkStable(resting,saving.at(-1))
    }
    await click(save)
    assert.deepEqual(await read('actionGroup.facts().settings'),[{expected:title,value:edited}])
    await capture('survey-saving')
    const failure = 'The Survey start page could not be saved because the original configuration is read-only. Your title and other edits are still here. Check the permissions for the configuration on the device that owns these settings. If another process is updating that configuration, allow it to finish before trying again. Once the original configuration is writable, choose Save again to apply the current draft.'
    await read(`actionGroup.releaseSettings(${JSON.stringify(failure)})`)
    await until(`Boolean(${query(settingBar + ' [role="alert"]')})`)
    await paint()
    assert.equal(await read(`${query(field)}.value`),edited)
    assert.equal(await read(`${query(settingBar + ' [role="alert"]')}.textContent`),failure)
    const feedback = settingBar + ' [role="alert"]'
    const failedPaint = await readyPaint(save)
    assert.deepEqual(failedPaint,restingPaint,'The same enabled action keeps its visible color and opacity after failure')
    const failed = await actions(save)
    checkStable(resting,failed)
    const scrollable = await read(`${query(feedback)}.scrollHeight > ${query(feedback)}.clientHeight`)
    assert.equal(scrollable,true,'The complete long failure is readable by scrolling')
    await read(`${query(feedback)}.focus()`)
    await key('End','End',35)
    await until(`${query(feedback)}.scrollHeight-${query(feedback)}.clientHeight-${query(feedback)}.scrollTop<=1`)
    const recovery = await read(`(() => {
      const viewport=${query(feedback)}, text=viewport.firstChild, range=document.createRange()
      range.setStart(text,text.length-21); range.setEnd(text,text.length)
      const last=range.getBoundingClientRect(), bounds=viewport.getBoundingClientRect()
      return { text:range.toString(),visible:last.bottom<=bounds.bottom && last.top>=bounds.top }
    })()`)
    assert.deepEqual(recovery,{text:'ly the current draft.',visible:true},'Keyboard scrolling exposes the original recovery sentence')
    await capture('survey-failure-recovery')
    await key('Home','Home',36)
    await until(`${query(feedback)}.scrollTop===0`)
    await read(`${query(feedback)}.blur()`)
    await capture('survey-save-failed')
    await click(save)
    await until(`${query(save)}.getAttribute('aria-busy')==='true'`)
    assert.deepEqual(await read('actionGroup.facts().settings'),[{expected:title,value:edited},{expected:title,value:edited}])
    await read('actionGroup.releaseSettings()')
    await until(`${query(save)}.disabled && ${query(save)}.getAttribute('aria-busy')==='false' && ${query(settingBar + ' [data-semantic-icon="status.saved"]')}`)
    await paint()
    const confirmed = await actions(save)
    checkStable(resting,confirmed)
    await capture('survey-save-confirmed')
    const frames = await stopSampling(resting)
    result.settings = { resting, saving, failed, confirmed, frames, restingPaint, failedPaint, recovery }
    result.passed = true
  } catch (error) {
    result.failure = error.message
    result.current = await read(`(() => {
      const mailbox=document.querySelector('.composer-mailbox')
      return {mailbox:mailbox?.matches(':popover-open'), text:mailbox?.textContent.slice(0,500),
        active:document.activeElement?.textContent.slice(0,200), more:document.querySelector('.composer-pending__more')?.disabled}
    })()`).catch(() => null)
  } finally {
    await writeFile(join(evidence, 'render.json'), JSON.stringify(result, null, 2))
    win?.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
