const assert = require('node:assert/strict')
module.exports = async ({ win, read, until, resize, tap, button, capture, result }) => {
  await until('typeof mobileProductScene !== "undefined" && !!document.querySelector(".mobile-spatial-panel")')
  await read('mobileProductScene.prepareDensity()')
  const editor = '.mobile-conversation .composer [contenteditable=true]'
  await until('!!document.querySelector(' + JSON.stringify(editor) + ')')
  await read(`document.querySelector(${JSON.stringify(editor)}).focus()`); win.webContents.insertText('请看所选的截图。')
  await win.webContents.debugger.sendCommand('Page.enable')
  await win.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
  await tap('.mobile-conversation [aria-label="Reference files for the Agent to read"]', '选择原附件')
  await until('!!document.querySelector(".mobile-attachments [aria-label=取消本次选择]")')
  for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
    await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await capture(`attachment-picker-${width}-${appearance}`)
  }
  await button('取消本次选择', '.mobile-attachments')
  const pasted = await read(`(()=>{const f=new File(['data'],'参考截图.png',{type:'image/png'});Object.defineProperty(f,'stream',{value:()=>new ReadableStream({start(){}})});const e=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(e,'clipboardData',{value:{items:[{kind:'file',type:'image/png',getAsFile:()=>f}],getData:()=>''}});document.querySelector(${JSON.stringify(editor)}).dispatchEvent(e);return e.defaultPrevented})()`)
  assert.equal(pasted, true)
  await until('!!document.querySelector(".mobile-attachments [aria-label=取消本次读取]")')
  for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
    await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    assert.equal(await read('[...document.querySelectorAll(".mobile-attachment-pending__row button")].every(n=>n.getBoundingClientRect().height>=44&&n.getBoundingClientRect().width>=44)'), true)
    await capture(`attachment-reading-${width}-${appearance}`)
  }
  await resize(320, 760); await read('mobileProductScene.setAppearance("dark")')
  await button('读取 参考截图.png的原目标', '.mobile-attachments')
  assert.equal(await read('document.querySelector(".mobile-attachment-pending__identity")?.textContent.includes("Session session-mote")'), true)
  await capture('attachment-reading-identity-320-dark')
  await button('取消本次读取', '.mobile-attachments')
  await read(`(async()=>{const c=document.createElement('canvas');c.width=c.height=96;const g=c.getContext('2d');g.fillStyle='#81d5b2';g.fillRect(0,0,96,96);g.fillStyle='#23463f';g.fillRect(12,16,72,64);g.fillStyle='#f4e1bc';g.fillRect(20,25,56,8);g.fillRect(20,41,42,6);const b=await new Promise(resolve=>c.toBlob(resolve,'image/png'));const f=new File([b],'保留截图.png',{type:'image/png'});const e=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(e,'clipboardData',{value:{items:[{kind:'file',type:'image/png',getAsFile:()=>f}],getData:()=>''}});document.querySelector(${JSON.stringify(editor)}).dispatchEvent(e)})()`)
  await until('!!document.querySelector(".mobile-attachment[data-phase=selected]")')
  await read('mobileProductScene.setUnconfirmedClient(true)')
  await until('document.querySelector(".mobile-attachments small")?.textContent.includes("目标未确认")')
  for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
    await resize(width, 760); await read('mobileProductScene.setUnconfirmedClient(false)')
    await until('mobileProductScene.appearanceReady()')
    await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    await read('mobileProductScene.setUnconfirmedClient(true)')
    await until('document.querySelector(".mobile-attachments small")?.textContent.includes("目标未确认")')
    await capture(`attachment-target-unconfirmed-${width}-${appearance}`)
  }
  await resize(320, 760); await read('mobileProductScene.setUnconfirmedClient(false)')
  await until('mobileProductScene.appearanceReady()'); await read('mobileProductScene.setAppearance("dark")')
  await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'); await read('mobileProductScene.setUnconfirmedClient(true)')
  await until('document.querySelector(".mobile-attachments small")?.textContent.includes("目标未确认")')
  await tap('.mobile-attachment-details > summary', '查看附件原目标')
  await capture('attachment-target-unconfirmed-details-320-dark')
  await read('document.querySelector(".mobile-attachments").scrollTop=document.querySelector(".mobile-attachments").scrollHeight')
  await capture('attachment-target-unconfirmed-details-end-320-dark')
  assert.equal(await read('mobileProductScene.facts().calls.filter(call=>call.method==="file.upload"||call.method==="sdk.submitAgentPrompt").length'), 0)
  result.attachmentSelectionBoundary = 'Actual MobileApp and shared Composer with intercepted Chromium chooser and a deliberately stalled browser stream; controlled Host facts, no physical phone or native OS claim.'
}
