import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, type WebContentsView } from 'electron'
import { AgentMuxFileAgentSessionStore, connectLocalAgentMux, connectHostedAgentMux, connectAgentMuxRpc } from '@agentmux/core'
import { AgentMuxControlServer } from '../../../../../packages/core/src/public-rpc-server'
import { AgentMuxHostedRuntimeService } from '../../../../../packages/core/src/hosted-runtime-service'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { registerIpc } from '../../../src/main/ipc'
import { ConfigStore, DEFAULT_CONFIG } from '../../../src/main/config-store'
import { ScratchTopics } from '../../../src/main/scratch-topics'
import { WorkbenchWindows } from '../../../src/main/workbench-windows'
import { WorkbenchWindowStore } from '../../../src/main/workbench-window-store'
import { WorkbenchUserStateStore } from '../../../src/main/workbench-user-state'
import { createDesktopApplicationAccessOwner } from '../../../src/main/application-access-owner'
import { desktopBusinessSocketPath } from '../../../src/main/desktop-host'

const directory = process.env.AGENTMUX_HANDOFF_ROOT!, source = process.env.AGENTMUX_HANDOFF_SOURCE!, phase = process.env.AGENTMUX_HANDOFF_PHASE!
assert.ok(directory && source && ['first', 'restart'].includes(phase), 'The proof needs an exact private owner and phase')
app.on('window-all-closed', () => {})
const receipt: any = { schema: 'agentmux.browser-agent-handoff.native.v1', phase, passed: false, pid: process.pid, versions: process.versions,
  cases: [], cli: [], ipc: [], frames: [], independentVisualReview: 'not-performed', physicalInputQualified: false,
  boundary: 'Test-owned Core Sessions over real ctxmux with repository fake CLI (no upstream model), production sandbox preload/Main/Browser/Renderer, current-source public CLI, private saved data and second-process restore.' }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until<T>(read: () => Promise<T> | T, label: string, budget = 15000): Promise<T> {
  const deadline = Date.now() + budget
  do { const value = await read(); if (value) return value; await delay(30) } while (Date.now() < deadline)
  throw new Error('Private Browser handoff observation did not confirm: ' + label)
}
let window: BrowserWindow | undefined, core: any, sdk: any, rpc: any, hosted: any, hostServer: any, runtime: RuntimeController | undefined,
  releaseIpc: (() => Promise<void>) | undefined, windows: WorkbenchWindows | undefined, access: any
