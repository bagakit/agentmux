import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { desktopFixture, activate, key } from './fixtures/settings-cli/desktop.mjs'
import { listProbeProcesses, signalOwnedProbeProcess, stopProbeProcesses } from './probe-process.mjs'

// Original ordinary App/Host bundles and a private real PTY. No installed App, live model or user Run.
const repository = resolve(import.meta.dirname, '../../..'), desktopRoot = join(repository, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json'))
const execFileAsync = promisify(execFile)
const output = resolve(repository, process.env.AGENTMUX_LEARNING_RESTART_OUTPUT ?? '.local/state/agent-learning/desktop/process-' + randomUUID())
const temporary = await mkdtemp(join(tmpdir(), 'al-')), root = process.argv.includes('--alias-path') ? temporary : await realpath(temporary)
const privateHome = join(root, 'home'), userData = join(root, 'user-data')
const workspacePath = join(root, 'work'), backing = join(privateHome, '.agentmux', 'scratch'), runtimeDirectory = join(root, 'runtime')
const environment = { AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
  AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'messages.ndjson'), CODEX_HOME: join(root, 'codex-home') }
assert.ok(Buffer.byteLength(join(runtimeDirectory, 'control.sock.desktop')) < 104, 'Private original Unix endpoints must fit the native sockaddr path')
const inherited = Object.keys(process.env).filter(name => /^AGENTMUX_(?:ENV|CLI|AGENT_SESSION(?:_.*)?|AGENT_CAPABILITY|HOOK(?:_.*)?|PROVIDER_ID|EXECUTOR_ID|LIFECYCLE_OPERATION_ID|USAGE_TRANSCRIPT_FORMAT)$/u.test(name))
const previous = new Map([...Object.keys(environment), ...inherited, 'ELECTRON_RUN_AS_NODE'].map(name => [name, process.env[name]]))
const children = new Set(), connections = new Set(), frames = [], events = []
const affectedFeedback = process.argv.includes('--affected-feedback')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { scope: 'Private production App/Host process restart and real native review controls with controlled Provider input. No actual person, model extraction, knowledge save or future adoption claim.', passed: false, root, pathForm: process.argv.includes('--alias-path') ? 'original-alias' : 'canonical', frames, events }
if (affectedFeedback) receipt.scope = 'Affected confirmation feedback and current-stage visuals through the real private App and original consumer chain. Original process restart evidence is reused separately; this run does not claim another restart or knowledge adoption.'
let core, rpc, session, failure, currentProbe
await mkdir(output, { recursive: true })
async function bindings() {
  const paths = ['apps/desktop/scripts/verify-agent-learning-restart.mjs', 'apps/desktop/scripts/fixtures/settings-cli/desktop.mjs',
    'apps/desktop/scripts/probe-process.mjs', 'packages/core/test/fixtures/fake-codex-cli.mjs']
  async function files(directory) { for (const entry of await readdir(join(repository, directory), { withFileTypes: true })) {
    const path = directory + '/' + entry.name
    if (entry.isDirectory()) await files(path)
    else if (entry.isFile()) paths.push(path)
  } }
  await files('packages/core/dist')
  return Object.fromEntries(await Promise.all(paths.sort().map(async path => [path, digest(await readFile(join(repository, path)))])))
}
async function waitFor(label, observe, budget = 20_000) {
  const end = Date.now() + budget
  events.push({ observation: label })
  while (Date.now() < end) {
    try { const value = await observe(); if (value) return value }
    catch (error) {
      if (error.name !== 'TimeoutError' && !['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code)) throw error
      events.push({ observation: label, unavailable: error.message })
    }
    await new Promise(done => setTimeout(done, 50))
  }
  throw new Error('Private learning observation timed out: ' + label)
}
const launch = desktopFixture({ desktopRoot, root, privateHome, environment, children, connections, waitFor })
const controls = text => `Array.from(document.querySelectorAll('button')).filter(e=>e.textContent.trim()===${JSON.stringify(text)}||e.getAttribute('aria-label')===${JSON.stringify(text)})`
async function action(probe, text) {
  await waitFor('enabled ' + text, () => probe.cdp.evaluate(`(${controls(text)}).some(e=>e.getClientRects().length&&!e.disabled)`))
  await activate(probe.cdp, controls(text)); events.push({ action: text, pid: probe.child.pid })
}
async function snapshot(probe) {
  return await probe.cdp.evaluate(`(()=>{const state=JSON.parse(localStorage.getItem('agentmux-workbench-v1')??'null')?.state;return {
    review:document.querySelector('.session-learning:not([hidden])')?.textContent??null,
    draft:document.querySelector('.session-learning:not([hidden]) textarea')?.value??null,
    executor:document.querySelector('[aria-label="Learning Agent"]')?.textContent??null,
    destination:document.querySelector('[aria-label="Learning destination"]')?.textContent??null,
    retained:state?.agentLearningReviewDrafts??{},composer:state?.agentComposerDrafts??{},workbench:state?.restoredWorkbench??null}})()`)
}
async function shot(probe, name) {
  await probe.cdp.evaluate('document.fonts.ready.then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))')
  const image = await probe.cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  const bytes = Buffer.from(image.data, 'base64'); await writeFile(join(output, name + '.png'), bytes)
  frames.push({ path: name + '.png', sha256: digest(bytes), pid: probe.child.pid, viewport: await probe.cdp.evaluate('({width:innerWidth,height:innerHeight})'), state: await snapshot(probe) })
}
async function size(probe, width, height) {
  const bounds = await probe.main.evaluate(`(()=>{const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron');
    const windows=BrowserWindow.getAllWindows().filter(window=>window.webContents.getURL().includes('/out/renderer/index.html'));
    if(windows.length!==1)throw Error('One private product window required');const window=windows[0],minimum=window.getMinimumSize();
    window.setBounds({width:Math.max(minimum[0],${width}),height:Math.max(minimum[1],${height})});return{minimum,bounds:window.getBounds()}})()`)
  events.push({ action: 'native window resize', pid: probe.child.pid, ...bounds })
}
async function choose(probe, label, text) {
  await waitFor('enabled ' + label, () => probe.cdp.evaluate(`Array.from(document.querySelectorAll('button')).some(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}&&e.getClientRects().length&&!e.disabled)`))
  await activate(probe.cdp, `Array.from(document.querySelectorAll('button')).filter(e=>e.getAttribute('aria-label')===${JSON.stringify(label)})`)
  await waitFor('actual selection menu', () => probe.cdp.evaluate('Boolean(document.querySelector("[role=menuitemradio]"))'))
  await activate(probe.cdp, `Array.from(document.querySelectorAll('[role="menuitemradio"]')).filter(e=>e.textContent.includes(${JSON.stringify(text)}))`)
}
async function edit(probe, text) {
  assert.equal(await probe.cdp.evaluate(`(()=>{const e=document.querySelector('.session-learning:not([hidden]) textarea');e.focus();e.select();return document.activeElement===e})()`), true)
  await probe.cdp.call('Input.insertText', { text })
}
async function openReview(probe) {
  const header = `.agent-region-header[data-agent-session-id="${session.agentSessionId}"] .agent-region-header__more`
  await waitFor('original Agent menu', () => probe.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(header)}))`))
  await activate(probe.cdp, `Array.from(document.querySelectorAll(${JSON.stringify(header)}))`)
  await activate(probe.cdp, `Array.from(document.querySelectorAll('[role="menuitem"]')).filter(e=>e.textContent.includes('Pass on experience'))`)
  await waitFor('original review surface', async () => (await snapshot(probe)).review)
}
async function quit(probe) {
  try { await probe.main.evaluate(`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot, 'package.json'))})('electron').app.quit()`) } catch {}
  probe.main.close(); probe.cdp.close()
  await waitFor('actual App exit', () => probe.child.exitCode !== null || probe.child.signalCode !== null)
  assert.equal(probe.child.exitCode, 0); assert.equal(probe.child.signalCode, null); children.delete(probe.child)
  events.push({ action: 'ordinary App quit', pid: probe.child.pid, exitCode: probe.child.exitCode })
}
async function originalRun() {
  const current = (await core.listRuns()).find(run => run.runId === session.run.runId)
  assert.equal(current?.state, 'running'); return current
}
async function stopOriginalHost() {
  const pids = await listProbeProcesses(-1, root), stopped = []
  for (const pid of pids) {
    const { stdout: command } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='])
    if (command.includes('agentmux-host.js') && command.includes(join(userData, 'agent-sessions.json'))) {
      await signalOwnedProbeProcess(pid, root, 'SIGTERM'); events.push({ action: 'private Host exit', pid }); stopped.push(pid)
    }
  }
  assert.equal(stopped.length, 1, 'One actual original Host must be observed and stopped')
  await waitFor('actual original Host exit', async () => { const remaining = await listProbeProcesses(-1, root); return stopped.every(pid => !remaining.includes(pid)) })
}
try {
  for (const name of inherited) delete process.env[name]
  delete process.env.ELECTRON_RUN_AS_NODE
  Object.assign(process.env, environment)
  const buildReceipt = process.env.AGENTMUX_LEARNING_BUILD_RECEIPT ?? '.local/state/agent-learning/desktop/build-receipt.json'
  receipt.build = { path: buildReceipt, sha256: digest(await readFile(join(repository, buildReceipt))) }
  const built = JSON.parse(await readFile(join(repository, receipt.build.path), 'utf8'))
  for (const [path, sha] of Object.entries(built.sources)) assert.equal(digest(await readFile(join(repository, path))), sha, 'Actual build source changed: ' + path)
  for (const [path, sha] of Object.entries(built.outputs)) assert.equal(digest(await readFile(join(repository, path))), sha, 'Actual production bundle changed: ' + path)
  receipt.inputsBefore = await bindings()
  const nativeSource = join(desktopRoot, 'resources/bin/agentmux-workspace-move'), nativeOutput = join(desktopRoot, 'out/resources/bin/agentmux-workspace-move')
  await mkdir(dirname(nativeOutput), { recursive: true }); await copyFile(nativeSource, nativeOutput)
  assert.equal(digest(await readFile(nativeSource)), digest(await readFile(nativeOutput)))
  await cp(join(desktopRoot, 'resources/toolkit'), join(desktopRoot, 'out/main/resources/toolkit'), { recursive: true })
  for (const directory of [privateHome, userData, workspacePath, backing, environment.CODEX_HOME]) await mkdir(directory, { recursive: true, mode: 0o700 })
  const notesDirectory = join(privateHome, '.agentmux/notes')
  await mkdir(environment.AGENTMUX_STATE_DIRECTORY, { recursive: true, mode: 0o700 }); await mkdir(notesDirectory, { recursive: true })
  await writeFile(join(environment.AGENTMUX_STATE_DIRECTORY, 'notes-location.json'), JSON.stringify({ schemaVersion: 1, directory: notesDirectory, operations: {}, pending: null }) + '\n')
  const notesLocator = JSON.parse(await readFile(join(environment.AGENTMUX_STATE_DIRECTORY, 'notes-location.json'), 'utf8'))
  assert.equal(notesLocator.schemaVersion, 1); assert.equal(notesLocator.directory, notesDirectory); assert.ok(notesLocator.directory.startsWith(root + '/'))
  receipt.privateNotesLocator = { directory: notesDirectory, sha256: digest(await readFile(join(environment.AGENTMUX_STATE_DIRECTORY, 'notes-location.json'))) }
  const module = await import(pathToFileURL(join(repository, 'packages/core/dist/index.js')))
  const { ScratchTopics } = await import(pathToFileURL(join(repository, 'apps/host/dist/mote-resources.js')))
  const fixture = join(root, 'fake-codex-cli.mjs'), executable = join(root, 'private-codex.sh'), capabilityPath = join(root, 'actual-capability.json')
  await copyFile(join(repository, 'packages/core/test/fixtures/fake-codex-cli.mjs'), fixture)
  const quote = text => `'${text.replaceAll("'", "'\\''")}'`
  await writeFile(executable, `#!/bin/sh\nif [ "$1" = '--version' ]; then printf 'Private codex fixture 1\\n'; exit 0; fi\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 })
  const executor = { label: 'Private learning Agent', providerId: 'codex', command: executable, args: [], env: { CODEX_HOME: environment.CODEX_HOME,
    AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_CAPABILITY_RECEIPT: capabilityPath, AGENTMUX_FAKE_NATIVE_RECORD: '1', AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(root, 'native-records') }, injectAgentMuxGuide: true }
  const creation = { createOperationId: randomUUID(), providerId: 'codex', executorId: 'learning-probe', commandOverride: executable,
    workspacePath, env: executor.env, injectAgentMuxGuide: true }
  // Release the source setup process and its SQLite readers before the ordinary
  // Host becomes the semantic owner. No parallel test owner keeps this Store open.
  const producer = `import {connectLocalAgentMux,AgentMuxFileAgentSessionStore} from ${JSON.stringify(pathToFileURL(join(repository, 'packages/core/dist/index.js')).href)};
    const owner=await connectLocalAgentMux({store:new AgentMuxFileAgentSessionStore(${JSON.stringify(join(userData, 'agent-sessions.json'))})});
    try {const session=await owner.createAgent(${JSON.stringify(creation)});const run=(await owner.listRuns()).find(run=>run.runId===session.run.runId);process.stdout.write(JSON.stringify({agentSessionId:session.agentSessionId,run}));}finally{await owner.dispose();}`
  const produced = await execFileAsync(process.execPath, ['--input-type=module', '-e', producer], { env: process.env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  session = JSON.parse(produced.stdout); receipt.source = session
  await writeFile(join(output, 'source-producer.stderr.txt'), produced.stderr)
  core = await module.connectLocalAgentMux({ store: new module.AgentMuxMemoryAgentSessionStore() })
  assert.equal((await originalRun()).pid, receipt.source.run.pid)
  const workspace = { id: '__scratch__', name: 'Private learning homes', hostId: 'local', path: backing, kind: 'folder' }
  const topics = new ScratchTopics(); await topics.ensureMote(workspace, 'view:learning-mote')
  await writeFile(join(workspacePath, 'sibling.txt'), 'The original adjacent work remains.\n')
  await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify({ version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private learning Host' }], executors: { 'learning-probe': executor },
    workspaces: [workspace, { id: '__notes__', hostId: 'local', name: 'Private recall', path: join(privateHome, '.agentmux/notes'), kind: 'folder' }, { id: 'learning-work', hostId: 'local', name: 'Source work', path: workspacePath, kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }, notifications: { mode: 'off' } }))
  const tabId = 'learning-original-tab', regionId = 'learning-original-agent', fileId = 'learning-original-file', groupId = 'learning-original-group', composer = 'Retain the original unsent source message.'
  const seed = { version: 1, state: { activeWorkspaceId: 'learning-work', mainSurface: 'workbench', agentComposerDrafts: { [session.agentSessionId]: composer },
    agentFocus: { execution: { sessionId: session.agentSessionId, history: [] }, pmo: { sessionId: null } },
    restoredWorkbench: { tabs: { [tabId]: { id: tabId, workspaceId: 'learning-work', titleRegionId: regionId, layout: { root: { type: 'split', direction: 'horizontal', ratio: .65, first: { type: 'leaf', regionId }, second: { type: 'leaf', regionId: fileId } }, activeRegionId: regionId }, regions: { [regionId]: { regionId, kind: 'launcher', workspaceId: 'learning-work' }, [fileId]: { regionId: fileId, kind: 'file', workspaceId: 'learning-work', path: 'sibling.txt' } } } }, layouts: { 'learning-work': { root: { type: 'leaf', groupId }, groups: [{ id: groupId, tabOrder: [tabId], activeTabId: tabId, recentTabIds: [tabId] }], activeGroupId: groupId } } } } }
  receipt.seed = await launch('seed', seed)
  const first = await launch('first'); currentProbe = first
  await waitFor('original durable source projection', () => first.cdp.evaluate(`window.agentmux.sessions.snapshot().then(value=>value.sessions.some(session=>session.id===${JSON.stringify(session.agentSessionId)}&&session.control?.hostId==='local'))`))
  rpc = await module.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtimeDirectory, 'control.sock') } })
  receipt.originalPlacement = await rpc.call('agent.open', { operationId: randomUUID(), content: { kind: 'agent-session', agentSessionId: session.agentSessionId }, destination: { regionId }, focus: true })
  assert.equal(receipt.originalPlacement.outcome, 'opened'); assert.equal(receipt.originalPlacement.to.regionId, regionId)
  const createdTopic = await first.cdp.evaluate(`window.agentmux.topics.call('topic.create', {topicId:'view:learning-topic',title:'Field notes'})`)
  const topic = await topics.read(workspace, createdTopic.topic.topicId)
  assert.equal(topic.kind, 'topic'); receipt.productionTopic = createdTopic
  await openReview(first); await choose(first, 'Extraction Agent', 'Private learning Agent'); await action(first, 'Extract experience')
  const operation = await waitFor('original durable extraction', async () => (await rpc.call('agent.learning.ls', { hostId: 'local', agentSessionId: session.agentSessionId })).operations[0])
  const credentials = await waitFor('actual proposer capability', async () => { try { const value = JSON.parse(await readFile(capabilityPath, 'utf8')); return value.agentSessionId === operation.proposer.agentSessionId ? value : null } catch { return null } })
  const candidate = 'Source: original private work.\n\nCondition: inspect an uncertain result before retrying.\nMethod: retain its original operation identity and read its owner.\nCounterexample: a changed destination needs a new review.\nUnknown: one observed case does not establish a general preference.'
  const proposed = (await rpc.call('agent.learning.propose', { hostId: 'local', operationId: operation.operationId, expectedRevision: operation.revision, content: candidate }, { credentials })).operation
  await action(first, 'Check original'); await waitFor('actual candidate textarea', async () => (await snapshot(first)).draft === candidate)
  await choose(first, 'Learning destination', 'Topic · local'); await choose(first, 'Learning Agent', 'Private learning Agent')
  const unsaved = candidate + '\nHuman draft: retain this unsaved qualification across App and Host restart.'
  await edit(first, unsaved)
  await action(first, 'View extraction Agent'); await waitFor('extraction navigation leaves review', async () => !(await snapshot(first)).review)
  const returnToSource = await rpc.call('space.focus', { inputPolicy: 'preserve', target: { kind: 'space', regionId } })
  receipt.returnToSource = returnToSource; await openReview(first)
  await waitFor('original draft after source-extraction-source navigation', async () => (await snapshot(first)).draft === unsaved)
  await size(first, 1440, 1000); await shot(first, 'review-wide')
  await size(first, 820, 900); await shot(first, 'review-narrow')
  let second = first
  if (!affectedFeedback) {
    receipt.beforeRestart = await snapshot(first)
    await quit(first)
    await rpc.dispose(); rpc = undefined
    await stopOriginalHost()
    second = await launch('second'); currentProbe = second; await openReview(second)
    await waitFor('restored complete draft', async () => (await snapshot(second)).draft === unsaved)
    await waitFor('restored original destination observation', async () => {
      const value = await snapshot(second)
      return value.destination === receipt.beforeRestart.destination && value.executor === receipt.beforeRestart.executor
    })
    receipt.afterRestart = await snapshot(second)
    assert.equal(receipt.afterRestart.executor, receipt.beforeRestart.executor); assert.equal(receipt.afterRestart.destination, receipt.beforeRestart.destination)
    assert.equal(receipt.afterRestart.composer[session.agentSessionId], composer)
    const afterRun = await originalRun(); assert.equal(afterRun.pid, receipt.source.run.pid); assert.equal(afterRun.runId, receipt.source.run.runId)
    rpc = await module.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtimeDirectory, 'control.sock') } })
    const restored = (await rpc.call('agent.learning.inspect', { hostId: 'local', operationId: proposed.operationId })).operation
    assert.equal(restored.ownerRuntimeId, proposed.ownerRuntimeId)
    assert.equal(restored.proposer.agentSessionId, operation.proposer.agentSessionId); assert.equal(restored.proposer.createOperationId, operation.proposer.createOperationId)
  } else {
    receipt.reusedRestart = { path: '.local/state/agent-learning/desktop/process-v2-alias/receipt.json', sha256: digest(await readFile(join(repository, '.local/state/agent-learning/desktop/process-v2-alias/receipt.json'))) }
  }
  await shot(second, affectedFeedback ? 'retained-review' : 'restored-review'); await action(second, 'Save draft')
  await waitFor('saved review', async () => (await rpc.call('agent.learning.inspect', { hostId: 'local', operationId: proposed.operationId })).operation.candidate.content === unsaved)
  const directory = topic.physicalDirectoryPath; await rename(directory, directory + '-moved')
  await action(second, 'Confirm & send for learning'); await waitFor('real target failure', async () => (await snapshot(second)).review?.includes('Original result needs attention'))
  await shot(second, 'target-unconfirmed'); assert.equal((await rpc.call('agent.learning.inspect', { hostId: 'local', operationId: proposed.operationId })).operation.learner, null)
  await action(second, 'Result needs attention · Inspect original result'); await shot(second, 'target-unconfirmed-detail')
  await rename(directory + '-moved', directory); await action(second, 'Retry exact confirmation')
  const confirmed = await waitFor('original approved learner', async () => { const value = (await rpc.call('agent.learning.inspect', { hostId: 'local', operationId: proposed.operationId })).operation; return value.learner?.state === 'created' ? value : null })
  assert.equal(confirmed.approved.target.topicId, topic.id); assert.equal(confirmed.candidate.content, unsaved)
  await waitFor('actual learning request view', async () => (await snapshot(second)).review?.includes('Reviewed candidate confirmed'))
  await shot(second, 'learning-request')
  receipt.operation = confirmed; receipt.sourceAfter = await originalRun()
  const learner = await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: confirmed.learner.agentSessionId } })
  const learnerRun = (await core.listRuns()).find(run => run.runId === learner.session.run.runId)
  assert.equal(learnerRun.state, 'running'); receipt[affectedFeedback ? 'learner' : 'learnerBeforeRestart'] = { session: learner.session, run: learnerRun }
  let third = second
  if (!affectedFeedback) {
    await quit(second); await rpc.dispose(); rpc = undefined; await stopOriginalHost()
    third = await launch('third'); currentProbe = third; await openReview(third)
    await waitFor('restored original learner view', async () => (await snapshot(third)).review?.includes('Reviewed candidate confirmed'))
    rpc = await module.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtimeDirectory, 'control.sock') } })
    const reopened = (await rpc.call('agent.learning.inspect', { hostId: 'local', operationId: confirmed.operationId })).operation
    assert.deepEqual(reopened.approved, confirmed.approved); assert.deepEqual(reopened.learner, confirmed.learner)
    const currentLearner = await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: reopened.learner.agentSessionId } })
    const currentRun = (await core.listRuns()).find(run => run.runId === learner.session.run.runId)
    assert.deepEqual(currentLearner.session.run, learner.session.run); assert.equal(currentRun.pid, learnerRun.pid); assert.equal(currentRun.state, 'running')
    receipt.learnerAfterRestart = { session: currentLearner.session, run: currentRun }
    await shot(third, 'restored-learning-request')
  }
  receipt.stopped = []
  for (const agentSessionId of [session.agentSessionId, confirmed.proposer.agentSessionId, confirmed.learner.agentSessionId]) {
    await rpc.call('agent.stop', { target: { kind: 'agent-session', agentSessionId } }); receipt.stopped.push(agentSessionId)
  }
  await quit(third)
  receipt.passed = true
} catch (error) { failure = error; receipt.failure = { name: error.name, message: error.message, stack: error.stack, code: error.code, detail: error.detail }
  if (currentProbe) {
    try {
      await shot(currentProbe, 'failed-observation'); receipt.failedDocument = await currentProbe.cdp.evaluate('document.body.innerText')
      receipt.failedSpatial = await currentProbe.cdp.evaluate('window.agentmux.spatial.read()')
      receipt.failedTopics = await currentProbe.cdp.evaluate("window.agentmux.topics.call('topic.ls', {})")
      receipt.failedRuntime = await currentProbe.cdp.evaluate('window.agentmux.sessions.snapshot()')
    } catch (observation) { receipt.failureObservationError = observation.message }
  }
}
finally {
  await rpc?.dispose().catch(error => { receipt.rpcCleanupError = error.message })
  for (const connection of connections) connection.close()
  if (core) {
    await core.dispose().catch(error => { receipt.coreCleanupError = error.message })
  }
  try { receipt.cleanup = await stopProbeProcesses(-1, root) } catch (error) { receipt.cleanupError = error.message }
  if (receipt.inputsBefore) {
    receipt.inputsAfter = await bindings()
    try { assert.deepEqual(receipt.inputsAfter, receipt.inputsBefore) } catch (error) { receipt.inputDrift = error.message; receipt.passed = false; failure ??= error }
  }
  for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ passed: receipt.passed, output: relative(repository, output), failure: receipt.failure }) + '\n')
}
if (failure) process.exitCode = 1
