const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, owned, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(owned, 'user-data'))
app.setPath('sessionData', path.join(owned, 'session-data'))
const receipt = { passed: false, frames: [], interactions: [], boundary: 'Actual SettingsPanel, original settings modules and production CSS in isolated Electron. Controlled Preview API/configuration, no user App, Run, SSH or installation.' }
app.whenReady().then(async () => {
  const { fixturePath: _historyFixturePath } = await import("../../../../../test/fixture-values.mjs")
  let win
  const read = code => win.webContents.executeJavaScript(code)
  const until = async code => {
    const end = Date.now() + 10000
    while (Date.now() < end) { if (await read(code)) return; await new Promise(resolve => setTimeout(resolve, 25)) }
    throw Error('Timed out: ' + code)
  }
  const click = async selector => {
    const rect = await read(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if(!n)throw Error("Missing node"); n.scrollIntoView({block:"nearest"}); const r=n.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),width:r.width,height:r.height}; })()`)
    assert.ok(rect.width > 0 && rect.height > 0)
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x:rect.x, y:rect.y, button:'left', clickCount:1 })
    receipt.interactions.push({ kind:'trusted-click', selector })
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  const fill = async (selector,text) => {
    await click(selector); win.webContents.selectAll(); win.webContents.insertText(text)
    await until(`document.querySelector(${JSON.stringify(selector)}).value === ${JSON.stringify(text)}`)
    receipt.interactions.push({kind:'trusted-edit',selector,value:text})
  }
  const capture = async (name,width,height,theme) => {
    win.setSize(width,height)
    await read(`window.resourceLibraryProof.theme(${JSON.stringify(theme)})`)
    await new Promise(resolve=>setTimeout(resolve,100))
    if (await read(`document.querySelector('select[aria-label="Executor configuration scope"]').value !== 'host' && !!document.querySelector('[aria-label="Executor executable"]') && document.querySelector('[aria-label="Executor executable"]').getBoundingClientRect().width === 0`)) await click('[data-resource-row="executor-001"]')
    await read('[...document.querySelectorAll(".settings-executor-preview")].find(n => n.getBoundingClientRect().width > 0).scrollIntoView({block:"center"})')
    await new Promise(resolve=>setTimeout(resolve,180))
    assert.equal(await read('document.documentElement.scrollWidth > innerWidth'), false, 'No horizontal overflow')
    const file = name+'.png'
    fs.writeFileSync(path.join(evidence,file),(await win.webContents.capturePage()).toPNG())
    receipt.frames.push({file,name,width,height,requestedTheme:theme})
  }
  try {
    win = new BrowserWindow({ width:1440,height:940,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}})
    await win.loadFile(html)
    await until(`window.resourceLibraryProof?.ready && !!document.querySelector(${JSON.stringify('[aria-label="Executor executable"]')})`)
    await fill('[aria-label="Executor executable"]',_historyFixturePath("opt/Agent Tools/review-wrapper"))
    await fill('[aria-label="Executor arguments"]','--profile "code review" --note \'quote"value\' ""')
    await until('!!document.querySelector(".settings-executor-preview code")')
    assert.equal(await read(`document.querySelector(${JSON.stringify('[aria-label="Executor arguments"]')}).closest("details") === null`),true)
    await capture('global-wide',1440,940,'light')
    await capture('global-narrow',540,900,'dark')
    await fill('[aria-label="Executor arguments"]','--profile "unfinished')
    await until('document.querySelector(".settings-executor-preview").textContent.includes("Complete the argument quoting")')
    await capture('incomplete-arguments',540,900,'light')
    await fill('[aria-label="Executor arguments"]','--profile "code review" ""')
    await read(`(() => { const p=document.querySelector('select[aria-label="Executor configuration scope"]');p.value='host';p.dispatchEvent(new Event('change',{bubbles:true})); })()`)
    await until(`!!document.querySelector(${JSON.stringify('[aria-label="Host executors"]')})`)
    await click('[aria-label="Host executors"] .settings-pane-toolbar .small-button')
    await fill('[aria-label="Host Executor command"]',_historyFixturePath("opt/Remote Tools/runner"))
    await fill('[aria-label="Host Executor arguments"]','--label "two words" ""')
    await capture('host-registration',1100,940,'light')
    await capture('host-narrow',540,900,'dark')
    assert.deepEqual(await read('window.resourceLibraryProof.errors'),[])
    receipt.passed=true
  } catch(error) {
    receipt.failure={message:error.message,stack:error.stack}
    if(win)fs.writeFileSync(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())
  } finally {
    fs.writeFileSync(path.join(evidence,'render.json'),JSON.stringify(receipt,null,2))
    win?.destroy();app.exit(receipt.passed?0:1)
  }
})
