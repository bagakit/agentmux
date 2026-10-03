const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'userData'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, pid: process.pid, images: [], operations: [], errors: [] }
app.whenReady().then(async () => {
 let win
 try {
  Menu.setApplicationMenu(null); win = new BrowserWindow({ width: 1080, height: 850, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
  await win.loadFile(html, { query: { workspacePath: path.join(privateRoot, 'workspace', '.agentmux', 'scratch') } })
  const read = code => win.webContents.executeJavaScript(code)
  for (let i=0;i<100 && !(await read('!!document.querySelector("[data-mote-details]")'));i++) await pause(30)
  const click = async selector => { const r = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing actual control: '+${JSON.stringify(selector)});n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,x:Math.round(r.x),y:Math.round(r.y),button:'left',clickCount:1}); await pause(130) }
  const clickText = async text => { await read(`(()=>{const n=[...document.querySelectorAll('button')].find(n=>n.textContent===${JSON.stringify(text)});if(!n)throw Error('missing named control');n.dataset.captureTarget='yes'})()`);await click('[data-capture-target="yes"]');await read('document.querySelector("[data-capture-target]")?.removeAttribute("data-capture-target")') }
  const type = async (selector,text) => { await click(selector);win.webContents.selectAll();win.webContents.insertText(text);await pause(130) }
  const capture = async name => {
    await pause(150)
    const facts = await read(`(()=>{const n=document.querySelector('[data-mote-details]');return {text:n.textContent,overflow:n.scrollWidth>n.clientWidth,...moteIdeaScene.facts(),originalDrafts:moteCompanion.facts().drafts}})()`)
    assert.equal(facts.overflow,false);assert.equal(facts.draft,'My later ordinary message stays editable.');assert.equal(facts.originalDrafts['original-region'],'An original unsent question stays here.');assert.equal(facts.originalDrafts['second-region'],'The other Mote keeps its own unsent draft.')
    await fs.writeFile(path.join(evidence,name+'.png'),(await win.webContents.capturePage()).toPNG());result.images.push(name+'.png');result.operations.push({name,...facts})
  }
  await read('moteCompanion.theme(false);moteCompanion.selectExactContext()');await pause(150);await read('moteIdeaScene.attachComposer()');await pause(150)
  await read(`window.originalComposerNode=document.querySelector('[data-original-composer] [contenteditable="true"], [data-original-composer] textarea')`)
  assert.equal(await read('!!originalComposerNode'),true)
  await click('[aria-label="View ideas and saved materials"]');await click('.mote-details__note');await capture('ideas-quiet-wide-dark')
  await click('.mote-details__idea-request > summary');await type('[aria-label="Idea direction"]','Find one useful small experiment for next week.');await click('[aria-label="Include exact discussion and linked Goals"]')
  await click('[aria-label="Arrange sourced ideas"]');assert.equal(await read('!!document.querySelector(".calendar-schedules form")'),true);await capture('idea-arrangement-wide-dark')
  win.setContentSize(320,760);await read('moteCompanion.theme(true)');await capture('idea-arrangement-narrow-light')
  await read('moteIdeaScene.loseReceipt()');await clickText('Save arrangement');await capture('idea-unknown-narrow-light')
  await clickText('Check original operation');assert.equal(await read(`document.querySelector('.calendar-schedules__notice').textContent.includes('retry uses the same request')`),true)
  await read('moteIdeaScene.confirmOriginal()');await clickText('Retry original operation')
  assert.equal(await read('JSON.stringify(moteIdeaScene.facts().calls.filter(x=>x.method==="schedule.create")[0].params)===JSON.stringify(moteIdeaScene.facts().calls.filter(x=>x.method==="schedule.create")[1].params)'),true)
  await capture('idea-saved-compact-narrow-light')
  win.setContentSize(1080,850);await read('moteCompanion.theme(false)');await capture('idea-saved-compact-wide-dark')
  await read('moteIdeaScene.unknownSaved()');await clickText('Check original arrangement');await capture('idea-saved-unknown-wide-dark')
  await click('.mote-details__idea-feedback > summary');await click('[aria-label="Useful"]');await type('[aria-label="Idea feedback comment"]','Keep the evidence and make the next experiment smaller.');await capture('idea-feedback-wide-dark')
  assert.equal(await read('originalComposerNode===document.querySelector("[data-original-composer] [contenteditable=true], [data-original-composer] textarea")'),true)
  assert.equal(await read('originalComposerNode.getAttribute("aria-disabled")!=="true" && !originalComposerNode.disabled'),true)
  result.passed=true
 } catch(error) { result.error={message:error.message,stack:error.stack};if(win)await fs.writeFile(path.join(evidence,'failed.png'),(await win.webContents.capturePage()).toPNG()) }
 finally { await fs.writeFile(path.join(evidence,'renderer-result.json'),JSON.stringify(result,null,2)+'\n');win?.destroy();app.exit(result.passed?0:1) }
})
