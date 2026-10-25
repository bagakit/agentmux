const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, privateRoot, evidence] = process.argv.slice(2)
const peopleOnly = process.argv.includes('--people-only')
app.setPath('userData', path.join(privateRoot, 'userData'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, images: [], operations: [] }
app.whenReady().then(async () => {
  let win
  try {
    Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 1080, height: 850, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html, { query: { workspacePath: path.join(privateRoot, 'workspace'), ...(peopleOnly ? { 'people-only': '1' } : {}) } })
    const read = script => win.webContents.executeJavaScript(script)
    const until = async script => { for (let i = 0; i < 180; i++) { if (await read(script)) return; await pause(30) }; throw Error('Expected original UI state: ' + script) }
    const click = async selector => {
      const rect = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing original control');n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 })
      await pause(80)
    }
    const capture = async (name, selector) => {
      await read(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start'})`); await pause(150)
      const facts = await read(`(()=>{const n=document.querySelector('[data-mote-private-chat]');return{overflow:n.scrollWidth>n.clientWidth,text:n.textContent,...privateChatPreview.facts()}})()`)
      assert.equal(facts.overflow, false); assert.deepEqual(facts.forbidden, []); assert.equal(facts.sessions, 0)
      assert.equal(facts.drafts['original-region'], 'An original unsent question stays here.')
      assert.equal(facts.drafts['second-region'], 'The other Mote keeps its own unsent draft.')
      await fs.writeFile(path.join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG())
      result.images.push(name + '.png'); result.operations.push({ name, ...facts })
    }
    await until(`!!window.privateChatPreview && document.querySelector('[data-mote-chat-saved="on"]') && document.querySelector('.mote-chat-activity')?.textContent.includes('interrupted')`)
    if (peopleOnly) {
      await click('.mote-private-chat__people > summary'); await until('document.querySelectorAll("[data-mote-chat-person]").length===2')
      await read('privateChatPreview.theme(false)'); await capture('people-wide-dark', '.mote-private-chat__people')
      const guest = '[data-mote-chat-person="original-guest-research-and-engineering-collaboration"]'
      await click(guest + ' .agent-connector-disclosure > summary')
      win.setContentSize(390,850); await until('innerWidth===390'); await read('privateChatPreview.theme(true)')
      await capture('people-identity-narrow-light', guest)
      assert.equal(await read('privateChatPreview.facts().reads.some(row=>row.method==="space.mote.chat.allocate"||row.method==="space.mote.chat.history")'), false)
      result.passed = true; return
    }
    await capture('activity-interrupted-wide-dark', '[data-mote-private-chat]')
    await click('.mote-private-chat__people > summary'); await until(`!!document.querySelector('[data-mote-chat-person]')`)
    assert.equal(await read(`privateChatPreview.facts().reads.some(r=>r.method==='space.mote.chat.history')`), false)
    await click('.mote-chat-person__history > summary'); await until(`document.querySelectorAll('[data-mote-chat-generation]').length===2`)
    await capture('person-conversations-wide-dark', '.mote-private-chat__people')
    await click('[data-mote-chat-generation="conversation-0"] .small-button'); await until(`!!document.querySelector('[data-input-mailbox-key]')`)
    await click('[data-input-mailbox-key] button'); await until(`!!document.querySelector('[data-original-input-waiting]')`)
    await capture('original-input-wide-dark', '.mote-chat-inputs')
    await click('[aria-label="Locate Agent original-private-agent in Focus"]')
    const focus = await read('privateChatPreview.facts().focus')
    assert.equal(focus.hostId, 'execution-host'); assert.equal(focus.agentSessionId, 'original-private-agent'); assert.equal(focus.pending, true)
    win.setContentSize(390, 850)
    await capture('original-input-narrow-dark', '.mote-chat-inputs')
    await read('privateChatPreview.theme(true)')
    await capture('activity-interrupted-narrow-light', '[data-mote-private-chat]')
    await read(`privateChatPreview.accepted()`); await click('[aria-label="Refresh private chat activity"]')
    await until(`document.querySelector('.mote-chat-activity').textContent.includes('Agent received')`)
    await capture('activity-received-narrow-light', '[data-mote-private-chat]')
    await click('[data-mote-chat-generation="conversation-0"] .small-button'); await until(`!document.querySelector('.mote-chat-inputs')`)
    await read(`privateChatPreview.history('unavailable')`)
    const refresh = `.mote-chat-history > .mote-chat-actions > button`
    await click(refresh); await until(`document.querySelector('.mote-chat-history').textContent.includes('Previously read')`)
    await capture('history-unavailable-retained-narrow-light', '.mote-chat-person__history')
    await read(`privateChatPreview.history('loading')`); await click(refresh)
    await until(`document.querySelector('.mote-chat-history').getAttribute('aria-busy')==='true'`)
    await capture('history-refreshing-retained-narrow-light', '.mote-chat-person__history')
    await read('privateChatPreview.finish()'); await until(`document.querySelector('.mote-chat-history').getAttribute('aria-busy')==='false'`)
    result.passed = true
  } catch (error) {
    result.error = { message: error.message, stack: error.stack }
    if (win) { result.failureState = await win.webContents.executeJavaScript('({text:document.body.textContent,facts:window.privateChatPreview?.facts()})').catch(() => null); await fs.writeFile(path.join(evidence, 'failed.png'), (await win.webContents.capturePage()).toPNG()) }
  } finally { await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2) + '\n'); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