const sessions: any[] = []
async function cli(args: string[], code = '', actor?: string): Promise<any> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
  Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: join(directory, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: join(directory, 'sessions.json') })
  if (actor) {
    const credential = JSON.parse(await readFile(join(directory, actor + '-credential.json'), 'utf8'))
    Object.assign(env, { AGENTMUX_AGENT_SESSION_ID: credential.agentSessionId, AGENTMUX_AGENT_CAPABILITY: credential.capability })
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(process.env.AGENTMUX_HANDOFF_NODE!, [process.env.AGENTMUX_HANDOFF_CLI!, '--endpoint', 'unix:' + desktopBusinessSocketPath(), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Private CLI observation did not complete')) }, 25000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      try { const raw = stdout.trim() || stderr.trim(), value = JSON.parse(raw)
        receipt.cli.push({ args, actor: actor ?? 'person', code, value }); resolve({ code, value })
      } catch { reject(new Error('Private CLI returned no original JSON receipt: ' + stdout + stderr)) }
    })
    child.stdin.end(code)
  })
}
async function run() {
  await app.whenReady()
  if (phase === 'first') {
    // Initial test configuration, not recovered user data. Every Notes owner in the
    // complete App initialization must resolve this private location, never the user's home.
    await mkdir(join(directory, 'state'), { recursive: true })
    await writeFile(join(directory, 'state/notes-location.json'), JSON.stringify({ schemaVersion: 1,
      directory: join(directory, 'notes'), operations: {}, pending: null }) + '\n')
  }
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  core = await connectLocalAgentMux({ store })
  if (phase === 'first') for (const [name, label] of [['a', 'Researcher A'], ['b', 'Reviewer B']]) {
    const session = await core.createAgent({ agentSessionId: 'handoff-agent-' + name, createOperationId: 'handoff-create-' + name,
      providerId: 'codex', executorId: 'handoff-codex-' + name, workspacePath: directory,
      commandOverride: join(source, 'packages/core/test/fixtures/fake-codex-cli.mjs'), injectAgentMuxGuide: false,
      env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1',
        AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(directory, 'native-records'), AGENTMUX_FAKE_CAPABILITY_RECEIPT: join(directory, name + '-credential.json') } })
    sessions.push(session)
  }
  else {
    const saved = JSON.parse(await readFile(join(directory, 'first-receipt.json'), 'utf8'))
    for (const original of saved.coreIdentities) {
      const current = core.agentSession(original.agentSessionId)
      assert.equal(current.agentSessionId, original.agentSessionId); assert.equal(current.run.runId, original.runId, 'Reconnect keeps the original healthy Run')
      sessions.push(current)
    }
  }
  receipt.coreIdentities = sessions.map(item => ({ agentSessionId: item.agentSessionId, runId: item.run.runId }))
  const identity = { runtimeId: randomUUID(), ownerInstanceId: randomUUID(), protocolVersion: 2, processId: process.pid, availability: 'connected' as const }
  hosted = new AgentMuxHostedRuntimeService(core, join(directory, 'sessions.json'), () => ({ ...identity, ctxmux: core.runtimeIdentity() }))
  const socket = join(directory, 'semantic.sock')
  hostServer = new AgentMuxControlServer({ socketPath: socket, coreClients: () => [{ hostId: 'local', client: core }], hostedRuntime: () => hosted })
  await hostServer.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
  sdk = await connectHostedAgentMux({ rpc, subscribeRpc: rpc.subscribe.bind(rpc),
    forwardRpc: (method, params, context, expectedOwner) => rpc.call(method, params, {
      ...(context.signal ? { signal: context.signal } : {}), ...(context.caller ? { credentials: context.caller } : {}),
      ...(expectedOwner ? { runtimeFence: expectedOwner } : {}) }) })
  runtime = new RuntimeController(store, async () => sdk)
  const configStore = new ConfigStore(join(directory, 'config.json'))
  const initial = { ...structuredClone(DEFAULT_CONFIG), hosts: [{ id: 'local', kind: 'local' as const, label: 'Private Browser handoff' }],
    workspaces: [{ id: 'handoff-workspace', name: 'Browser collaboration', kind: 'folder' as const, hostId: 'local', path: directory }],
    executors: Object.fromEntries([['a', 'Researcher A'], ['b', 'Reviewer B']].map(([name, label]) => ['handoff-codex-' + name,
      { providerId: 'codex', label, command: join(source, 'packages/core/test/fixtures/fake-codex-cli.mjs'), args: [],
        env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1', AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(directory, 'native-records') },
        injectAgentMuxGuide: false }])),
    browser: { ...DEFAULT_CONFIG.browser, agentAutomation: true, agentControl: { ...DEFAULT_CONFIG.browser.agentControl, showDiscussion: false } } }
  const config = phase === 'first' ? await configStore.save(initial as any) : await configStore.get()
  window = new BrowserWindow({ width: 1120, height: 760, show: false, title: 'Browser collaborators · private proof',
    webPreferences: { preload: join(directory, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const contents = window.webContents
  contents.on('console-message', (event: any) => { if (event.level === 'error') console.error('Handoff Renderer:', event.message) })
  windows = new WorkbenchWindows(window, new WorkbenchWindowStore(join(directory, 'windows.json')), () => [{ x: 0, y: 0, width: 1600, height: 1000 }])
  access = createDesktopApplicationAccessOwner(runtime, join(directory, 'application-access.sqlite'))
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, handler) => handle(channel, async (event, ...args) => {
    const selected = ['browser:returnControl', 'browser:takeControl', 'spatial:commit', 'ui:writeWorkbenchUserState',
      'sessions:launchAgent', 'sessions:submitPrompt', 'sessions:inspectInput'].includes(channel)
    const fact: any = selected ? { channel, exactSender: event.sender === contents, exactFrame: event.senderFrame === contents.mainFrame, args } : null
    if (fact) receipt.ipc.push(fact)
    try { const value = await handler(event, ...args); if (fact) fact.result = value; return value }
    catch (error) { if (fact) fact.error = String(error); throw error }
  })
  releaseIpc = await registerIpc({ appDocumentSources: () => ({ current: { mode: 'prod', filePath: join(directory, 'renderer/index.html') }, loading: null }),
    window, workbenchWindows: windows, initialConfig: config, configStore, runtime, applicationAccess: access,
    workbenchUserState: new WorkbenchUserStateStore(join(directory, 'workbench-user-state.json')), scratchTopics: new ScratchTopics() })
  await window.loadFile(join(directory, 'renderer/index.html')); window.showInactive()
  const evaluate = (expression: string) => contents.executeJavaScript(expression)
  await until(() => evaluate('Boolean(window.browserHandoffFixture)'), 'actual Renderer entry')
  const snapshots = await Promise.all(sessions.map(session => runtime!.refresh({ kind: 'agent', hostId: 'local', agentSessionId: session.agentSessionId, run: session.run }, config)))
  let browser: any
  if (phase === 'first') {
    const url = process.env.AGENTMUX_HANDOFF_PAGE_URL!
    assert.equal(new URL(url).hostname, '127.0.0.1', 'Only the private driver-owned origin is consumed')
    browser = await evaluate(`window.agentmux.browser.create('handoff-browser',${JSON.stringify(url)},'handoff-workspace')`)
  }
  receipt.setup = await evaluate(`browserHandoffFixture.setup(${JSON.stringify({ phase, config, browser, sessions: snapshots, candidateCount: phase === 'first' ? 0 : undefined, theme: 'dark' })})`)
  const facts = () => evaluate('browserHandoffFixture.inspect()')
  await until(async () => (await facts()).browser, 'original mounted BrowserPane')
  const settled = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  contents.debugger.attach('1.3')
  const click = async (label: string) => {
    const found = await until(() => evaluate(`(()=>{const element=[...document.querySelectorAll('button,[role="menuitem"]')].find(node=>node.getAttribute('aria-label')===${JSON.stringify(label)}||node.textContent.trim()===${JSON.stringify(label)}||node.querySelector('strong')?.textContent===${JSON.stringify(label)});if(!element)return false;const r=element.getBoundingClientRect();if(!r.width||!r.height)return false;return{tag:element.tagName,label:element.getAttribute('aria-label'),text:element.textContent,x:r.x+r.width/2,y:r.y+r.height/2}})()`), 'actual UI action ' + label)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type, x: found.x, y: found.y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) })
    receipt.cases.push({ action: label, target: found }); await settled()
  }
  const selectByTyping = async (label: string, text: string) => {
    await evaluate(`(()=>{const select=[...document.querySelectorAll('.confirmation-dialog__field')].find(node=>node.textContent.startsWith(${JSON.stringify(label)}))?.querySelector('select');if(!select)throw Error('Original select absent');select.focus();globalThis.handoffSelectChanges??=[];select.addEventListener('change',event=>globalThis.handoffSelectChanges.push({label:${JSON.stringify(label)},value:select.value,trusted:event.isTrusted}),{once:true})})()`)
    for (const key of text) await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', key, text: key, unmodifiedText: key })
    const changes = await evaluate('globalThis.handoffSelectChanges')
    assert.ok(changes.some((item: any) => item.label === label && item.trusted), 'Native select consumes trusted Chromium typeahead')
    receipt.cases.push({ action: 'Native select typeahead', label, text, changes })
  }
  const creationTask = '  Observe the extra page and report its title once.'
  const enterCreationOptions = async (task: string, selectExecutor = false) => {
    const trigger = (await facts()).buttons.find((item: any) => item.label?.startsWith('Browser activity:')).label
    await click(trigger); await click('New Agent options…')
    await until(() => evaluate('document.querySelector("textarea")?.getAttribute("aria-label") === "Task for new Browser Agent"'), 'real creation options Task field')
    await evaluate('document.querySelector("textarea").focus()')
    await contents.debugger.sendCommand('Input.insertText', { text: task })
    if (selectExecutor) await selectByTyping('Executor', 'reviewer')
    await selectByTyping('Open next to this page', 'b'); await settled()
  }
  const originalIdentity = async () => {
    const value = await facts()
    return { browserId: value.browser.browserId, tabId: value.tab.id, regionId: value.browser.regionId,
      agentSessionId: value.browser.control?.agent?.agentSessionId, draftText: value.draft?.text,
      draftAgentSessionId: value.draft?.original?.control?.agentSessionId,
      draftRunId: value.draft?.original?.control?.run?.runId, creationDraft: value.creationDraft,
      layout: value.layout, tabLayout: value.tab.layout }
  }
  const capture = async (name: string) => {
    await settled(); await delay(80)
    const image = await window!.capturePage(), file = phase + '-' + name + '.png'
    assert.equal(image.isEmpty(), false)
    await writeFile(join(directory, file), image.toPNG())
    receipt.frames.push({ file, pixels: image.getSize(), actualWindow: window!.getBounds(),
      nativeOwners: window!.contentView.children.filter(view => (view as WebContentsView).webContents && !(view as WebContentsView).webContents.isDestroyed()).map(view => ({
        webContentsId: (view as WebContentsView).webContents.id, url: (view as WebContentsView).webContents.getURL(), visible: view.getVisible(), bounds: view.getBounds() })),
      dialog: await evaluate('(()=>{const node=document.querySelector("[role=dialog]");return node?{title:node.getAttribute("aria-labelledby"),bounds:node.getBoundingClientRect().toJSON()}:null})()'),
      boundary: 'Complete main Renderer capturePage; native WebContentsView and OS composition are not included. Native page capture is recorded separately.', facts: await facts() })
  }
  const originalPage = () => until(() => window!.contentView.children.find(view =>
    (view as WebContentsView).webContents?.getURL() === process.env.AGENTMUX_HANDOFF_PAGE_URL) as WebContentsView | undefined, 'exact original native Browser page')
  const captureNativePage = async () => {
    const page = await originalPage()
    await until(() => page.webContents.executeJavaScript('document.querySelector("input")?.getAttribute("aria-label") === "Original page draft"'), 'original page loaded at saved URL')
    receipt.originalPage = await page.webContents.executeJavaScript('({url:location.href,title:document.title,input:document.querySelector("input").value})')
    assert.equal(receipt.originalPage.url, process.env.AGENTMUX_HANDOFF_PAGE_URL)
    assert.equal(receipt.originalPage.title, 'Original Browser workface')
    assert.equal(receipt.originalPage.input, 'Keep this page input')
    const image = await page.webContents.capturePage(), file = phase + '-native-original-page.png'
    assert.equal(image.isEmpty(), false); await writeFile(join(directory, file), image.toPNG())
    const bounds = page.getBounds(), visible = page.getVisible()
    assert.equal(visible, true, 'The exact original native page remains presented')
    assert.ok(bounds.width > 0 && bounds.height > 0, 'The original native page has positive presentation geometry')
    receipt.frames.push({ file, pixels: image.getSize(), bounds, visible, boundary: 'Exact native WebContentsView capturePage at recorded window geometry. Renderer chrome, shield and physical OS composition are not included.' })
  }
  if (phase === 'restart') {
    await until(async () => (await facts()).browser?.control?.agent?.agentSessionId === 'handoff-agent-b', 'the original native owner publishes the saved B association')
    receipt.recoveredIdentity = await originalIdentity()
    assert.equal(receipt.recoveredIdentity.browserId, 'handoff-browser')
    assert.equal(receipt.recoveredIdentity.tabId, 'handoff-tab')
    assert.equal(receipt.recoveredIdentity.agentSessionId, 'handoff-agent-b')
    assert.equal(receipt.recoveredIdentity.creationDraft?.prompt, 'Keep this unsent Browser task')
    assert.equal(receipt.recoveredIdentity.creationDraft?.browserAgent?.split, 'down')
    await captureNativePage()
    await click('Message Browser operator')
    await until(() => evaluate('document.querySelector(".browser-contextual-composer textarea")?.value === "Keep this original opinion"'), 'original A draft visibly restored')
    await capture('original-restored')
    receipt.discovery = await cli(['browser', 'targets', '--workspace', 'handoff-workspace'])
    assert.equal(receipt.discovery.code, 0)
    const restored = receipt.discovery.value.result.targets.find((item: any) => item.id === 'handoff-browser')
    assert.equal(restored.control.agent.agentSessionId, 'handoff-agent-b')
    // Additional test-owned resources are created only after original recovery
    // was proven. None of the first process's saved identities are reseeded.
    await click('Close discussion')
    const creationBrowser = await evaluate(`window.agentmux.browser.create('handoff-create-browser',${JSON.stringify(process.env.AGENTMUX_HANDOFF_PAGE_URL + '?scene=creation')},'handoff-workspace')`)
    await evaluate(`browserHandoffFixture.showCreationScene({browser:${JSON.stringify(creationBrowser)}})`); await settled()
    const creationFacts = () => evaluate('browserHandoffFixture.inspectCreation()')
    await enterCreationOptions(creationTask, true)
    await until(async () => { const draft = (await creationFacts()).creationDraft; return draft?.browserAgent?.executorId === 'handoff-codex-b' && draft.browserAgent.split === 'down' }, 'explicit Executor and placement choices')
    await evaluate('browserHandoffFixture.appearance("light")'); await capture('actual-creation-options-light')
    receipt.frames.at(-1).creation = await creationFacts()
    const priorIds = new Set(core.agentSessions().map((item: any) => item.agentSessionId))
    await click('Create and give control')
    const created = await until(() => core.agentSessions().find((item: any) => !priorIds.has(item.agentSessionId)), 'real Core-created third Session', 30000)
    sessions.push(created)
    assert.equal(core.agentSessions().length, 3, 'The original creation creates exactly one new Session')
    assert.equal(created.hostId, 'local'); assert.equal(created.workspacePath, directory); assert.equal(created.executorId, 'handoff-codex-b')
    const linked = await until(async () => { const value = await creationFacts(); return value.browser?.control?.agent?.agentSessionId === created.agentSessionId && value }, 'created Agent receives its exact separate Browser', 20000)
    assert.equal(linked.tab.layout.root.type, 'split'); assert.equal(linked.tab.layout.root.direction, 'vertical')
    assert.equal(linked.tab.layout.root.first.regionId, 'handoff-create-browser-region')
    const createdRegion = linked.tab.regions[linked.tab.layout.root.second.regionId]
    assert.equal(createdRegion.kind, 'agent'); assert.equal(createdRegion.sessionId, created.agentSessionId)
    const originalRequest = await until(async () => Object.values((await creationFacts()).spatialRequests).find((item: any) => item.browserAgent?.browserId === 'handoff-create-browser' && item.browserAgent.inputStarted), 'original creation request and first task queue', 20000) as any
    assert.equal(originalRequest.agentSessionId, created.agentSessionId)
    assert.equal(originalRequest.browserAgent.recipient.run.runId, created.run.runId)
    assert.ok(originalRequest.browserAgent.prompt.endsWith('\n\n用户任务：\n' + creationTask), 'The authored task is retained verbatim in its original intent')
    const key = { kind: 'prompt', agentSessionId: created.agentSessionId, expectedRun: created.run, submissionId: originalRequest.browserAgent.messageOperationId }
    receipt.creation = { created: { agentSessionId: created.agentSessionId, run: created.run, executorId: created.executorId, hostId: created.hostId, workspacePath: created.workspacePath },
      originalRequest, beforeRecheck: await creationFacts(), originalInput: await core.inspectAgentInput({ key }), originalAdmission: await core.inspectAgentPromptSubmission(key) }
    const exactQueue = receipt.creation.beforeRecheck.queues[created.agentSessionId]?.find((item: any) => item.operationId === key.submissionId)
    if (exactQueue) {
      assert.equal(exactQueue.text, originalRequest.browserAgent.prompt)
      assert.deepEqual(exactQueue.browserRecipient, originalRequest.browserAgent.recipient)
    }
    const typedReceipt = receipt.creation.originalInput
    if (typedReceipt) assert.deepEqual(typedReceipt.key, key)
    assert.ok(exactQueue || typedReceipt && ['waiting', 'admitted', 'terminal-confirmed'].includes(typedReceipt.status), 'The exact original task is positively present in the real queue or typed Core receipt')
    receipt.creation.taskPresence = { queue: exactQueue ?? null, typedReceipt: typedReceipt ?? null }
    receipt.creation.recheck = await evaluate('browserHandoffFixture.recheckCreation()')
    assert.equal(core.agentSessions().length, 3, 'Reactivating the original request cannot create another Session')
    const afterRecheck = await creationFacts()
    const requestAfter = afterRecheck.spatialRequests[originalRequest.requestId]
    assert.equal(requestAfter.browserAgent.messageOperationId, key.submissionId); assert.equal(requestAfter.agentSessionId, created.agentSessionId)
    const submissions = receipt.ipc.filter((item: any) => item.channel === 'sessions:submitPrompt' && item.args[0]?.agentSessionId === created.agentSessionId)
    assert.ok(submissions.length <= 1, 'Rechecking does not submit the first task twice')
    assert.ok(submissions.every((item: any) => item.args[2] === key.submissionId), 'Any submitted input keeps the original message operation ID')
    receipt.creation.afterRecheck = afterRecheck; receipt.creation.submissions = submissions.length
    const native = await readFile(join(directory, 'native-records/rollout-' + created.agentSessionId + '.jsonl'), 'utf8')
    const nativeTasks = native.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(item => item.type === 'response_item' && item.payload.role === 'user' && item.payload.content.some((part: any) => part.text?.includes(creationTask)))
    assert.ok(nativeTasks.length <= 1, 'The fixture native consumer must not adopt the same authored task twice')
    receipt.creation.nativeTaskCount = nativeTasks.length
    receipt.creation.inputBoundary = 'Core receipts and the repository fake Provider record are distinct facts; waiting/admission does not prove task completion or an upstream model accepting input.'
    await capture('actual-created-agent-light'); receipt.frames.at(-1).creation = await creationFacts()
    await evaluate('browserHandoffFixture.showOriginal()'); await settled()
    assert.equal((await facts()).browser.control.agent.agentSessionId, 'handoff-agent-b')
    assert.equal((await facts()).draft.original.control.agentSessionId, 'handoff-agent-a')
    receipt.passed = true; return
  }
  await capture('zero-candidates')
  await captureNativePage()
  await enterCreationOptions('Keep this unsent Browser task')
  await until(async () => (await facts()).creationDraft?.browserAgent?.split === 'down', 'chosen placement uses the original durable draft owner')
  await evaluate('browserHandoffFixture.appearance("light")'); await capture('creation-options-light')
  window.setSize(480, 760); await capture('creation-options-narrow-light')
  await click('Cancel')
  assert.equal(core.agentSessions().length, 2, 'Closing creation options keeps the task without creating another Agent')
  assert.equal((await facts()).creationDraft.prompt, 'Keep this unsent Browser task')
  window.setSize(1120, 760); await evaluate('browserHandoffFixture.appearance("dark")')
  await evaluate('browserHandoffFixture.setCandidateCount(1)'); await settled()
  const one = await facts(); receipt.oneCandidate = one
  const direct = await until(() => evaluate(`(()=>{const element=[...document.querySelectorAll('button')].find(node=>(node.getAttribute('aria-label')||'').startsWith('Give to '));return element?.getAttribute('aria-label')||false})()`), 'single exact existing Agent action')
  await click(direct)
  await until(async () => (await facts()).browser?.control?.agent?.agentSessionId === 'handoff-agent-a', 'real Main association with Agent A')
  receipt.givenA = await facts()
  assert.equal(core.agentSessions().length, 2, 'Giving control to an existing Agent must not create another process')
  await click('Message Browser operator')
  await until(() => evaluate('Boolean(document.querySelector(".browser-contextual-composer textarea"))'), 'real original-recipient message draft')
  await evaluate('document.querySelector(".browser-contextual-composer textarea").focus()')
  await contents.debugger.sendCommand('Input.insertText', { text: 'Keep this original opinion' }); await settled()
  await click('Close discussion')
  await evaluate('browserHandoffFixture.setCandidateCount(2)')
  let runFailure: unknown
  const running = cli(['browser', 'run', '--browser', 'handoff-browser', '--operation-id', 'handoff-b-program'], 'await waitForElement("Finish handoff operation",20000); return "B-finished"', 'b')
  void running.catch(error => { runFailure = error })
  await until(async () => (await facts()).browser?.control?.activeOperationId === 'handoff-b-program', 'actual public CLI Browser operation B')
  await originalPage()
  await until(async () => { if (runFailure) throw runFailure; return (await facts()).browser?.activity?.operation?.phase === 'waiting' }, 'held actual B page operation')
  const active = await facts()
  assert.equal(active.browser.control.agent.agentSessionId, 'handoff-agent-a', 'A permitted B program cannot silently replace the confirmed A association')
  assert.equal(active.browser.activity.operation.operator.id, 'handoff-agent-b', 'Actual B operator is independent of persistent A association')
  await capture('associated-a-operator-b')
  receipt.publicDuringB = await cli(['browser', 'inspect', '--operation-id', 'handoff-b-program'])
  assert.equal(receipt.publicDuringB.code, 0)
  const publishedOperation = receipt.publicDuringB.value.result.runOperation
  assert.equal(publishedOperation.operator.id, 'handoff-agent-b')
  assert.equal(publishedOperation.control.agent.agentSessionId, 'handoff-agent-a')
  assert.match(publishedOperation.warning, /different operator/u, 'Public CLI inspect preserves the original operator/association service explanation')
  receipt.publicStopB = await cli(['browser', 'stop', '--operation-id', 'handoff-b-program'], '', 'b')
  assert.equal(receipt.publicStopB.code, 0)
  assert.equal(receipt.publicStopB.value.result.runOperation.phase, 'stopped', 'Stop addresses the same in-flight business operation')
  const completed = await running
  assert.equal(completed.code, 0)
  assert.equal(completed.value.result.runOperation.phase, 'stopped')
  const afterStop = (await facts()).browser
  assert.equal(afterStop.control.owner, 'agent', 'Stopping the program does not silently give the page to the person')
  assert.equal(afterStop.control.agent.agentSessionId, 'handoff-agent-a', 'Stopping B preserves the original A association')
  await click('Take control of Browser')
  const human = await facts(); receipt.beforeReplacement = human
  const activity = (await facts()).buttons.find((item: any) => item.label?.startsWith('Browser activity:')).label
  await click(activity); await capture('choose-existing')
  await click('Switch to ' + snapshots[1].label)
  await until(async () => (await facts()).browser?.control?.agent?.agentSessionId === 'handoff-agent-b', 'atomic human replacement with Agent B')
  const switched = await facts()
  assert.equal((switched.notice ?? '').includes('different operator'), false, 'A confirmed new association removes the superseded current association notice')
  receipt.publicAfterReplacement = await cli(['browser', 'inspect', '--operation-id', 'handoff-b-program'])
  assert.equal(receipt.publicAfterReplacement.code, 0)
  assert.equal(receipt.publicAfterReplacement.value.result.runOperation.phase, 'stopped')
  assert.equal(receipt.publicAfterReplacement.value.result.runOperation.control.agent.agentSessionId, 'handoff-agent-b', 'Inspect publishes current host-owned control alongside the original operation history')
  assert.equal(receipt.publicAfterReplacement.value.result.runOperation.operator.id, 'handoff-agent-b')
  assert.match(receipt.publicAfterReplacement.value.result.runOperation.warning, /different operator/u, 'The original operation keeps its history after explicit replacement')
  await click('Take control of Browser')
  const beforeStale = (await facts()).browser
  const stale = await evaluate(`window.agentmux.browser.returnControl('handoff-browser',${JSON.stringify({ navigationId: beforeStale.navigationId, expectedRevision: beforeStale.control.revision,
    expectedAgent: { hostId: 'local', agentSessionId: 'handoff-agent-a' }, agent: snapshots[0].control })}).then(()=>({refused:false}),error=>({refused:true,message:error.message}))`)
  assert.equal(stale.refused, true, 'A stale original association is rejected only for that exact handoff')
  assert.equal((await facts()).browser.control.agent.agentSessionId, 'handoff-agent-b')
  receipt.staleHandoff = stale
  window.setSize(480, 760); await evaluate('browserHandoffFixture.appearance("light")'); await capture('narrow-light')
  window.setSize(320, 760); await capture('tight-light')
  await evaluate('browserHandoffFixture.persist()')
  receipt.savedIdentity = await originalIdentity()
  assert.equal(receipt.savedIdentity.agentSessionId, 'handoff-agent-b')
  assert.equal(receipt.savedIdentity.draftText, 'Keep this original opinion')
  assert.equal(receipt.savedIdentity.draftAgentSessionId, 'handoff-agent-a', 'Old draft must retain original A while current association is B')
  receipt.discovery = await cli(['browser', 'targets', '--workspace', 'handoff-workspace'])
  assert.equal(receipt.discovery.code, 0)
  const published = receipt.discovery.value.result.targets.find((item: any) => item.id === 'handoff-browser')
  assert.equal(published.control.agent.agentSessionId, 'handoff-agent-b')
  assert.equal(receipt.ipc.some((item: any) => item.channel === 'browser:returnControl' && item.exactSender && item.exactFrame), true, 'Real trusted Main IPC consumes the handoff')
  receipt.passed = true
}
void run().catch(async error => {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }; console.error(error)
  if (window && !window.isDestroyed()) try {
    receipt.failureFacts = await window.webContents.executeJavaScript('window.browserHandoffFixture?.inspect()')
    await writeFile(join(directory, phase + '-failure.png'), (await window.capturePage()).toPNG())
  } catch (diagnostic) { receipt.failureDiagnostic = String(diagnostic) }
}).finally(async () => {
  const failures: string[] = []
  for (const release of [
    async () => { if (window && !window.isDestroyed()) await window.webContents.executeJavaScript('window.browserHandoffFixture?.dispose()') },
    async () => { if ((phase === 'restart' || !receipt.passed) && core) for (const session of sessions) await core.stopAgent(session.agentSessionId, core.agentSession(session.agentSessionId).run) },
    () => releaseIpc?.(), () => runtime?.dispose(), () => access?.dispose(), () => windows?.dispose(), () => sdk?.dispose(), () => rpc?.dispose(),
    () => hostServer?.stop(), () => hosted?.dispose(), () => core?.dispose(), () => { if (window && !window.isDestroyed()) window.destroy() }
  ]) try { await release() } catch (error) { failures.push(String(error)) }
  receipt.cleanupFailures = failures
  await writeFile(join(directory, phase + '-receipt.json'), JSON.stringify(receipt, null, 2))
  app.exit(receipt.passed && !failures.length ? 0 : 1)
})
