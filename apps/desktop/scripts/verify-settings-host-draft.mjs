import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'
import { activate, desktopFixture } from './fixtures/settings-cli/desktop.mjs'

const repository = resolve(import.meta.dirname, '../../..'), desktop = join(repository, 'apps/desktop')
const exec = promisify(execFile), digest = bytes => createHash('sha256').update(bytes).digest('hex')
const delay = ms => new Promise(done => setTimeout(done, ms))
const option = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1)
function processIdentity(text) {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(text.trim())
  assert.ok(match); const pid = Number(match[1]), group = Number(match[2]); assert.ok(pid > 1 && group > 1)
  return { pid, group, born: match[3] }
}
async function liveIdentity(pid) {
  try { return processIdentity((await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart='], { timeout: 5000, env: { ...process.env, LC_ALL: 'C' } })).stdout) }
  catch (error) { if (error.code === 1) return null; throw error }
}
async function reapRegistered(root) {
  let records
  try { records = JSON.parse(await readFile(join(root, 'owned-processes.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  assert.ok(records.length > 0)
  const result = []
  for (const record of records) {
    const current = await liveIdentity(record.pid)
    if (current?.born === record.born) {
      assert.equal(current.group, record.group)
      try { process.kill(-record.group, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    let remaining = await liveIdentity(record.pid)
    for (let tries = 0; remaining?.born === record.born && tries < 40; tries++) { await delay(50); remaining = await liveIdentity(record.pid) }
    assert.ok(!remaining || remaining.born !== record.born, 'Exact owned birth identity must be reaped, including detached cat')
    result.push({ ...record, wasAlive: current?.born === record.born, reaped: true })
  }
  return result
}
async function identity() {
  const files = [import.meta.filename, join(desktop, 'scripts/probe-process.mjs'),
    join(desktop, 'scripts/fixtures/settings-cli/desktop.mjs'), join(desktop, 'scripts/fixtures/settings-cli/font.mjs'),
    join(desktop, 'test/settings-host-draft.test.tsx')]
  for (const directory of ['apps/desktop/src', 'apps/desktop/out', 'packages/core/src', 'packages/core/dist']) {
    const found = (await readdir(join(repository, directory), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    assert.ok(found.length > 0, `Nonempty binding: ${directory}`)
    files.push(...found.map(entry => join(entry.parentPath, entry.name)))
  }
  return Object.fromEntries(await Promise.all(files.sort().map(async path => [path.slice(repository.length + 1), digest(await readFile(path))])))
}
async function replaceText(cdp, selector, text) {
  assert.equal(await cdp.evaluate(`(()=>{const matches=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(node=>node.isConnected&&node.getClientRects().length);if(matches.length!==1)throw Error('Expected one visible text input');const node=matches[0];if(node.type!=='text'||node.disabled)throw Error('Expected editable text input');node.scrollIntoView({block:'nearest'});node.focus();node.select();return document.activeElement===node})()`), true)
  await cdp.call('Input.insertText', { text })
  assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), text)
}

// The public verifier owns its one private root, even if a watchdog skips the driver's finally.
if (!process.argv.includes('--driver')) {
  const root = await mkdtemp('/tmp/amx-host-draft-'), evidence = join(repository, '.tmp/settings-host-draft/runs', `run-${Date.now()}-${randomUUID()}`)
  const receipt = { schema: 'agentmux.settings-host-draft-proof.v1', passed: false, sourceBefore: {}, sourceAfter: {}, cleanup: {}, userAppRunTouched: false }
  let failure
  try {
    await mkdir(evidence, { recursive: true }); receipt.sourceBefore = await identity()
    receipt.sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim()
    if (!process.argv.includes('--watchdog-only')) {
      // Real mounted Hosts/SettingsPanel -> registered Main owner, validation and durable publication;
      // only Runtime preparation is controlled. This is explicitly separate from the remote refusal.
      const json = join(evidence, 'success-seam-vitest.json')
      const seam = await runProbeProcess(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run',
        'apps/desktop/test/settings-host-draft.test.tsx', '--maxWorkers=1', '-t', 'retains an authored Host draft through disjoint external publication',
        '--reporter=json', `--outputFile=${json}`], { temporaryRoot: root, cwd: repository, env: process.env, timeoutMs: 20000 })
      assert.equal(seam.exitCode, 0); assert.equal(seam.timedOut, false); assert.equal(seam.interruption, null)
      const tests = JSON.parse(await readFile(json, 'utf8'))
      assert.equal(tests.numPassedTests, 1); assert.equal(tests.numFailedTests, 0)
      receipt.successPublication = { ...seam, passed: true, controlledRuntimePrepare: true, registeredMainOwner: true, realConfigStore: true, reportSha256: digest(await readFile(json)) }
    }
    const watchdog = process.argv.includes('--watchdog-only'); let runReady = false
    const outcome = await runProbeProcess(process.execPath, [import.meta.filename, '--driver', `--probe-root=${root}`, `--evidence=${evidence}`,
      ...(watchdog ? ['--hold-for-watchdog'] : [])], { temporaryRoot: root, cwd: repository, env: process.env, timeoutMs: watchdog ? 20000 : 120000,
      onLine: line => { runReady ||= line === 'host_draft_private_run_ready'; console.error(line) } })
    if (watchdog) {
      assert.equal(runReady, true); assert.equal(outcome.timedOut, true); assert.equal(outcome.exitCode, 1)
      await assert.rejects(readFile(join(root, 'inner-finally-reached')), { code: 'ENOENT' })
      receipt.watchdog = { ...outcome, runReady }
    } else {
      assert.equal(outcome.exitCode, 0); assert.equal(outcome.timedOut, false); assert.equal(outcome.interruption, null)
      receipt.refusal = JSON.parse(await readFile(join(evidence, 'native-refusal.json'), 'utf8'))
      assert.equal(receipt.refusal.passed, true)
    }
    receipt.sourceAfter = await identity(); assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore); receipt.passed = true
  } catch (error) { failure = error; receipt.failure = { name: error.name, message: error.message } }
  finally {
    const cleanupErrors = []
    for (const action of [async () => { receipt.cleanup.registered = await reapRegistered(root) },
      async () => { await stopProbeProcesses(process.pid + 1000000000, root); receipt.cleanup.remaining = await listProbeProcesses(process.pid + 1000000000, root); assert.deepEqual(receipt.cleanup.remaining, []) },
      async () => { await rm(root, { recursive: true }); receipt.cleanup.rootRemoved = true }]) {
      try { await action() } catch (error) { cleanupErrors.push(error) }
    }
    if (cleanupErrors.length) { failure ??= cleanupErrors[0]; receipt.passed = false; receipt.cleanup.errors = cleanupErrors.map(error => error.message) }
    await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  console.log(JSON.stringify({ passed: receipt.passed, evidence, receiptSha256: digest(await readFile(join(evidence, 'receipt.json'))), failure: receipt.failure }))
  if (failure) process.exitCode = 1
} else {
  const root = option('--probe-root'), evidence = option('--evidence'); assert.ok(root && evidence)
  const privateHome = join(root, 'home'), userData = join(root, 'user-data'), runtimeDirectory = join(root, 'runtime'), workspace = join(root, 'workspace')
  const environment = { HOME: privateHome, CODEX_HOME: join(privateHome, 'codex'), AGENTMUX_DESKTOP_USER_DATA: userData,
    AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory, AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') }
  const previous = new Map(Object.keys(environment).map(name => [name, process.env[name]])), owned = []
  const register = record => { assert.ok(record && record.pid > 1 && record.group > 1); owned.push(record); writeFileSync(join(root, 'owned-processes.next'), JSON.stringify(owned)); renameSync(join(root, 'owned-processes.next'), join(root, 'owned-processes.json')) }
  const children = new class extends Set { add(child) {
    assert.ok(child.pid > 1); const record = processIdentity(execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'pid=,pgid=,lstart='], { timeout: 5000, env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8' }))
    register(record); return super.add(child)
  } }(), connections = new Set(), deadline = Date.now() + 110000
  const waitFor = async (label, read, budget = 20000) => {
    const end = Math.min(deadline, Date.now() + budget)
    while (Date.now() < end) { const value = await read(); if (value) return value; await delay(60) }
    throw new Error(`Host draft proof timed out: ${label}`)
  }
  const launch = desktopFixture({ desktopRoot: desktop, root, privateHome, environment, children, connections, waitFor })
  const receipt = { schema: 'agentmux.settings-host-real-refusal.v1', passed: false, fixture: 'ordinary-new-empty-Scratch; no seed, flush, reseed, replacement or user App', facts: {}, cleanup: {} }
  let client, session, probe, failure, phase = 'prepare'
  try {
    await Promise.all([userData, workspace, join(root, 'topics'), environment.CODEX_HOME].map(path => mkdir(path, { recursive: true })))
    const executable = join(workspace, 'private-cat.sh'); await writeFile(executable, '#!/bin/sh\nprintf "Private Host draft PTY\\n"\nexec /bin/cat\n', { mode: 0o700 })
    Object.assign(process.env, environment)
    const { AgentMuxFileAgentSessionStore, connectLocalAgentMux } = await import('../../../packages/core/dist/index.js')
    const store = new AgentMuxFileAgentSessionStore(join(userData, 'agent-sessions.json'))
    client = await connectLocalAgentMux({ store })
    session = await client.createAgent({ createOperationId: randomUUID(), executorId: 'probe', providerId: 'codex', commandOverride: executable,
      workspacePath: workspace, env: { HOME: privateHome, CODEX_HOME: environment.CODEX_HOME }, injectAgentMuxGuide: false, cols: 100, rows: 30 })
    const originalRun = (await client.listRuns()).find(run => run.runId === session.run.runId)
    assert.equal(originalRun?.state, 'running'); assert.ok(originalRun.pid > 1); register(await liveIdentity(originalRun.pid))
    console.error('host_draft_private_run_ready')
    if (process.argv.includes('--hold-for-watchdog')) await new Promise(() => {})
    await client.dispose(); client = null
    const configPath = join(userData, 'agentmux.config.json')
    await writeFile(configPath, JSON.stringify({ version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private local' }],
      executors: { probe: { label: 'Private cat', providerId: 'codex', command: executable, args: [], env: { HOME: privateHome, CODEX_HOME: environment.CODEX_HOME }, injectAgentMuxGuide: false } },
      workspaces: [{ id: '__scratch__', name: 'Topics', hostId: 'local', path: join(root, 'topics'), kind: 'folder' }],
      appearance: { terminalTheme: 'graphite', appAppearance: 'dark' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }, notifications: { mode: 'off' } }))
    phase = 'ordinary-launch'; probe = await launch('first')
    const cdp = probe.cdp, nodes = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`
    // This is a new profile, not a seeded recovery fixture. Establish its first workspace through
    // the ordinary visible navigation before measuring the durable workface or attempting Save.
    phase = 'ordinary-Scratch-baseline'
    await waitFor('ordinary Topics overview', () => cdp.evaluate(`Boolean(document.querySelector('.space-topics-tree button[aria-label="Topics overview"]')?.getClientRects().length)`))
    await cdp.evaluate(`document.addEventListener('click',event=>{if(event.target instanceof Element&&event.target.closest('.space-topics-tree button[aria-label="Topics overview"]'))window.__hostBaselineEvent={trusted:event.isTrusted,action:'Topics overview'}},{once:true,capture:true})`)
    await activate(cdp, nodes('.space-topics-tree button[aria-label="Topics overview"]'))
    await waitFor('normally persisted Scratch baseline', () => cdp.evaluate(`(()=>{const raw=localStorage.getItem('agentmux-workbench-v1');if(!raw)return false;const state=JSON.parse(raw).state;return state.activeWorkspaceId==='__scratch__'&&Boolean(state.restoredWorkbench?.layouts.__scratch__)})()`))
    const baselineAction = await cdp.evaluate('window.__hostBaselineEvent')
    assert.deepEqual(baselineAction, { trusted: true, action: 'Topics overview' })
    receipt.facts.baselineConstruction = { ...baselineAction, ordinaryNewProfile: true, noSeedOrStorageWrite: true }
    await activate(cdp, nodes('.window-status-bar button[aria-label="Settings"]'))
    await activate(cdp, `${nodes('.settings-sidebar nav button')}.filter(node=>node.textContent.trim()==='Hosts')`)
    await waitFor('actual Host pane', () => cdp.evaluate('Boolean(document.querySelector(\'[data-settings-pane="hosts"]:not([hidden])\'))'))
    await cdp.evaluate(`(()=>{window.__hostDraftEvents=[];window.__hostPublications=[];window.agentmux.config.onChange(config=>window.__hostPublications.push(config));for(const type of ['input','click','keydown'])document.addEventListener(type,event=>{if(event.target instanceof Element&&event.target.closest('[data-settings-pane="hosts"]'))window.__hostDraftEvents.push({type,trusted:event.isTrusted})},true)})()`)
    await activate(cdp, `${nodes('[data-settings-pane="hosts"] button')}.filter(node=>node.textContent.trim()==='Add SSH host')`)
    const label = '[data-settings-pane="hosts"] .host-edit-grid label:nth-child(1) input', hostname = '[data-settings-pane="hosts"] .host-edit-grid label:nth-child(2) input'
    await replaceText(cdp, label, 'Authored remote'); await replaceText(cdp, hostname, 'private.invalid')
    const surface = () => cdp.evaluate(`(()=>{const raw=localStorage.getItem('agentmux-workbench-v1');if(!raw)throw Error('Missing durable workbench');const state=JSON.parse(raw).state;return{activeWorkspaceId:state.activeWorkspaceId,workbench:state.restoredWorkbench,focus:state.agentFocus,drafts:state.agentComposerDrafts,visibleTabs:[...document.querySelectorAll('[data-workbench-tab-id]')].map(node=>node.dataset.workbenchTabId),appShellCount:document.querySelectorAll('.app-shell').length}})()`)
    const before = await surface(); assert.equal(before.appShellCount, 1); assert.equal(before.activeWorkspaceId, '__scratch__'); assert.ok(before.workbench.layouts.__scratch__)
    const bytes = await readFile(configPath), committed = await cdp.evaluate('window.agentmux.config.get()')
    assert.equal(committed.hosts.length, 1); assert.equal(committed.hosts[0].id, 'local')
    phase = 'actual-runtime-refusal'
    await activate(cdp, `${nodes('[data-settings-pane="hosts"] .settings-pane-actions button')}.filter(node=>node.textContent.trim()==='Save hosts')`)
    const refusal = await waitFor('actual preparation error', () => cdp.evaluate(`document.querySelector('[data-settings-pane="hosts"] [role="alert"]')?.textContent`))
    assert.ok(refusal.includes('Remote AgentMux Runs are not available until the ctxmux Remote contract is delivered.'), 'Current actual remote preparation refusal must remain explicit')
    const draft = await cdp.evaluate(`({label:document.querySelector(${JSON.stringify(label)}).value,hostname:document.querySelector(${JSON.stringify(hostname)}).value,saveDisabled:document.querySelector('[data-settings-pane="hosts"] .settings-pane-actions button').disabled,events:window.__hostDraftEvents,publications:window.__hostPublications})`)
    assert.equal(draft.label, 'Authored remote'); assert.equal(draft.hostname, 'private.invalid'); assert.equal(draft.saveDisabled, false)
    assert.ok(draft.events.length > 0); assert.equal(draft.events.filter(event => !event.trusted).length, 0); assert.deepEqual(draft.publications, [])
    assert.deepEqual(await readFile(configPath), bytes); assert.deepEqual(await cdp.evaluate('window.agentmux.config.get()'), committed); assert.deepEqual(await surface(), before)
    const sessions = await cdp.evaluate('window.agentmux.sessions.snapshot()'); assert.ok(sessions.sessions.length > 0)
    assert.equal(sessions.sessions.find(value => value.id === session.agentSessionId)?.control.run.runId, session.run.runId)
    Object.assign(receipt.facts, { refusal, code: 'REMOTE_UNSUPPORTED (bound actual Core path)', baseline: before, configurationUnchanged: true, configSha256: digest(bytes), draft, noRemoteCapabilityAdded: true })
    // The existing disclosure closes when hostname becomes nonempty. Inspect the retained draft
    // through its ordinary summary; this changes no field, config, workbench or Runtime fact.
    if (!await cdp.evaluate('document.querySelector(".host-edit-disclosure").open')) await activate(cdp, nodes('.host-edit-disclosure summary'))
    const visibleDraft = await cdp.evaluate(`(()=>{const fields=[${JSON.stringify(label)},${JSON.stringify(hostname)}].map(selector=>{const node=document.querySelector(selector),r=node.getBoundingClientRect();return{value:node.value,visible:node.isConnected&&r.width>0&&r.height>0&&getComputedStyle(node).visibility==='visible'}});return{fields,events:window.__hostDraftEvents}})()`)
    assert.deepEqual(visibleDraft.fields, [{ value: 'Authored remote', visible: true }, { value: 'private.invalid', visible: true }])
    assert.ok(visibleDraft.events.length > 0); assert.equal(visibleDraft.events.filter(event => !event.trusted).length, 0)
    receipt.facts.visibleRetainedDraft = visibleDraft
    await cdp.evaluate('Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect?.getTiming().iterations)).map(a=>a.finished.catch(()=>{}))).then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))')
    await writeFile(join(evidence, 'actual-refusal.png'), Buffer.from((await cdp.call('Page.captureScreenshot')).data, 'base64'))
    receipt.facts.screenshotSha256 = digest(await readFile(join(evidence, 'actual-refusal.png')))
    phase = 'same-local-run-input'; client = await connectLocalAgentMux({ store })
    const after = (await client.listRuns()).find(run => run.runId === session.run.runId)
    assert.equal(after.state, 'running'); assert.equal(after.pid, originalRun.pid); assert.equal(after.acceptedInputBytes, originalRun.acceptedInputBytes)
    await client.writeTerminal(session.run, { ownerInstanceId: client.runtimeIdentity().instanceId, operationId: randomUUID(), expectedByte: after.acceptedInputBytes, data: 'private-input-after-host-refusal\r' })
    await waitFor('same Run accepts explicit input', async () => (await client.listRuns()).find(run => run.runId === session.run.runId)?.acceptedInputBytes > after.acceptedInputBytes)
    receipt.facts.run = { runId: session.run.runId, pid: after.pid, sameProcess: true, settingsWroteNoInput: true, privateInputAccepted: true }
  } catch (error) { failure = error }
  finally {
    if (process.argv.includes('--hold-for-watchdog')) await writeFile(join(root, 'inner-finally-reached'), 'driver finally executed\n')
    for (const connection of connections) connection.close()
    const errors = []
    for (const action of [async () => { for (const child of children) { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } } },
      async () => { if (client) { try { if (session) await client.stopAgent(session.agentSessionId, session.run) } finally { await client.dispose() } } },
      async () => { await reapRegistered(root); await stopProbeProcesses(process.pid + 1000000000, root); assert.deepEqual(await listProbeProcesses(process.pid + 1000000000, root), []); receipt.cleanup.privateProcessesReaped = true }]) {
      try { await action() } catch (error) { errors.push(error) }
    }
    if (errors.length) { failure ??= errors[0]; receipt.cleanup.errors = errors.map(error => error.message) }
    for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  }
  receipt.passed = !failure; receipt.phase = phase; receipt.failure = failure ? { name: failure.name, message: failure.message } : null
  await writeFile(join(evidence, 'native-refusal.json'), JSON.stringify(receipt, null, 2) + '\n')
  if (failure) { console.error(failure.stack); process.exitCode = 1 }
}
