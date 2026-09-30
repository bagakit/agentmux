import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentProviderRegistry } from '@agentmux/core'
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'profile')); app.setPath('sessionData', path.join(privateRoot, 'session'))
const actual = { passed: false, pid: process.pid, controls: [], rendererMessages: [], frames: [], pages: 0, observations: 0, boundary: 'Private public FileStore/reader/observation and registered fixture IPC into compiled production Timeline. Typed UI identities are not physical healthy Runs, Native writer, ordinary App restart or installation.' }
let win, paused = false, release, pending = false
const now = Date.now(), subjects = [{ id: 'service-unavailable', label: 'Observed input updates' }, { id: 'service-frozen', label: 'Review message flow' }]
const store = new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'sessions.json'))
const paths = Object.fromEntries(subjects.map(subject => [subject.id, path.join(privateRoot, `${subject.id}.jsonl`)]))
const row = (id, native, text) => ({ uuid: id, type: 'user', sessionId: native, timestamp: new Date(now - 1800000).toISOString(), message: { role: 'user', content: text } })
for (const subject of subjects) {
  await fs.writeFile(paths[subject.id], JSON.stringify(row('original-input', `native-${subject.id}`, 'Keep the original input readable while reviewing the next update.')) + '\n')
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: subject.id, providerId: 'claude', executorId: 'private', hostId: 'local', workspacePath: privateRoot,
    run: { runId: `private-not-controlled-${subject.id}` }, retiredRuns: [], createdAt: now, updatedAt: now, hookBindingId: 'private', hookToken: 'private',
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: `native-${subject.id}`, transcriptPath: paths[subject.id] } })
}
const registry = new AgentProviderRegistry(), { observeSessionHistory: omitted, ...readOnly } = registry.get('claude')
const clients = { 'service-unavailable': new AgentMuxClient({ store, providers: [readOnly] }), 'service-frozen': new AgentMuxClient({ store }) }
for (const [id, client] of Object.entries(clients)) for (const name of ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status']) Reflect.get(client, 'kernel')[name] = () => { actual.controls.push({ id, name }); throw new Error(`No Runtime ${name}`) }
const lookup = reference => { assert.equal(reference.hostId, 'local'); const client = clients[reference.agentSessionId]; assert.ok(client); return client }
const handles = new Map(), durable = await fs.readFile(path.join(privateRoot, 'sessions.json'))
ipcMain.handle('focus-proof-initial', () => ({ now, path: privateRoot, subjects }))
ipcMain.handle('focus-proof-sources', () => clients['service-frozen'].sessionHistorySources())
ipcMain.handle('focus-proof-page', async (_, reference, options) => {
  actual.pages++; const page = await lookup(reference).sessionHistoryPage(reference.agentSessionId, options)
  if (paused) { pending = true; await new Promise(resolve => { release = resolve }); pending = false }
  return page
})
ipcMain.handle('focus-proof-observe', async (_, reference, id) => {
  actual.observations++
  const handle = await lookup(reference).observeSessionHistory(reference.agentSessionId, observation => win.webContents.send(`focus-proof-observation:${id}`, observation))
  handles.set(id, handle); return handle.source
})
ipcMain.on('focus-proof-unobserve', (_, id) => { handles.get(id)?.dispose(); handles.delete(id) })
ipcMain.handle('focus-proof-burst', async () => fs.appendFile(paths['service-frozen'], Array.from({ length: 91 }, (_, i) => JSON.stringify(row(`burst-${i}`, 'native-service-frozen', `Native update ${i + 1}.`))).join('\n') + '\n'))
ipcMain.handle('focus-proof-pause', () => { paused = true })
ipcMain.handle('focus-proof-release', () => { paused = false; release?.(); release = undefined })
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1000, height: 800, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, preload: path.join(privateRoot, 'preload.cjs') } })
    win.webContents.on('console-message', (_, level, message, line, source) => actual.rendererMessages.push({ level, message, line, source }))
    win.webContents.on('preload-error', (_, file, error) => actual.rendererMessages.push({ preload: file, error: String(error) }))
    await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    const js = expression => win.webContents.executeJavaScript(expression)
    const until = async expression => { const deadline = Date.now() + 12000; while (Date.now() < deadline) { const value = await js(expression); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)) } throw new Error(`Did not settle: ${expression}`) }
    const click = async selector => {
      const point = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw new Error('Missing target');const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      assert.equal(await js(`!!document.elementFromPoint(${point.x},${point.y})?.closest(${JSON.stringify(selector)})`), true, `Actual hit: ${selector}`)
      for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
    }
    const key = async () => { for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }) }
    const shot = async name => {
      await until(`(()=>{const n=document.querySelector('.recent-focus__message-preview'),s=n&&getComputedStyle(n),notice=document.querySelector('[data-input-observation-notice]');if(!n||!notice||s.visibility!=='visible'||Number(s.opacity)<.999||n.getAnimations().some(a=>a.playState==='running'))return false;const r=n.getBoundingClientRect(),t=notice.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&t.width>0&&t.height>0&&t.top>=r.top&&t.bottom<=r.bottom})()`)
      await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
      const state = await js(`(()=>{const panel=document.querySelector('.recent-focus__message-preview'),notice=document.querySelector('[data-input-observation-notice]'),header=document.querySelector('.recent-focus__header'),buttons=[...document.querySelectorAll('.recent-focus__input-actions button')];return{panel:panel.getBoundingClientRect().toJSON(),notice:notice.textContent,headerHeight:header.getBoundingClientRect().height,inputIds:[...document.querySelectorAll('[data-input-message-id]')].map(n=>n.dataset.inputMessageId),buttons:buttons.map(n=>({text:n.textContent,rect:n.getBoundingClientRect().toJSON(),disabled:n.disabled})),draft:document.querySelector('#original-draft').value}})()`)
      assert.equal(state.headerHeight, 28); assert.equal(state.draft, 'Keep the original draft'); assert.ok(state.inputIds.length > 0)
      const image = `${name}.png`; await fs.writeFile(path.join(evidence, image), (await win.webContents.capturePage()).toPNG())
      actual.frames.push({ image, width: await js('innerWidth'), state })
    }
    await until(`document.querySelector('[aria-label="Timeline meaning and coverage"]')?.textContent.includes('Updates paused')`)
    await click('[aria-label="View input records"]'); await until(`document.querySelector('[data-input-observation-notice]')?.textContent.includes('does not support automatic')`)
    await shot('unavailable-1000')
    win.setContentSize(640, 800); await until('innerWidth===640'); await shot('unavailable-640')
    await key(); await until('!document.querySelector(".recent-focus__message-preview")')
    await js(`focusProofSelect('service-frozen')`)
    await until(`document.querySelector('.recent-focus__lane [data-message-id]')?.dataset.messageId==='native:claude:native-service-frozen:original-input'`)
    await js('focusObservationProof.burst()')
    await until(`document.querySelector('[aria-label="Timeline meaning and coverage"]')?.textContent.includes('Updates paused')`)
    await click('[aria-label="View input records"]'); await until(`document.querySelector('[data-input-observation-notice]')?.textContent.includes('current reading window is kept')`)
    await click('[data-input-message-id]'); await until('!!document.querySelector("[data-input-preview-id]")')
    await shot('frozen-640')
    win.setContentSize(1000, 800); await until('innerWidth===1000'); await shot('frozen-1000')
    await js(`(()=>{const n=document.querySelector('[data-input-preview-id]');window.proofBody=n;const w=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);let t;while(t=w.nextNode()){if(t.textContent.includes('Keep the original input'))break}if(!t)throw new Error('Original text must be present');const r=document.createRange();r.setStart(t,1);r.setEnd(t,12);getSelection().removeAllRanges();getSelection().addRange(r);window.proofRange=r;window.proofText=getSelection().toString()})()`)
    await js('focusObservationProof.pause()'); const pagesBefore = actual.pages
    await click('.recent-focus__input-actions button:last-child')
    const deadline = Date.now() + 12000; while (!pending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(pending, true)
    actual.pending = await js(`({sameBody:document.querySelector('[data-input-preview-id]')===window.proofBody,sameRange:getSelection().rangeCount===1&&getSelection().getRangeAt(0)===window.proofRange,selection:getSelection().toString(),original:window.proofText})`)
    assert.equal(actual.pending.sameBody, true); assert.equal(actual.pending.sameRange, true); assert.equal(actual.pending.selection, actual.pending.original)
    paused = false; release?.(); release = undefined
    await until(`!document.querySelector('[data-input-observation-notice]')&&document.querySelectorAll('[data-input-message-id]').length===30`)
    assert.ok(actual.pages > pagesBefore); assert.equal(await js('document.querySelector("[data-input-preview-id]")===window.proofBody&&getSelection().getRangeAt(0)===window.proofRange'), true)
    assert.deepEqual(actual.controls, []); assert.deepEqual(await fs.readFile(path.join(privateRoot, 'sessions.json')), durable); actual.passed = true
  } catch (error) { if (win && !win.isDestroyed()) actual.failureDom = await win.webContents.executeJavaScript('({html:document.body.innerHTML,preload:!!window.agentmux,proof:!!window.focusObservationProof})'); actual.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
  finally {
    for (const handle of handles.values()) handle.dispose(); handles.clear(); for (const client of Object.values(clients)) await client.dispose()
    await fs.writeFile(path.join(evidence, 'scene.json'), JSON.stringify(actual, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(actual.passed ? 0 : 1)
  }
})
