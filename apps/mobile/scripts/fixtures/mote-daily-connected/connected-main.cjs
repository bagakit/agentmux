const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'userData'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, pid: process.pid, images: [], operations: [], errors: [] }
app.whenReady().then(async () => {
 let win
 try {
  Menu.setApplicationMenu(null);win = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  win.webContents.on('console-message', event => { if(event.level === 'error')result.errors.push(event.message) })
  await win.loadFile(html)
  const read = async code => { try { return await win.webContents.executeJavaScript(code) } catch(error) { throw new Error('Actual Renderer operation failed: '+code.slice(0,220), {cause:error}) } }
  for(let i=0;i<100 && !(await read('!!document.querySelector(".mobile-session-list button")'));i++)await pause(30)
  const click = async selector => {const r=await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing actual control: '+${JSON.stringify(selector)});n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,x:Math.round(r.x),y:Math.round(r.y),button:'left',clickCount:1});await pause(150)}
  const clickText = async text => {await read(`(()=>{const n=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)});if(!n)throw Error('missing named control '+${JSON.stringify(text)});n.dataset.captureTarget='yes'})()`);await click('[data-capture-target="yes"]');await read('document.querySelector("[data-capture-target]")?.removeAttribute("data-capture-target")')}
  const capture = async name => {await pause(150);const facts=await read(`(()=>{const n=document.querySelector('.mobile-app');return {text:n.textContent,overflow:n.scrollWidth>n.clientWidth,...connectedWork.facts()}})()`);assert.equal(facts.overflow,false);await fs.writeFile(path.join(evidence,name+'.png'),(await win.webContents.capturePage()).toPNG());result.images.push(name+'.png');result.operations.push({name,...facts})}
  await click('.mobile-spatial-panel details > summary');await click('.mobile-session-list button')
  await read('window.originalComposerNode=document.querySelector("[contenteditable=true]")')
  assert.equal(await read('!!originalComposerNode'),true)
  await click('[contenteditable="true"]');win.webContents.insertText('后来的原对话草稿保留。');await pause(150)
  await click('[aria-label="目标与结果"]');await capture('goal-list-phone')
  await click('[aria-label="查看目标 把这周的想法做成一个小实验"]');await capture('goal-confirmed-phone')
  await clickText('开始并持续推进');await capture('goal-continuing-phone')
  await read('connectedWork.loseReceipt()');await clickText('暂停');await read("document.querySelector('.mobile-goal-pending').scrollIntoView({block:'center'})");await capture('goal-unknown-operation-phone')
  await click('[aria-label="返回原对话"]');assert.equal(await read('originalComposerNode===document.querySelector("[contenteditable=true]")'),true);assert.equal(await read('originalComposerNode.textContent.includes("后来的原对话草稿保留")'),true)
  await click('[aria-label="目标与结果"]');await read('connectedWork.offline()');await capture('goal-offline-retains-phone')
  await read('connectedWork.reconnect()');await clickText('检查并重试原暂停')
  assert.equal(await read('JSON.stringify(connectedWork.facts().calls.filter(x=>x.method==="goal.continuation-action")[0].params)===JSON.stringify(connectedWork.facts().calls.filter(x=>x.method==="goal.continuation-action")[1].params)'),true)
  await read('connectedWork.result()');await click('[aria-label="刷新目标状态"]');await read("document.querySelector('.mobile-goal-result').scrollIntoView({block:'center'})");await capture('goal-result-phone')
  win.setContentSize(920,820);await pause(150);await read("document.querySelector('.mobile-goal-result').scrollIntoView({block:'center'})");await capture('goal-result-wide')
  await read('connectedWork.foreignHost()');await read("document.querySelector('.mobile-main').scrollTop=0");await capture('goal-foreign-host-wide')
  assert.equal(await read('document.querySelector(".mobile-goal-work").textContent.includes("当前连接尚未确认同一身份")'),true)
  assert.equal(await read('originalComposerNode===document.querySelector("[contenteditable=true]")'),true)
  result.passed=true
 }catch(error){result.error={message:error.message,stack:error.stack};if(win)await fs.writeFile(path.join(evidence,'failed.png'),(await win.webContents.capturePage()).toPNG())}
 finally{await fs.writeFile(path.join(evidence,'renderer-result.json'),JSON.stringify(result,null,2)+'\n');win?.destroy();app.exit(result.passed?0:1)}
})
