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
  for (let i=0;i<100 && !(await read('!!document.querySelector(".mote-current-work")'));i++) await pause(30)
  const click = async selector => { const r = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing real control');n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,x:Math.round(r.x),y:Math.round(r.y),button:'left',clickCount:1}); await pause(150) }
  const capture = async name => { await pause(150); const facts = await read(`(()=>{const n=document.querySelector('.mote-current-work');return {text:n.textContent,overflow:n.scrollWidth>n.clientWidth,...moteCompanion.facts()}})()`); assert.equal(facts.overflow,false); assert.equal(facts.drafts['original-region'],'An original unsent question stays here.'); assert.equal(facts.drafts['second-region'],'The other Mote keeps its own unsent draft.'); await fs.writeFile(path.join(evidence,name+'.png'),(await win.webContents.capturePage()).toPNG());result.images.push(name+'.png');result.operations.push({name,...facts}) }
  await read('moteWorkScenario("empty");moteCompanion.theme(false)');await capture('no-work-wide-dark')
  await read('moteWorkScenario("multiple")');await capture('multiple-goals-wide-dark')
  await click('[data-mote-goal="compare"] .mote-current-work__copy'); assert.equal(await read(`!!document.querySelector('[aria-label="Goal continuous progress"]')`),true); await capture('continuing-wide-dark')
  win.setContentSize(320,760);await read('moteCompanion.theme(true)');await capture('continuing-narrow-light')
  await read('moteWorkScenario("partial")');await capture('partial-result-narrow-light')
  await read('moteWorkScenario("unknown")');await click('[aria-label="Refresh this Mote’s goals"]');await capture('unknown-retains-work-narrow-light')
  assert.equal(await read(`document.querySelector('.mote-current-work').textContent.includes('temporarily unavailable')`),true)
  result.passed=true
 } catch(error) { result.error={message:error.message,stack:error.stack}; if(win)await fs.writeFile(path.join(evidence,'failed.png'),(await win.webContents.capturePage()).toPNG()) }
 finally { await fs.writeFile(path.join(evidence,'renderer-result.json'),JSON.stringify(result,null,2)+'\n');win?.destroy();app.exit(result.passed?0:1) }
})
