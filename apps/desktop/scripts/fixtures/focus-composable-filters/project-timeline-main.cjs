const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, ipcMain } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'profile')); app.setPath('sessionData', path.join(privateRoot, 'session'))
const result = { schema: 'agentmux.focus-project-timeline-actual.v1', passed: false, frames: [], operations: [], publicReads: [], rendererConsole: [], boundary: 'Actual App/ProjectRail/GlobalFocusSurface/Timeline/Reader, private Core FileStore and public Unix RPC through real Main IPC/preload. Sealed producer captured records, typed native Provider leaves and UI Run observations. No real Run, user Runtime, installation or restart proof.' }
app.on('window-all-closed', () => {})
let win, server, transport
const clients = []
app.whenReady().then(async () => {
 try {
  const owner = await import(pathToFileURL(path.join(path.dirname(html), 'conversation-owner.mjs')).href)
  ipcMain.handle('project-timeline:seed', async (_event, input) => {
    assert.equal(clients.length, 0, 'Seed this private owner once')
    const store = new owner.AgentMuxFileAgentSessionStore(path.join(privateRoot, 'original-sessions.json'))
    const client = new owner.AgentMuxClient({ store }); clients.push(client)
    const sourceFor = id => ({ ...input.nativePage.source, nativeSessionId: id === input.captured.agentSessionId ? input.nativePage.source.nativeSessionId : input.nativePage.source.nativeSessionId + '-' + id })
    const byId = new Map(input.sessions.map(session => [session.id, session]))
    client.sessionHistoryPage = async id => ({ ...input.nativePage, agentSessionId: id, source: sourceFor(id), items: [], changesCursor: 'project-timeline-native-cut' })
    client.sessionHistoryCheckpoint = async id => ({ agentSessionId: id, source: sourceFor(id), cursor: 'project-timeline-native-cut' })
    client.readSessionHistoryChanges = async id => ({ hostId: 'local', agentSessionId: id, source: sourceFor(id), items: [], checkpoint: { agentSessionId: id, source: sourceFor(id), cursor: 'project-timeline-native-cut' }, more: false })
    client.observeSessionHistory = async () => { throw Object.assign(Error('This sealed native snapshot has no automatic Provider observer; Refresh remains available.'), { code: 'AGENT_SESSION_HISTORY_OBSERVATION_UNSUPPORTED' }) }
    for (const session of input.sessions) await store.compareAndSwap(null, { kind: 'agent', agentSessionId: session.id, hostId: 'local', providerId: input.nativePage.source.providerId, executorId: input.nativePage.source.providerId,
      workspacePath: session.workspacePath, run: session.control.run, retiredRuns: [], createdAt: session.createdAt, updatedAt: session.updatedAt, hookBindingId: 'project-timeline-reading', hookToken: 'private-project-timeline', nativeHandle: { kind: 'provider', providerId: input.nativePage.source.providerId, sessionId: sourceFor(session.id).nativeSessionId } })
    assert.ok(byId.has(input.captured.agentSessionId))
    for (const item of input.captured.items) await Reflect.get(client, 'persistAndPublishTimeline').call(client, { type: 'append', agentSessionId: input.captured.agentSessionId, item }, { source: 'agentmux', observedAt: item.updatedAt }, 'local')
    server = new owner.AgentMuxControlServer({ socketPath: path.join(privateRoot, 'conversation.sock'), coreClients: () => [{ hostId: 'local', client }] }); await server.start()
    transport = owner.registerConversationReadIpc({ handle(channel, handler) { ipcMain.handle(channel, async (...args) => { result.publicReads.push({ channel, input: args[2] }); return handler(...args) }) }, connect: () => owner.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }) })
    return { seeded: true, captured: input.captured.items.length }
  })
  ipcMain.handle('project-timeline:facts', () => ({ reads: result.publicReads.length }))
  win = new BrowserWindow({ width: 1440, height: 960, show: false, webPreferences: { preload: path.join(path.dirname(html), 'preload.cjs'), contextIsolation: true, sandbox: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, message) => { if (level > 1) result.rendererConsole.push(message) })
  const read = code => { try { new vm.Script(code) } catch (error) { result.failedEvaluation = code; throw error }; return win.webContents.executeJavaScript(code) }
  const until = async (label, check) => { for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await new Promise(done => setTimeout(done, 25)) } throw Error('Did not settle: ' + label) }
  const settle = () => read('Promise.all([document.fonts.ready,...document.getAnimations().filter(a=>a.playState==="running"&&a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))]).then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))')
  const target = async selector => { await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return;const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;const visible=r.width>0&&r.height>0&&x>=0&&x<innerWidth&&y>=0&&y<innerHeight&&n.contains(document.elementFromPoint(x,y));if(!${Boolean(process.env.AGENTMUX_TIMELINE_IDENTITIES)}||!visible)n.scrollIntoView({block:'nearest',inline:'nearest'})})()`); await settle(); return read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing exact target '+${JSON.stringify(selector)});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`) }
  const move = async selector => { result.operations.push({ type: 'native-mouse-move', selector }); const point = await target(selector); assert.equal(point.hit, true, 'Hit target ' + selector); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }); return point }
  const click = async selector => { const point = await move(selector); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }); result.operations.push({ type: 'native-click', selector }); await settle() }
  const key = async (key, modifiers = 0) => { result.operations.push({ type: 'native-key', key, ...(modifiers ? { modifiers } : {}) }); for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code: key, modifiers, ...(key === 'Enter' && type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}), windowsVirtualKeyCode: { Escape: 27, Tab: 9, Enter: 13, Home: 36, End: 35, ArrowLeft: 37, ArrowRight: 39 }[key] ?? 0 }); await settle() }
  const state = () => read('projectTimelineProof.state()')
  const scope = expected => until('exact scope ' + expected, async () => JSON.stringify((await state()).scope) === JSON.stringify(expected))
  const shot = async (file, label) => { await settle(); const geometry = await read(`(()=>{const box=n=>n?.getBoundingClientRect().toJSON()??null;return{openDialog:!!document.querySelector('[role="dialog"]'),viewport:{width:innerWidth,height:innerHeight},app:box(document.querySelector('.app-shell')),rail:box(document.querySelector('.project-rail')),timeline:box(document.querySelector('.recent-focus')),popup:box(document.querySelector('.recent-focus__context-preview,.recent-focus__message-preview,.focus-timeline-event-preview')),scopeControl:box(document.querySelector('.recent-focus [data-focus-project-scope-control]')),scopeLabel:(()=>{const n=document.querySelector('.recent-focus__scope');if(!n)return null;const r=n.getBoundingClientRect();let left=Math.max(0,r.left),right=Math.min(innerWidth,r.right);for(let p=n.parentElement;p;p=p.parentElement){if(/hidden|clip|auto|scroll/.test(getComputedStyle(p).overflowX)){const b=p.getBoundingClientRect();left=Math.max(left,b.left);right=Math.min(right,b.right)}}return{...r.toJSON(),visibleWidth:Math.max(0,right-left),hit:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),text:n.textContent}})(),scrollX,scrollY}})()`); await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file, label, geometry, state: await state() }); if (geometry.timeline?.height > 0 && geometry.scopeLabel) { assert.ok(geometry.scopeLabel.visibleWidth >= 40, 'Readable project scope: ' + file); if (!geometry.openDialog) assert.equal(geometry.scopeLabel.hit, true, 'Reachable project scope: ' + file) } }
  await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await until('actual fixture App ready', () => read('window.projectTimelineProof?.ready&&!!document.querySelector("button.surface-navigation__focus")'))
  await read('projectTimelineProof.enter()'); await click('.project-rail-row[data-workspace-id="timeline-checkout"]'); if (!process.env.AGENTMUX_TIMELINE_IDENTITIES) await shot('project-rail-alpha.png', 'Actual ProjectRail chooses the original Alpha worktree resource'); await click('button.surface-navigation__focus')
  const alphaKey = await read('projectTimelineProof.alphaKey'), betaKey = await read('projectTimelineProof.betaKey'), emptyKey = await read('projectTimelineProof.emptyKey')
  await scope([alphaKey]); await until('public conversation aggregate', () => read('!!document.querySelector(".recent-focus__message--group")'))
  result.initial = await state(); assert.equal(result.initial.activeWorkspaceId, 'timeline-checkout'); assert.ok(result.initial.projects.every(project => project === alphaKey))
  if (process.env.AGENTMUX_TIMELINE_IDENTITIES) {
    await require('./timeline-identity-scene.cjs')({ win, result, read, until, settle, move, click, key, state, shot, scope })
  } else {
  for (const theme of ['dark', 'light']) { await read(`projectTimelineProof.theme(${JSON.stringify(theme)})`); for (const width of [1440, 420, 320]) { win.setContentSize(width, 960); await settle(); await shot(`${theme}-follow-alpha-${width}.png`, 'Full App follows original Alpha Project and its worktree') } }
  win.setContentSize(320, 960); await settle()
  await click('.recent-focus [aria-label="Show all timeline projects"]'); await scope([])
  await click('.recent-focus [aria-label="Follow selected project"]'); await scope([alphaKey])
  for (const label of ['Focus history date and time', 'Return to current focus window']) {
    let reached = false
    for (let step = 0; step < 30; step++) { await key('Tab'); reached = await read(`document.activeElement===document.querySelector(${JSON.stringify('[aria-label="' + label + '"]')})`); if (reached) break }
    assert.equal(reached, true, 'Native Tab reaches narrow ' + label)
    const box = await target('[aria-label="' + label + '"]'); assert.equal(box.hit, true, 'Narrow focused control is visible ' + label)
  }
  await key('Enter'); await scope([alphaKey]); await shot('narrow-keyboard-now.png', 'At 320px scope toggle works and native Tab scrolls Date and Now into view')
  win.setContentSize(1440, 960); await read('projectTimelineProof.theme("dark")'); await settle()
  const recipient = await read('projectTimelineProof.recipient'), other = await read('projectTimelineProof.other')
  const liveName = `[data-focus-timeline-id="${recipient}"]:not([data-history-only]) .agent-avatar--inline`
  const beforeHover = await state(), readsBeforeHover = result.publicReads.length
  await move(liveName); await until('passive original task details', () => read('!!document.querySelector(".recent-focus__context-preview")')); await shot('name-hover.png', 'One original inline name/avatar disclosure without selection')
  assert.deepEqual((await state()).focus, beforeHover.focus); assert.deepEqual((await state()).selection, beforeHover.selection); assert.equal(result.publicReads.length, readsBeforeHover)
  await move('.focus-toolbar'); await key('Escape')
  const group = '.recent-focus__message--group'
  const beforeGroup = await state(), readsBeforeGroup = result.publicReads.length
  await move(group); await until('aggregate passive detail', () => read('!!document.querySelector(".recent-focus__event-preview")')); await shot('aggregate-hover.png', 'Aggregate summary uses already-read records without selecting a first record')
  assert.deepEqual((await state()).focus, beforeGroup.focus); assert.equal(result.publicReads.length, readsBeforeGroup)
  await move('.focus-toolbar'); await key('Escape')
  await click('[aria-label^="Space: show"]'); await until('real ProjectRail Beta', () => read(`!!document.querySelector(${JSON.stringify('.project-rail-row[data-workspace-id="timeline-beta"]')})`)); await click('.project-rail-row[data-workspace-id="timeline-beta"]'); await shot('project-rail-beta.png', 'Actual App ProjectRail chooses the original Beta resource'); await click('button.surface-navigation__focus'); await scope([betaKey]); await shot('follow-beta.png', 'Real left ProjectRail selection follows Beta only')
  assert.ok((await state()).projects.every(project => project === betaKey))
  await click(`[data-focus-timeline-id="${other}"]:not([data-history-only]) .agent-avatar--inline`); await until('name click selects original Beta Context', async () => (await state()).focus.execution.sessionId === other); await shot('name-click-selected.png', 'Click the original name selects its accurate Context')
  await click('.recent-focus [aria-label="Show all timeline projects"]'); await scope([]); assert.ok((await state()).projects.includes(JSON.stringify(['remote-proof', 'timeline-alpha']))); await shot('all-projects.png', 'All projects includes retained remote and unknown project identities')
  const historyName = `[data-focus-timeline-id="${recipient}"][data-history-only] .agent-avatar--inline`
  const beforeHistory = await state(); await click(historyName); await shot('history-only-inspection.png', 'Historical same-ID remote Host remains read-only')
  assert.deepEqual((await state()).focus, beforeHistory.focus); assert.deepEqual((await state()).calls, beforeHistory.calls)
  await key('Escape'); await move('[data-focus-timeline-id="unrecorded-agent"] .agent-avatar--inline'); await until('unknown historical identity disclosure', () => read('!!document.querySelector(".recent-focus__context-preview")')); await shot('unknown-history.png', 'Missing historical project and identity remain explicitly unknown'); assert.deepEqual((await state()).focus, beforeHistory.focus); await key('Escape'); await click(group)
  const choices = '[aria-label="Available conversation records"] button'
  await until('fixed aggregate reader', () => read(`document.querySelectorAll(${JSON.stringify(choices)}).length>1`))
  assert.equal((await state()).focus.execution.sessionId, recipient)
  const choiceIds = await read(`[...document.querySelectorAll(${JSON.stringify(choices)})].map(n=>n.dataset.conversationRecordId)`)
  for (const id of choiceIds) { await click(`[data-conversation-record-id="${await read(`CSS.escape(${JSON.stringify(id)})`)}"]`); await until('selected exact record body', () => read(`document.querySelector('.recent-focus__message-body')?.dataset.recordPreviewId===${JSON.stringify(id)}`)) }
  await shot('aggregate-reader-selected.png', 'Original records remain individually selectable while accurate current recipient is selected')
  await key('Escape'); await click('.recent-focus [aria-label="Follow selected project"]'); await scope([alphaKey])
  await click('[aria-label^="Space: show"]'); await click('.project-rail-row[data-workspace-id="timeline-empty"]'); await click('button.surface-navigation__focus'); await scope([emptyKey]); await until('project empty state', () => read('!!document.querySelector(".recent-focus__empty")')); await shot('empty-project.png', 'Empty project keeps an honest scoped empty state')
  await click('[aria-label="Focus filters"]'); await until('actual project filter', () => read(`!!document.querySelector(${JSON.stringify(`[data-focus-project='${alphaKey}']`)})`)); await click(`[data-focus-project='${alphaKey}']`); await key('Escape'); await scope([alphaKey]); await shot('explicit-project-filter.png', 'Explicit Focus project condition overrides the left Empty project')
  }
  result.final = await state(); assert.equal(result.final.sameDrafts, true); assert.equal(result.final.sameRuns, true); assert.ok(Object.values(result.final.calls).every(count => count === 0)); assert.ok(result.final.events.every(event => event.trusted))
  assert.ok(result.publicReads.some(read => read.channel === 'conversation:inspect')); result.passed = true
 } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) { result.current = await win.webContents.executeJavaScript('window.projectTimelineProof?.state?.()??null').catch(() => null); await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) } }
 finally { await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); try { await transport?.dispose(); await server?.stop(); for (const client of clients) await client.dispose() } catch (error) { result.cleanupError = error.message; result.passed = false } await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n'); app.exit(result.passed ? 0 : 1) }
})
