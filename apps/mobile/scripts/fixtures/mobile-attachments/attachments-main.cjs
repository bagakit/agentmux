const { app, BrowserWindow, Menu, ipcMain } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, privateRoot, evidence] = process.argv.slice(2)
const { FileUploadOwner } = require(path.join(path.dirname(html), 'file-owner.cjs'))
const owner = new FileUploadOwner(path.join(privateRoot, 'host-attachments'))
app.setPath('userData', path.join(privateRoot, 'userData'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, images: [], operations: [], errors: [], host: [] }
ipcMain.handle('private-file-upload', async (_event, method, params) => {
  const receipt = method === 'file.upload' ? await owner.upload(params) : await owner.inspect(params)
  result.host.push({ method, receipt, readbackBytes: receipt.status === 'uploaded' ? (await fs.readFile(receipt.path)).byteLength : null })
  return receipt
})
app.whenReady().then(async () => {
 let win
 try {
  Menu.setApplicationMenu(null)
  win = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false,
    sandbox: true, offscreen: true, backgroundThrottling: false, preload: path.join(path.dirname(html), 'preload.cjs') } })
  win.webContents.on('console-message', event => { if (event.level === 'error') result.errors.push(event.message) })
  await win.loadFile(html)
  const read = code => win.webContents.executeJavaScript(code)
  const until = async code => { for (let i = 0; i < 150; i++) { if (await read(code)) return; await pause(30) }; throw Error('Renderer condition unavailable: ' + code) }
  await until('!!document.querySelector(".mobile-session-list button")')
  const click = async selector => { const r = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing actual control '+${JSON.stringify(selector)});n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`); for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,x:Math.round(r.x),y:Math.round(r.y),button:'left',clickCount:1}); await pause(120) }
  const named = label => click('[aria-label=' + JSON.stringify(label) + ']')
  const capture = async name => { await pause(120); const facts = await read(`(()=>{const n=document.querySelector('.mobile-app');return {text:n.textContent,overflow:n.scrollWidth>n.clientWidth,rootTop:n.getBoundingClientRect().top,windowScrollY:scrollY,appScroll:n.scrollTop,header:document.querySelector(".mobile-header").getBoundingClientRect().toJSON(),viewport:{height:innerHeight,visualHeight:visualViewport.height,top:visualViewport.offsetTop},...attachmentScene.facts()}})()`); assert.equal(facts.overflow, false); await fs.writeFile(path.join(evidence, name+'.png'), (await win.webContents.capturePage()).toPNG()); result.images.push(name+'.png'); result.operations.push({ name, ...facts }) }
  await click('.mobile-spatial-panel details > summary'); await click('.mobile-session-list button')
  await click('[contenteditable="true"]'); win.webContents.insertText('先看附件，再比较两种方案。')
  await named('Show the message tool row')
  await named('Reference files for the Agent to read'); await until('!!document.querySelector(".mobile-attachment")')
  await capture('image-selected-phone')
  await read('attachmentScene.hold()'); await named('上传并加入 头像参考.png'); await capture('uploading-phone')
  await click('[contenteditable="true"]'); win.webContents.insertText(' 后来补充的文字仍在。')
  await until('typeof attachmentScene.facts().record.fileUploads?.[0]?.identity.operationId==="string"')
  await read('attachmentScene.release()'); await until('attachmentScene.facts().record.fileUploads[0].phase==="inserted"')
  assert.equal(await read('document.querySelector("[contenteditable=true]").textContent.includes("后来补充的文字仍在")'), true)
  await capture('confirmed-path-phone')
  await read('attachmentScene.file()'); await named('Reference files for the Agent to read'); await capture('file-selected-phone')
  await read('attachmentScene.loseReply()'); await named('上传并加入 本周研究资料与两个方案的比较.md'); await until('!!document.querySelector("[data-phase=unknown]")')
  await capture('receipt-unknown-phone')
  win.setContentSize(320, 760); await capture('receipt-unknown-narrow')
  await named('核对 本周研究资料与两个方案的比较.md 原上传'); await until('!document.querySelector("[data-phase=unknown]")')
  const methods = await read('attachmentScene.facts().calls.filter(x=>x.method.startsWith("file.upload")).map(x=>x.method)')
  assert.deepEqual(methods, ['file.upload','file.upload','file.upload.inspect'])
  await named('Reference files for the Agent to read'); await read('attachmentScene.offline()'); await named('上传并加入 本周研究资料与两个方案的比较.md')
  await capture('offline-retains-narrow')
  assert.equal(await read('document.querySelector("[contenteditable=true]").getAttribute("contenteditable")'), 'true')
  win.setContentSize(900, 820); await capture('offline-retains-wide')
  await read('attachmentScene.reconnect()'); await named('移除 本周研究资料与两个方案的比较.md 本地引用'); await capture('original-draft-retained-wide')
  result.passed = true
 } catch (error) { result.error = { message: error.message, stack: error.stack }; if (win) await fs.writeFile(path.join(evidence, 'failed.png'), (await win.webContents.capturePage()).toPNG()) }
 finally { await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2)+'\n'); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
