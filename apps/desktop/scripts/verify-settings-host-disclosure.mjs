import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'
import { activate, click, key, desktopFixture } from './fixtures/settings-cli/desktop.mjs'

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
    join(desktop, 'test/settings-host-draft.test.tsx'), join(desktop, 'test/settings-host-disclosure.test.tsx')]
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
  const root = await mkdtemp('/tmp/amx-host-disclosure-'), evidence = join(repository, '.tmp/settings-host-disclosure/runs', `run-${Date.now()}-${randomUUID()}`)
  const receipt = { schema: 'agentmux.settings-host-disclosure-proof.v1', passed: false, sourceBefore: {}, sourceAfter: {}, cleanup: {}, userAppRunTouched: false }
  let failure
  try {
    await mkdir(evidence, { recursive: true }); receipt.sourceBefore = await identity()
    receipt.sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim()
    receipt.modes = []
    const watchdog = process.argv.includes('--watchdog-only')
    for (const mode of process.argv.includes('--new-host-only') || watchdog ? ['new'] : ['new', 'saved']) {
      const modeRoot = join(root, mode); await mkdir(modeRoot)
      let runReady = false
      const outcome = await runProbeProcess(process.execPath, [import.meta.filename, '--driver', `--mode=${mode}`,
        `--probe-root=${modeRoot}`, `--evidence=${evidence}`, ...(watchdog ? ['--hold-for-watchdog'] : [])], {
        temporaryRoot: root, cwd: repository, env: process.env, timeoutMs: watchdog ? 20000 : 120000,
        onLine: line => { runReady ||= line === 'host_draft_private_run_ready'; console.error(line) }
      })
      if (watchdog) {
        assert.equal(runReady, true); assert.equal(outcome.timedOut, true); assert.equal(outcome.exitCode, 1)
        await assert.rejects(readFile(join(modeRoot, 'inner-finally-reached')), { code: 'ENOENT' })
        receipt.watchdog = { ...outcome, runReady }
      } else {
        // Preserve the driver's actual facts and assertion, including a causal RED.
        const facts = JSON.parse(await readFile(join(evidence, `${mode}.json`), 'utf8'))
        receipt.modes.push({ mode, outcome, facts, sha256: digest(await readFile(join(evidence, `${mode}.json`))) })
        assert.equal(outcome.exitCode, 0); assert.equal(outcome.timedOut, false); assert.equal(outcome.interruption, null)
        assert.equal(facts.passed, true)
      }
    }
    receipt.sourceAfter = await identity(); assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore); receipt.passed = true
  } catch (error) { failure = error; receipt.failure = { name: error.name, message: error.message } }
  finally {
    const cleanupErrors = []
    for (const action of [async () => { receipt.cleanup.registered = {}; for (const mode of ['new', 'saved']) receipt.cleanup.registered[mode] = await reapRegistered(join(root, mode)) },
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
  const root = option('--probe-root'), evidence = option('--evidence'), mode = option('--mode'); assert.ok(root && evidence); assert.ok(['new', 'saved'].includes(mode))
  const privateHome = join(root, 'home'), userData = join(root, 'user-data'), runtimeDirectory = join(root, 'runtime'), workspace = join(root, 'workspace')
  const environment = { HOME: privateHome, CODEX_HOME: join(privateHome, 'codex'), AGENTMUX_DESKTOP_USER_DATA: userData,
    AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory, AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') }
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
  const fixtureIds = ['ssh-disclosure-a', 'ssh-disclosure-b']
  const beforeRuntimePrepare = mode === 'saved' ? async (main, callFrameId) => {
    const seam = await main.call('Debugger.evaluateOnCallFrame', { callFrameId, returnByValue: true, expression: `(() => {
      const allowed = ${JSON.stringify(fixtureIds)}, runtime = args.runtime, prepare = runtime.prepare.bind(runtime)
      globalThis.__hostDisclosurePreparation = []
      runtime.prepare = async next => {
        const remote = next.hosts.filter(host => host.kind === 'ssh')
        if (remote.length !== 2 || remote.some(host => !allowed.includes(host.id)) || next.workspaces.some(workspace => workspace.hostId !== 'local')) throw Error('Private SSH metadata seam escaped its exact fixture')
        globalThis.__hostDisclosurePreparation.push({ ids: remote.map(host => host.id), localRuntimeReal: true, remoteRuntimeProvided: false })
        return await prepare({ ...next, hosts: next.hosts.filter(host => host.kind === 'local') })
      }
      return { installed: true, exactIds: allowed, onlyPreparationControlled: true }
    })()` })
    assert.equal(seam.exceptionDetails, undefined)
    assert.deepEqual(seam.result.value, { installed: true, exactIds: fixtureIds, onlyPreparationControlled: true })
  } : undefined
  const launch = desktopFixture({ desktopRoot: desktop, root, privateHome, environment, children, connections, waitFor, beforeRuntimePrepare })
  const receipt = { schema: 'agentmux.settings-host-disclosure-native.v1', passed: false, fixture: 'ordinary-new-empty-Scratch; no seed/flush/reseed/manual storage write/user App', mode, preparationSeam: mode === 'saved' ? { purpose: 'Only construction/publication of two exact saved SSH metadata fixtures; real ConfigStore/registered owner/native UI, original local Runtime; no remote capability', ids: fixtureIds } : null, facts: {}, cleanup: {} }
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
    assert.equal(originalRun?.state, 'running'); assert.ok(originalRun.pid > 1); const originalBirth = await liveIdentity(originalRun.pid); register(originalBirth)
    console.error('host_draft_private_run_ready')
    if (process.argv.includes('--hold-for-watchdog')) await new Promise(() => {})
    await client.dispose(); client = null
    const configPath = join(userData, 'agentmux.config.json')
    await writeFile(configPath, JSON.stringify({ version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private local' }, ...(mode === 'saved' ? fixtureIds.map((id, index) => ({ id, kind: 'ssh', label: `Saved remote ${index + 1}`, hostname: `saved-${index + 1}.invalid` })) : [])],
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
    receipt.facts.baselineConstruction = { ...baselineAction, ordinaryNewProfile: true, noSeedOrManualStorageWrite: true }
    await activate(cdp, nodes('.window-status-bar button[aria-label="Settings"]'))
    await activate(cdp, `${nodes('.settings-sidebar nav button')}.filter(node=>node.textContent.trim()==='Hosts')`)
    await waitFor('actual Host pane', () => cdp.evaluate('Boolean(document.querySelector(\'[data-settings-pane="hosts"]:not([hidden])\'))'))
    await cdp.evaluate(`(()=>{window.__hostDraftEvents=[];window.__hostPublications=[];window.agentmux.config.onChange(config=>window.__hostPublications.push(config));for(const type of ['input','click','keydown'])document.addEventListener(type,event=>{if(event.target instanceof Element&&event.target.closest('[data-settings-pane="hosts"]'))window.__hostDraftEvents.push({type,trusted:event.isTrusted})},true)})()`)
    const hostPane = '[data-settings-pane="hosts"]:not([hidden])'
    const details = index => `${hostPane} .host-settings-card:nth-child(${index + 2}) .host-edit-disclosure`
    const hostname = index => `${details(index)} .host-edit-grid label:nth-child(2) input`
    const stable = () => cdp.evaluate('Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect?.getTiming().iterations)).map(a=>a.finished.catch(()=>{}))).then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))')
    const field = index => cdp.evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(hostname(index))}),details=input.closest('details'),r=input.getBoundingClientRect();return{connected:input.isConnected,sameInput:input===window.__hostConnectedInput,open:details.open,value:input.value,visible:input.checkVisibility()&&r.width>0&&r.height>0&&r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight,focused:document.activeElement===input}})()`)
    const surface = () => cdp.evaluate(`(()=>{const raw=localStorage.getItem('agentmux-workbench-v1');if(!raw)throw Error('Missing durable workbench');const state=JSON.parse(raw).state;return{activeWorkspaceId:state.activeWorkspaceId,workbench:state.restoredWorkbench,focus:state.agentFocus,drafts:state.agentComposerDrafts,visibleTabs:[...document.querySelectorAll('[data-workbench-tab-id]')].map(node=>node.dataset.workbenchTabId),appShellCount:document.querySelectorAll('.app-shell').length}})()`)
    const beforeSurface = await surface(); assert.equal(beforeSurface.appShellCount, 1); assert.equal(beforeSurface.activeWorkspaceId, '__scratch__'); assert.ok(beforeSurface.workbench.layouts.__scratch__)
    const configBefore = await cdp.evaluate('window.agentmux.config.get()'), bytesBefore = await readFile(configPath)
    receipt.facts.baseline = beforeSurface; receipt.facts.prefixes = []; receipt.facts.summaries = []; receipt.facts.frames = []
    async function summary(index, method, expected) {
      const path = `${details(index)} summary`
      const beforeEvents = await cdp.evaluate('window.__hostDraftEvents.length')
      if (method === 'mouse') await click(cdp, path)
      else {
        await cdp.evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(path)});node.scrollIntoView({block:'nearest'});node.focus();if(document.activeElement!==node)throw Error('Exact summary focus failed')})()`)
        if (method === 'Enter') await key(cdp, 'Enter', 'Enter')
        else {
          await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' })
          await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
        }
      }
      await stable()
      const state = await cdp.evaluate(`({open:document.querySelector(${JSON.stringify(details(index))}).open,focused:document.activeElement===document.querySelector(${JSON.stringify(path)}),events:window.__hostDraftEvents.slice(${beforeEvents})})`)
      assert.equal(state.open, expected); assert.equal(state.focused, true)
      assert.ok(state.events.length > 0); assert.equal(state.events.filter(event=>!event.trusted).length, 0)
      receipt.facts.summaries.push({ index, method, ...state })
    }
    async function capture(width, label) {
      await stable()
      const geometry = await cdp.evaluate(`(()=>{const bar=document.querySelector('.window-status-bar'),settings=bar.querySelector('button[aria-label="Settings"]'),r=settings.getBoundingClientRect();const hits=[[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]].map(([x,y])=>settings.contains(document.elementFromPoint(r.x+r.width*x,r.y+r.height*y)));return{width:innerWidth,statusHeight:bar.getBoundingClientRect().height,settingsVisible:settings.checkVisibility(),hits}})()`)
      assert.equal(geometry.width, width); assert.equal(geometry.statusHeight, 32); assert.equal(geometry.settingsVisible, true); assert.deepEqual(geometry.hits, [true,true,true,true,true])
      const screenshot = `${mode}-${width}-${label}.png`; await writeFile(join(evidence, screenshot), Buffer.from((await cdp.call('Page.captureScreenshot')).data, 'base64'))
      receipt.facts.frames.push({ ...geometry, screenshot, sha256: digest(await readFile(join(evidence, screenshot))) })
    }
    phase = 'actual-native-disclosure'
    if (mode === 'new') await activate(cdp, `${nodes(`${hostPane} button`)}.filter(node=>node.textContent.trim()==='Add SSH host')`)
    const count = await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(`${hostPane} .host-edit-disclosure`)}).length`)
    assert.equal(count, mode === 'new' ? 1 : 2)
    for (const width of [1480, 420, 320]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
      await stable()
      if (width === 1480 && mode === 'saved') {
        assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(details(0))}).open`), false)
        assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(details(1))}).open`), false)
        await summary(0, 'mouse', true)
      }
      const path = hostname(0)
      await cdp.evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(path)});input.scrollIntoView({block:'nearest'});window.__hostConnectedInput=input})()`)
      await click(cdp, path)
      // Native select/delete establish an empty editable draft once. Every subsequent character
      // arrives on the same input without selecting, refocusing, value assignment or a rescue click.
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, commands: ['selectAll'] })
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 })
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      await stable()
      const before = await field(0); assert.deepEqual(before, {connected:true,sameInput:true,open:true,value:'',visible:true,focused:true})
      const value = 'private.invalid'
      for (let length = 1; length <= value.length; length++) {
        await cdp.call('Input.insertText', { text: value[length - 1] }); await stable()
        const after = await field(0)
        receipt.facts.prefixes.push({ width, length, before: length === 1 ? before : undefined, after })
        if (length === 1) await capture(width, 'first-character')
        assert.deepEqual(after, {connected:true,sameInput:true,open:true,value:value.slice(0,length),visible:true,focused:true}, 'Each trusted Hostname prefix keeps the same connected visible focused input and open disclosure')
      }
      await capture(width, 'complete')
      await summary(0, 'mouse', false); await summary(0, 'Enter', true); await summary(0, 'Space', false); await summary(0, 'mouse', true)
      if (mode === 'saved') assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(details(1))}).open`), false)
    }
    assert.equal(receipt.facts.prefixes.length, 45)
    assert.deepEqual(await readFile(configPath), bytesBefore); assert.deepEqual(await cdp.evaluate('window.agentmux.config.get()'), configBefore)
    if (mode === 'saved') {
      phase = 'registered-owner-same-ID-publication'
      await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1480, height: 900, deviceScaleFactor: 1, mobile: false })
      await summary(0, 'mouse', false)
      const result = await cdp.evaluate(`(async()=>{const expected=await window.agentmux.config.get();const next={...expected,hosts:expected.hosts.map(host=>host.id===${JSON.stringify(fixtureIds[0])}?{...host,label:'Published first',hostname:'published.invalid'}:host.id===${JSON.stringify(fixtureIds[1])}?{...host,hostname:'neighbor-update.invalid'}:host)};return await window.agentmux.config.save(next,expected)})()`)
      await stable()
      assert.equal(result.hosts[1].hostname, 'published.invalid')
      assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(details(0))}).open`), false)
      assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(details(1))}).open`), false)
      assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(hostname(0))}).value`), 'private.invalid')
      assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(hostname(1))}).value`), 'neighbor-update.invalid')
      await summary(0, 'Enter', true)
      await click(cdp, hostname(0))
      const inputBefore = await field(0)
      await cdp.evaluate(`(async()=>{const expected=await window.agentmux.config.get();return await window.agentmux.config.save({...expected,hosts:expected.hosts.map(host=>host.id===${JSON.stringify(fixtureIds[0])}?{...host,label:'Published second'}:host)},expected)})()`)
      await stable(); assert.deepEqual(await field(0), inputBefore)
      const preparation = await probe.main.evaluate('globalThis.__hostDisclosurePreparation')
      assert.equal(preparation.length, 3)
      assert.deepEqual(preparation.map(value=>value.ids), [fixtureIds,fixtureIds,fixtureIds])
      receipt.facts.publication = { actualRegisteredMainOwner: true, actualConfigStore: true, preparationSeam: preparation, dirtyFieldKept: true, closedChoiceKept: true, neighborChoiceKept: true, openFocusKept: true }
      await capture(1480, 'publication')
    } else {
      phase = 'actual-remote-refusal'
      await activate(cdp, `${nodes(`${hostPane} .settings-pane-actions button`)}.filter(node=>node.textContent.trim()==='Save hosts')`)
      const refusal = await waitFor('actual remote preparation refusal', () => cdp.evaluate(`document.querySelector(${JSON.stringify(`${hostPane} [role="alert"]`)})?.textContent`))
      assert.ok(refusal.includes('Remote AgentMux Runs are not available until the ctxmux Remote contract is delivered.'))
      await stable()
      assert.deepEqual(await readFile(configPath), bytesBefore); assert.deepEqual(await cdp.evaluate('window.agentmux.config.get()'), configBefore)
      const after = await field(0); assert.equal(after.value, 'private.invalid'); assert.equal(after.open, true); assert.equal(after.visible, true)
      receipt.facts.actualRefusal = { message: refusal, noPreparationSeam: true, configurationUnchanged: true, draftKept: true }
      await capture(320, 'refusal')
    }
    assert.deepEqual(await surface(), beforeSurface)
    const events = await cdp.evaluate('window.__hostDraftEvents'); assert.ok(events.length > 45); assert.equal(events.filter(event=>!event.trusted).length, 0)
    assert.equal(events.filter(event=>event.type==='input').length, mode === 'new' ? 47 : 48)
    receipt.facts.events = events; receipt.facts.workfaceUnchanged = true
    phase = 'same-local-run-input'; client = await connectLocalAgentMux({ store })
    const after = (await client.listRuns()).find(run => run.runId === session.run.runId)
    assert.equal(after.state, 'running'); assert.equal(after.pid, originalRun.pid); assert.equal(after.acceptedInputBytes, originalRun.acceptedInputBytes)
    const birth = await liveIdentity(after.pid); assert.deepEqual(birth, originalBirth)
    await client.writeTerminal(session.run, { ownerInstanceId: client.runtimeIdentity().instanceId, operationId: randomUUID(), expectedByte: after.acceptedInputBytes, data: 'private-input-after-host-disclosure\r' })
    await waitFor('same Run accepts explicit input', async () => (await client.listRuns()).find(run => run.runId === session.run.runId)?.acceptedInputBytes > after.acceptedInputBytes)
    receipt.facts.run = { runId: session.run.runId, pid: after.pid, birth, sameProcess: true, settingsWroteNoInput: true, privateInputAccepted: true }
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
    if (errors.length) { failure ??= errors[0]; receipt.cleanup.errors = errors.map(error => ({ name: error.name, message: error.message, stack: error.stack })) }
    for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  }
  receipt.passed = !failure; receipt.phase = phase; receipt.failure = failure ? { name: failure.name, message: failure.message } : null
  await writeFile(join(evidence, `${mode}.json`), JSON.stringify(receipt, null, 2) + '\n')
  if (failure) { console.error(failure.stack); process.exitCode = 1 }
}
