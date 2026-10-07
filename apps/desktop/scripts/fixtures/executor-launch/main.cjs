const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { quote, split } = require('shlex')
const { app, BrowserWindow } = require('electron')
const [html, owned, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(owned, 'user-data'))
app.setPath('sessionData', path.join(owned, 'session-data'))
const receipt = { passed: false, frames: [], interactions: [], boundary: 'Actual SettingsPanel/Picker, original modules and production CSS in isolated Electron with controlled Preview configuration. No user App, Run, SSH or installation.' }
app.whenReady().then(async () => {
  const { fixturePath: _historyFixturePath } = await import("../../../../../test/fixture-values.mjs")
  let win, draft
  const read = code => win.webContents.executeJavaScript(code)
  const until = async (code, label = code) => {
    const end = Date.now() + 10000
    while (Date.now() < end) { if (await read(code)) return; await new Promise(resolve => setTimeout(resolve, 25)) }
    throw Error('Timed out: ' + label)
  }
  const observe = () => read(`(() => {
    const visible = selector => [...document.querySelectorAll(selector)].find(n => n.getBoundingClientRect().width > 0)
    const command = visible('[aria-label="Executor executable"],[aria-label="Host Executor command"]')
    const args = visible('[aria-label="Executor arguments"],[aria-label="Host Executor arguments"]')
    const preview = visible('.settings-executor-preview')
    return {appearance:document.documentElement.dataset.appearance, command:command?.value, args:args?.value,
      preview:preview?.querySelector('code')?.textContent ?? null, hint:preview?.textContent ?? '',
      unavailable:visible('.agent-catalog__empty')?.textContent}
  })()`)
  const click = async selector => {
    const rect = await read(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if(!n)throw Error("Missing node"); n.scrollIntoView({block:"nearest"}); const r=n.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),width:r.width,height:r.height}; })()`)
    assert.ok(rect.width > 0 && rect.height > 0)
    for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,x:rect.x,y:rect.y,button:'left',clickCount:1})
    receipt.interactions.push({kind:'trusted-click',selector})
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  }
  async function draftMatches() {
    const actual = await observe()
    let expected = null
    try { expected = [draft.command, ...split(draft.args)].map(quote).join(' ') } catch {}
    return actual.command === draft.command && actual.args === draft.args && actual.preview === expected
  }
  const fill = async (selector,text,key) => {
    await click(selector)
    assert.equal(await read(`(() => { const node=document.querySelector(${JSON.stringify(selector)});node.focus();return document.activeElement===node; })()`),true,'Exact input owns keyboard focus')
    receipt.interactions.push({kind:'controlled-focus',selector})
    win.webContents.selectAll(); win.webContents.insertText(text)
    draft[key] = text
    const end = Date.now() + 10000
    while (!await draftMatches()) {
      if (Date.now() >= end) throw Error('Controlled draft/preview did not acknowledge native edit: ' + selector)
      await new Promise(resolve => setTimeout(resolve,25))
    }
    receipt.interactions.push({kind:'trusted-edit',selector,value:text})
  }
  const capture = async (name,width,height,theme,picker=false) => {
    win.setSize(width,height)
    await until('innerWidth === ' + width, 'Actual viewport resized')
    await read(`window.resourceLibraryProof.theme(${JSON.stringify(theme)})`)
    await until(`document.documentElement.dataset.appearance === ${JSON.stringify(theme)}`,'Actual theme applied')
    if (!picker) {
      if(await read(`document.querySelector('select[aria-label="Executor configuration scope"]').value !== 'host' && document.querySelector('[aria-label="Executor executable"]').getBoundingClientRect().width === 0`)) await click('[data-resource-row="executor-001"]')
      await read('[...document.querySelectorAll(".settings-executor-preview")].find(n=>n.getBoundingClientRect().width>0).scrollIntoView({block:"center"})')
      assert.equal(await draftMatches(),true,'Actual draft and preview match the intended scene')
    }
    await read('document.fonts.ready.then(() => true)')
    const observed = await observe()
    assert.equal(observed.appearance,theme)
    if(picker)assert.match(observed.unavailable,/Check their configuration and unavailable details, then refresh/)
    else assert.equal(await draftMatches(),true,'Draft still matches at capture boundary')
    assert.equal(await read('document.documentElement.scrollWidth > innerWidth'),false,'No horizontal overflow')
    const file=name+'.png'
    fs.writeFileSync(path.join(evidence,file),(await win.webContents.capturePage()).toPNG())
    receipt.frames.push({file,name,width,height,requestedTheme:theme,observed})
  }
  try {
    win=new BrowserWindow({width:1440,height:940,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}})
    await win.loadFile(html)
    await until(`window.resourceLibraryProof?.ready && !!document.querySelector(${JSON.stringify('[aria-label="Executor executable"]')})`)
    draft=await observe()
    await fill('[aria-label="Executor executable"]',_historyFixturePath("opt/Agent Tools/review-wrapper"),'command')
    await fill('[aria-label="Executor arguments"]','--profile "code review" --note \'quote"value\' ""','args')
    await capture('global-wide',1440,940,'light')
    await capture('global-narrow',540,900,'dark')
    await fill('[aria-label="Executor arguments"]','--profile "unfinished','args')
    await capture('incomplete-arguments',540,900,'light')
    await fill('[aria-label="Executor arguments"]','--profile "code review" ""','args')
    await read(`(() => { const p=document.querySelector('select[aria-label="Executor configuration scope"]');p.value='host';p.dispatchEvent(new Event('change',{bubbles:true})); })()`)
    await until(`!!document.querySelector(${JSON.stringify('[aria-label="Host executors"]')})`)
    await click('[aria-label="Host executors"] .settings-pane-toolbar .small-button')
    draft=await observe()
    await fill('[aria-label="Host Executor command"]',_historyFixturePath("opt/Remote Tools/runner"),'command')
    await fill('[aria-label="Host Executor arguments"]','--label "two words" ""','args')
    await capture('host-registration',1100,940,'light')
    await capture('host-narrow',540,900,'dark')
    await read('window.showUnavailableExecutors()')
    await until('!!document.querySelector(".agent-catalog__empty")')
    await click('.launcher-other-agents')
    await capture('all-unavailable',760,600,'light',true)
    assert.deepEqual(await read('window.resourceLibraryProof.errors'),[])
    receipt.passed=true
  } catch(error) {
    receipt.failure={message:error.message,stack:error.stack,observed:await observe().catch(String)}
    if(win)fs.writeFileSync(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())
  } finally {
    fs.writeFileSync(path.join(evidence,'render.json'),JSON.stringify(receipt,null,2))
    win?.destroy();app.exit(receipt.passed?0:1)
  }
})
