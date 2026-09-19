import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
    join(desktop, 'test/settings-host-draft.test.tsx'), join(desktop, 'test/settings-host-disclosure.test.tsx'), join(desktop, 'test/settings-host-feedback.test.tsx'),
    join(repository, 'pnpm-lock.yaml'), join(desktop, 'package.json')]
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
  const root = await mkdtemp('/tmp/amx-host-feedback-'), evidence = join(repository, '.tmp/settings-host-feedback/runs', `run-${Date.now()}-${randomUUID()}`)
  const receipt = { schema: 'agentmux.settings-host-feedback-proof.v1', passed: false, sourceBefore: {}, sourceAfter: {}, cleanup: {}, userAppRunTouched: false }
  let failure
  try {
    await mkdir(evidence, { recursive: true }); receipt.sourceBefore = await identity()
    receipt.sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim()
    receipt.modes = []
    const watchdog = process.argv.includes('--watchdog-only')
    for (const mode of ['new']) {
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
    receipt.passed = true
  } catch (error) { failure = error; receipt.failure = { name: error.name, message: error.message } }
  finally {
    const cleanupErrors = []
    try { receipt.sourceAfter = await identity(); assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore) } catch (error) { cleanupErrors.push(error) }
    for (const action of [async () => { receipt.cleanup.registered = {}; for (const mode of ['new']) receipt.cleanup.registered[mode] = await reapRegistered(join(root, mode)) },
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
  const root = option('--probe-root'), evidence = option('--evidence'), mode = option('--mode'); assert.ok(root && evidence); assert.equal(mode, 'new')
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
  const receipt = { schema: 'agentmux.settings-host-feedback-native.v1', passed: false,
    fixture: 'ordinary new empty Scratch and unsaved SSH draft; no seed/flush/reseed/manual storage mutation/user App',
    mode, preparationSeam: null, facts: {}, cleanup: {} }
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
    receipt.facts.baselineConstruction = { ...baselineAction, ordinaryNewProfile: true, noSeedOrManualStorageWrite: true }
    await activate(cdp, nodes('.window-status-bar button[aria-label="Settings"]'))
    await activate(cdp, `${nodes('.settings-sidebar nav button')}.filter(node=>node.textContent.trim()==='Hosts')`)
    await waitFor('actual Host pane', () => cdp.evaluate('Boolean(document.querySelector(\'[data-settings-pane="hosts"]:not([hidden])\'))'))
    await cdp.evaluate(`(()=>{window.__hostDraftEvents=[];window.__hostPublications=[];window.agentmux.config.onChange(config=>window.__hostPublications.push(config));for(const type of ['input','click','keydown'])document.addEventListener(type,event=>{if(event.target instanceof Element&&event.target.closest('[data-settings-pane="hosts"]'))window.__hostDraftEvents.push({type,trusted:event.isTrusted})},true)})()`)
    const hostPane = '[data-settings-pane="hosts"]:not([hidden])'
    const cards = `${hostPane} .host-settings-card`, remoteCard = `${cards}:nth-child(2)`, localCard = `${cards}:first-child`
    const hostname = `${remoteCard} .host-edit-grid label:nth-child(2) input`
    const stable = () => cdp.evaluate('Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect?.getTiming().iterations)).map(a=>a.finished.catch(()=>{}))).then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))')
    const surface = () => cdp.evaluate(`(()=>{const raw=localStorage.getItem('agentmux-workbench-v1');if(!raw)throw Error('Missing durable workbench');const state=JSON.parse(raw).state;return{activeWorkspaceId:state.activeWorkspaceId,workbench:state.restoredWorkbench,focus:state.agentFocus,drafts:state.agentComposerDrafts,visibleTabs:[...document.querySelectorAll('[data-workbench-tab-id]')].map(node=>node.dataset.workbenchTabId),appShellCount:document.querySelectorAll('.app-shell').length}})()`)
    const beforeSurface = await surface(); assert.equal(beforeSurface.appShellCount, 1); assert.equal(beforeSurface.activeWorkspaceId, '__scratch__'); assert.ok(beforeSurface.workbench.layouts.__scratch__)
    const configBefore = await cdp.evaluate('window.agentmux.config.get()'), bytesBefore = await readFile(configPath)
    receipt.facts.baseline = beforeSurface; receipt.facts.frames = []; receipt.facts.checking = []; receipt.facts.refusals = []; receipt.facts.longDetail = []
    await activate(cdp, `${nodes(`${hostPane} button`)}.filter(node=>node.textContent.trim()==='Add SSH host')`)
    await replaceText(cdp, hostname, 'private.invalid'); await stable()
    assert.equal(await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(cards)}).length`), 2)
    const draft = () => cdp.evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(hostname)});return {connected:input.isConnected,sameInput:input===window.__hostConnectedInput,value:input.value,open:input.closest('details').open}})()`)
    await cdp.evaluate(`void (window.__hostConnectedInput=document.querySelector(${JSON.stringify(hostname)}))`)
    const draftBefore = await draft(); assert.deepEqual(draftBefore, {connected:true,sameInput:true,value:'private.invalid',open:true})
    const test = card => activate(cdp, `${nodes(`${card} > header button`)}.filter(node=>node.textContent.trim()==='Test')`)
    const readStatus = card => cdp.evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(card)}).querySelector('header [role="status"]');return node?{text:node.textContent.trim(),visible:node.checkVisibility(),width:node.getBoundingClientRect().width}:null})()`)
    async function disclosure(selector, expectedOpen) {
      await stable()
      const fact=await cdp.evaluate(`(()=>{const matches=document.querySelectorAll(${JSON.stringify(selector)});if(matches.length!==1)throw Error('Expected one native Host disclosure');const details=matches[0],summary=details.querySelector(':scope > summary'),icons=summary.querySelectorAll('svg');if(icons.length!==1)throw Error('Expected one visible disclosure direction');summary.scrollIntoView({block:'nearest'});const icon=icons[0],rect=icon.getBoundingClientRect(),style=getComputedStyle(icon),matrix=new DOMMatrixReadOnly(style.transform==='none'?undefined:style.transform);return{open:details.open,summary:summary.textContent.trim(),connected:icon.isConnected,visible:icon.checkVisibility(),width:rect.width,height:rect.height,viewportWidth:innerWidth,transform:style.transform,matrix:[matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f]}})()`)
      ;(receipt.facts.disclosureObservations??=[]).push({selector,expectedOpen,...fact})
      assert.equal(fact.open,expectedOpen); assert.equal(fact.connected,true); assert.equal(fact.visible,true); assert.ok(fact.width>0&&fact.height>0)
      const direction=expectedOpen?-1:1
      try { assert.ok(Math.abs(fact.matrix[0]-direction)<1e-6&&Math.abs(fact.matrix[3]-direction)<1e-6,'Host disclosure direction must reflect its native open state') }
      catch(error) { await capture(fact.viewportWidth,'disclosure-direction-counterexample'); throw error }
      for(const value of fact.matrix){assert.ok(Number.isFinite(value))}
      for(const index of [1,2,4,5])assert.ok(Math.abs(fact.matrix[index])<1e-6)
      return fact
    }
    async function capture(width, label) {
      await stable()
      const geometry = await cdp.evaluate(`(()=>{const bar=document.querySelector('.window-status-bar'),settings=bar.querySelector('button[aria-label="Settings"]'),r=settings.getBoundingClientRect();return{width:innerWidth,statusHeight:bar.getBoundingClientRect().height,settingsVisible:settings.checkVisibility(),hits:[[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]].map(([x,y])=>settings.contains(document.elementFromPoint(r.x+r.width*x,r.y+r.height*y)))}})()`)
      assert.equal(geometry.width, width); assert.equal(geometry.statusHeight, 32); assert.equal(geometry.settingsVisible, true); assert.deepEqual(geometry.hits, [true,true,true,true,true])
      const screenshot = `${width}-${label}.png`; await writeFile(join(evidence, screenshot), Buffer.from((await cdp.call('Page.captureScreenshot')).data, 'base64'))
      receipt.facts.frames.push({ ...geometry, screenshot, sha256: digest(await readFile(join(evidence, screenshot))) })
    }
    async function readable(expected, label) {
      await stable()
      const fact = await cdp.evaluate(`(()=>{const card=document.querySelector(${JSON.stringify(remoteCard)}),found=card.querySelectorAll('.host-check-detail');if(found.length!==1)throw Error('Expected one nonempty Host reason');const node=found[0];node.scrollIntoView({block:'nearest'});const range=document.createRange();range.selectNodeContents(node);const rect=r=>({x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height});return{text:node.textContent,connected:node.isConnected,visible:node.checkVisibility(),detail:rect(node.getBoundingClientRect()),card:rect(card.getBoundingClientRect()),lines:[...range.getClientRects()].map(rect),clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,viewport:{width:innerWidth,height:innerHeight},status:card.querySelector('header [role="status"]')?.textContent.trim()}})()`)
      await writeFile(join(evidence, `${fact.viewport.width}-${label}.json`), JSON.stringify(fact, null, 2)+'\n')
      try {
        assert.equal(fact.text, expected); assert.equal(fact.connected, true); assert.equal(fact.visible, true); assert.equal(fact.status, 'Unavailable')
        assert.ok(fact.lines.length > 0); assert.ok(fact.detail.width > 0 && fact.detail.height > 0); assert.ok(fact.scrollWidth <= fact.clientWidth+1, 'Complete Host reason cannot be horizontally clipped')
        for (const rect of fact.lines) {
          assert.ok(Object.values(rect).every(Number.isFinite)); assert.ok(rect.width > 0 && rect.height > 0)
          assert.ok(rect.x >= fact.card.x-1 && rect.right <= fact.card.right+1 && rect.y >= fact.card.y-1 && rect.bottom <= fact.card.bottom+1, 'Every original reason line must stay inside its Host card')
          assert.ok(rect.x >= -1 && rect.right <= fact.viewport.width+1 && rect.y >= -1 && rect.bottom <= fact.viewport.height+1, 'Every original reason line must be in the visible viewport')
        }
      } catch (error) { await capture(fact.viewport.width, `${label}-counterexample`); throw error }
      return fact
    }
    await cdp.evaluate(`(()=>{window.__hostCheckStates=[];new MutationObserver(()=>{for(const [index,card] of [...document.querySelectorAll(${JSON.stringify(cards)})].entries()){const status=card.querySelector('header [role="status"]');if(!status)continue;const rect=status.getBoundingClientRect(),test=[...card.querySelectorAll('header button')].find(node=>node.textContent.trim()==='Test');const text=status.textContent.trim();if(window.__hostCheckStates.at(-1)?.text===text&&window.__hostCheckStates.at(-1)?.index===index)continue;window.__hostCheckStates.push({index,text,connected:status.isConnected,visible:status.checkVisibility(),width:rect.width,height:rect.height,testDisabled:test?.disabled,observation:'actual DOM commit; original Test unpaused and unchanged'})}}).observe(document.querySelector(${JSON.stringify(hostPane)}),{childList:true,subtree:true,characterData:true,attributes:true})})()`)
    const refusal = 'Remote AgentMux Runs are not available until the ctxmux Remote contract is delivered.'
    receipt.facts.disclosures=[]
    phase = 'actual-no-seam-Test-refusal'
    for (const width of [320,420,1480]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', {width,height:900,deviceScaleFactor:1,mobile:false}); await stable()
      const selector=`${remoteCard} .host-edit-disclosure`,states=[await disclosure(selector,true)]
      await click(cdp,`${selector} summary`); states.push(await disclosure(selector,false))
      await click(cdp,`${selector} summary`); states.push(await disclosure(selector,true))
      assert.deepEqual(await draft(),draftBefore); receipt.facts.disclosures.push({width,kind:'connection',states,trustedNativeToggle:true})
      await cdp.evaluate('window.__hostCheckStates=[]'); await test(remoteCard)
      await waitFor('original actual refusal',async()=> (await readStatus(remoteCard))?.text==='Unavailable')
      const checking=await cdp.evaluate('window.__hostCheckStates.filter(state=>state.index===1&&state.text==="Testing")')
      assert.ok(checking.length>0,'The real original Test must project a nonempty pending state')
      for(const state of checking){assert.equal(state.connected,true);assert.equal(state.visible,true);assert.ok(state.width>0&&state.height>0);assert.equal(state.testDisabled,true)}
      receipt.facts.checking.push({width,states:checking,noFunctionOrTimingSeam:true})
      const fact=await readable(refusal,'actual-refusal'); receipt.facts.refusals.push({width,...fact,noPreparationSeam:true,noResultFixture:true}); await capture(width,'actual-refusal')
      assert.deepEqual(await draft(),draftBefore)
    }
    phase = 'actual-local-ready-detail'
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:1480,height:900,deviceScaleFactor:1,mobile:false}); await test(localCard)
    await waitFor('original local check ready',async()=> (await readStatus(localCard))?.text==='Ready'); await stable()
    const readyBefore=await cdp.evaluate(`(()=>{const card=document.querySelector(${JSON.stringify(localCard)}),details=card.querySelector('.host-check-details'),p=details?.querySelector('.host-check-detail');return{open:details?.open,text:p?.textContent,visible:p?.checkVisibility(),header:card.querySelector('header').textContent}})()`)
    assert.equal(readyBefore.open,false); assert.equal(readyBefore.visible,false); assert.match(readyBefore.text,/^Runtime .+ · protocol \d+$/); assert.ok(!readyBefore.header.includes(readyBefore.text))
    const readySelector=`${localCard} .host-check-details`,readyDirections=[await disclosure(readySelector,false)]
    await click(cdp, `${localCard} .host-check-details summary`); await stable()
    readyDirections.push(await disclosure(readySelector,true))
    assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(`${localCard} .host-check-detail`)}).checkVisibility()`),true)
    receipt.facts.ready={...readyBefore,originalLocalCheck:true,trustedDetailsVisible:true}; await capture(1480,'ready-details'); await click(cdp,`${localCard} .host-check-details summary`)
    readyDirections.push(await disclosure(readySelector,false)); receipt.facts.disclosures.push({width:1480,kind:'ready-detail',states:readyDirections,trustedNativeToggle:true})
    phase = 'controlled-readonly-long-result-projection'
    const files=(await readdir(join(desktop,'out/renderer/assets'))).filter(name=>name.endsWith('.js'))
    const resultSources=[]
    for(const name of files){const path=join(desktop,'out/renderer/assets',name),lines=(await readFile(path,'utf8')).split('\n');const anchors=lines.flatMap((line,index)=>line.includes('if (hostCheckRequestIds.get(host.id) !== requestId) return;')&&lines[index-1]?.includes('const result = await api.hosts.check(host);')?[index]:[]);if(anchors.length)resultSources.push({path,anchors})}
    assert.equal(resultSources.length,1); assert.equal(resultSources[0].anchors.length,1)
    const longDetail='/private/'+ 'uninterrupteddiagnostic'.repeat(12)+'/originaldetail'
    assert.match(longDetail, /^\/private\/[a-z]{200,}\/originaldetail$/)
    await cdp.call('Debugger.enable')
    for(const width of [420,320]){
      await cdp.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false}); await stable()
      const breakpoint=await cdp.call('Debugger.setBreakpointByUrl',{url:pathToFileURL(resultSources[0].path).href,lineNumber:resultSources[0].anchors[0]})
      const action=test(remoteCard); action.catch(()=>{}); const paused=await waitFor('original returned result data boundary',()=>cdp.pauses.shift()); assert.ok(paused.hitBreakpoints.includes(breakpoint.breakpointId))
      // Only the private returned read-only diagnostic DATA is substituted, after the real
      // no-seam refusal above. No checkHost/Test/prepareHost function is replaced or wrapped.
      const fixture=await cdp.call('Debugger.evaluateOnCallFrame',{callFrameId:paused.callFrames[0].callFrameId,expression:`(()=>{const original={...result};if(result.ok!==false||result.detail!==${JSON.stringify(refusal)})throw Error('Original refusal data missing');result.detail=${JSON.stringify(longDetail)};return{original,injectedDetail:result.detail,originalFunctionsUnchanged:true,projectionDataFixtureOnly:true}})()`,returnByValue:true})
      assert.equal(fixture.exceptionDetails,undefined); assert.equal(fixture.result.value.original.detail,refusal)
      await cdp.call('Debugger.removeBreakpoint',{breakpointId:breakpoint.breakpointId}); await cdp.call('Debugger.resume'); await action
      await waitFor('literal controlled detail committed',()=>cdp.evaluate(`document.querySelector(${JSON.stringify(`${remoteCard} .host-check-detail`)})?.textContent===${JSON.stringify(longDetail)}`))
      const fact=await readable(longDetail,'controlled-long-detail'); receipt.facts.longDetail.push({width,...fact,dataFixture:fixture.result.value,notRuntimeCapability:true}); await capture(width,'controlled-long-detail')
      assert.deepEqual(await draft(),draftBefore)
    }
    await cdp.call('Debugger.disable')
    assert.equal(receipt.facts.refusals.length,3); assert.equal(receipt.facts.longDetail.length,2); assert.equal(receipt.facts.checking.length,3)
    const hint=await cdp.evaluate(`document.querySelector(${JSON.stringify(`${remoteCard} .host-edit-grid .field-hint`)}).textContent`)
    assert.ok(hint.includes('saving SSH connections are unavailable')); assert.ok(hint.includes('draft')); assert.ok(!hint.includes('can save and test')); receipt.facts.hint=hint
    assert.deepEqual(await readFile(configPath),bytesBefore); assert.deepEqual(await cdp.evaluate('window.agentmux.config.get()'),configBefore)
    assert.deepEqual(await surface(),beforeSurface); receipt.facts.workfaceUnchanged=true; receipt.facts.configurationUnchanged=true
    const events=await cdp.evaluate('window.__hostDraftEvents'); assert.ok(events.length>0); assert.equal(events.filter(event=>!event.trusted).length,0); receipt.facts.events=events
    phase = 'same-local-run-input'; client = await connectLocalAgentMux({ store })
    const after = (await client.listRuns()).find(run => run.runId === session.run.runId)
    assert.equal(after.state, 'running'); assert.equal(after.pid, originalRun.pid); assert.equal(after.acceptedInputBytes, originalRun.acceptedInputBytes)
    const birth = await liveIdentity(after.pid); assert.deepEqual(birth, originalBirth)
    await client.writeTerminal(session.run, { ownerInstanceId: client.runtimeIdentity().instanceId, operationId: randomUUID(), expectedByte: after.acceptedInputBytes, data: 'private-input-after-host-feedback\r' })
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
