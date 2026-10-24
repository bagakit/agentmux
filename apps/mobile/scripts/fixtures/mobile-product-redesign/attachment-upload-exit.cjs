const assert = require('node:assert/strict')
module.exports = async ({ win, read, until, resize, tap, button, capture, result }) => {
  await until('typeof mobileProductScene !== "undefined" && !!document.querySelector(".mobile-conversation .composer [contenteditable=true]")')
  const editor = '.mobile-conversation .composer [contenteditable=true]'
  await read(`document.querySelector(${JSON.stringify(editor)}).focus()`); win.webContents.insertText('请阅读这张截图。')
  await read(`(async()=>{const c=document.createElement('canvas');c.width=c.height=96;const g=c.getContext('2d');g.fillStyle='#81d5b2';g.fillRect(0,0,96,96);g.fillStyle='#23463f';g.fillRect(12,16,72,64);g.fillStyle='#f4e1bc';g.fillRect(20,25,56,8);g.fillRect(20,41,42,6);const b=await new Promise(resolve=>c.toBlob(resolve,'image/png'));const f=new File([b],'原资料截图.png',{type:'image/png'});const e=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(e,'clipboardData',{value:{items:[{kind:'file',type:'image/png',getAsFile:()=>f}],getData:()=>''}});document.querySelector(${JSON.stringify(editor)}).dispatchEvent(e)})()`)
  await until('!!document.querySelector(".mobile-attachment[data-phase=selected]")')
  await read('mobileProductScene.holdFileUpload()')
  await button('上传并加入 原资料截图.png', '.mobile-attachments')
  await until('!!document.querySelector(".mobile-attachments [aria-label=结束等待]")')
  for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
    await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await capture(`upload-wait-${width}-${appearance}`)
  }
  await button('结束等待', '.mobile-attachments')
  await until('!!document.querySelector(".mobile-attachment[data-phase=unknown]")')
  for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
    await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await capture(`upload-unknown-${width}-${appearance}`)
  }
  await button('管理 原资料截图.png 本机副本', '.mobile-attachments')
  await button('放弃本机副本', '.mobile-attachments')
  for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
    await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await read('document.querySelector(".mobile-attachments").scrollTop=document.querySelector(".mobile-attachments").scrollHeight')
    await capture(`upload-discard-confirm-${width}-${appearance}`)
  }
  await button('保留', '.mobile-attachments')
  await read(`(()=>{URL.createObjectURL=()=>"blob:controlled";URL.revokeObjectURL=()=>{};HTMLAnchorElement.prototype.click=()=>{}})()`)
  await button('保存本机副本', '.mobile-attachments'); await button('保留', '.mobile-attachments')
  await read('mobileProductScene.releaseFileUpload()')
  await until('!!document.querySelector(' + JSON.stringify('.mobile-attachments [aria-label="将 原资料截图.png 加入消息"]') + ')')
  await button('将 原资料截图.png 加入消息', '.mobile-attachments')
  await until('!!document.querySelector(".mobile-attachment[data-phase=inserted]")')
  for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
    await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await capture(`upload-export-pending-${width}-${appearance}`)
  }
  await button('确认已另存', '.mobile-attachments')
  for (const width of [320, 390]) for (const appearance of ['dark', 'light']) {
    await resize(width, 760); await read(`mobileProductScene.setAppearance(${JSON.stringify(appearance)})`)
    await read('document.querySelector(".mobile-attachments").scrollTop=document.querySelector(".mobile-attachments").scrollHeight')
    await capture(`upload-export-confirm-${width}-${appearance}`)
  }
  await button('保留', '.mobile-attachments')
  assert.equal(await read('mobileProductScene.facts().calls.filter(call=>call.method==="file.upload").length'), 1)
  assert.equal(await read('mobileProductScene.facts().calls.filter(call=>call.method==="sdk.submitAgentPrompt").length'), 0)
  result.uploadExitBoundary = 'Actual MobileApp and shared Composer with controlled unresolved file.upload; no live Host, OS save receipt or physical phone claim.'
}
