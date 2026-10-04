import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxError, AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { registerIpc } from '../../../src/main/ipc'
import { DEFAULT_CONFIG } from '../../../src/main/config-store'

const [html, root, evidence, preload] = process.argv.slice(2)
assert.ok(html && root && evidence && preload)
app.setPath('userData', join(root, 'user-data')); app.setPath('sessionData', join(root, 'session-data'))
const report: any = { schema: 'agentmux.prompt-preparation-phase.actual-ipc.v1', passed: false,
  captureOnly: true, aestheticReview: 'not-performed', corePhaseProducerQualified: false, nativeHealthyRunQualified: false,
  boundary: 'Real Electron IPC/production registerIpc/preload/RuntimeController.submitPrompt. Controlled finite SDK error port and preview read-only/xterm facts; no real Agent Run or input-stage authority.',
  calls: [], corePort: [], scenes: [], frames: [], userRunTouched: false }
let activeScene = 'phase-unknown', current: any, win: BrowserWindow, disposeIpc: undefined | (() => Promise<void>)
const errorFact = (e: any) => ({ message: e.message, code: e.code, detail: e.detail, controlFailure: e.controlFailure })
const originalHandle = ipcMain.handle
ipcMain.handle = function(channel, handler) {
  if (channel !== 'sessions:submitPrompt') return originalHandle.call(this, channel, handler)
  return originalHandle.call(this, channel, async function(...args: any[]) {
    current = args[1]; const fact: any = { at: Date.now(), scene: activeScene, args: structuredClone(args.slice(1)) }; report.calls.push(fact)
    const result = await handler.apply(this, args); fact.result = structuredClone(result); fact.returnedAt = Date.now(); return result
  })
}
const durable = () => ({ kind: 'agent', agentSessionId: current.agentSessionId, providerId: 'codex', executorId: 'private', hostId: current.hostId,
  workspacePath: root, run: current.run, retiredRuns: [], createdAt: 1, updatedAt: 2 })
const finiteClient: any = { connect: async () => {}, dispose: async () => {}, onEvent: () => () => {},
  agentSession: () => durable(), statusAgent: async () => ({ session: durable(), run: { ...current.run, state: 'running' } }),
  submitAgentPrompt: async (input: any) => {
    report.corePort.push({ at: Date.now(), scene: activeScene, input: structuredClone(input) })
    const refusal = activeScene === 'phase-unknown'
      ? new AgentMuxError('本次准备未完成。', 'AGENT_PROMPT_PREPARATION_FAILED', 'private preparation transport refused', { disposition: 'not_applied', confirmedInputBytes: 0 })
      : new AgentMuxError('本次输入回执未知。', 'AGENT_PROMPT_INPUT_UNCONFIRMED', 'private original lost ACK', { disposition: 'unknown', confirmedInputBytes: 0 })
    throw refusal
  }
}
const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), async () => finiteClient)
runtime.commit({ hosts: [{ id: 'local', client: finiteClient, executionHost: { kind: 'local', dispose: async () => {} } as any,
  config: { id: 'local', kind: 'local', label: 'Private phase Host' } }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
runtime.prepare = async () => ({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
const evaluate = (code: string) => win.webContents.executeJavaScript(code)
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(code: string) {
  for (let i = 0; i < 160; i++) { if (await evaluate(code)) return; await pause(25) }
  throw new Error('Actual finite Renderer observation unavailable: ' + code)
}
async function painted() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))') }
async function click(code: string) {
  const point = await evaluate(`(()=>{const e=${code};if(!e)throw new Error('Actual precise control absent');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
}
const owner = `document.querySelector('[data-workbench-region-id="result-input-owner"]')`
const pending = `document.querySelector('.composer-pending:not([hidden])')`
const send = `${pending}.querySelector('.composer-pending__card[data-selected="true"] .composer-pending__send')`
const more = `${pending}.querySelector('.composer-pending__card[data-selected="true"] .composer-pending__more')`
const mail = `${owner}.querySelector('.composer-mailbox')`
async function frame(scene: string, theme: string, facts: any) {
  const file = `${scene}-${theme}.png`; const png = (await win.webContents.capturePage()).toPNG(); assert.ok(png.length)
  await writeFile(join(evidence, file), png); report.frames.push({ file, scene, theme, facts })
}
try {
  await app.whenReady(); await mkdir(evidence, { recursive: true })
  win = new BrowserWindow({ width: 1280, height: 900, show: true, webPreferences: { preload, contextIsolation: true, sandbox: false, nodeIntegration: false } })
  const config = { ...structuredClone(DEFAULT_CONFIG), executors: { private: { providerId: 'codex', label: 'Private', command: _hygiene_fixturePath("private/finite-port"), args: [], env: {}, injectAgentMuxGuide: false } } }
  disposeIpc = await registerIpc({ window: win, runtime, configStore: { get: async () => config } as any,
    progressLoops: { pauseTarget: async () => {}, subscribe: () => () => {} } as any,
    scratchTopics: {} as any, workspaceFiles: { dispose: async () => {} } as any })
  await win.loadFile(html); win.webContents.debugger.attach('1.3'); await until('Boolean(window.preparationPhase && document.querySelector(".composer"))')
  const scenes = ['dark', 'light'].flatMap(theme => ['phase-unknown', 'lost-ack', 'boot-cause', 'known-null'].map(scene => ({ scene, theme, viewport: 1280 })))
  scenes.push({ scene: 'boot-cause', theme: 'dark', viewport: 640 })
  for (const { scene, theme, viewport } of scenes) {
    activeScene = scene; const count = report.calls.length
    win.setContentSize(viewport, 900)
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: viewport, height: 900, deviceScaleFactor: 1, mobile: false })
    await evaluate(`preparationPhase.seed(${JSON.stringify(scene)},${JSON.stringify(theme)})`); await painted()
    const before = await evaluate('preparationPhase.facts()')
    if (scene === 'phase-unknown' || scene === 'lost-ack') {
      await click(send); await until('preparationPhase.facts().errors.length===1 && Object.keys(preparationPhase.facts().inFlight).length===0')
      assert.equal(report.calls.length, count + 1); assert.equal(report.corePort.length, count + 1)
    } else {
      await evaluate('preparationPhase.boot()'); await painted(); assert.equal(report.calls.length, count)
    }
    let facts = await evaluate('preparationPhase.facts()'); const entry = facts.queue[0]; assert.equal(facts.queue.length, 1)
    assert.equal(entry.text, before.queue[0].text); assert.equal(entry.operationId, before.queue[0].operationId); assert.equal(entry.runId, before.queue[0].runId)
    assert.equal(facts.draft, before.draft)
    if (scene === 'phase-unknown' || scene === 'lost-ack') {
      const invocation = report.calls.at(-1); assert.equal(invocation.args[1], entry.text); assert.equal(invocation.args[2], entry.operationId)
      assert.deepEqual(invocation.args[3], entry.promptCondition); assert.equal(entry.execution, 'default'); assert.notEqual(entry.promptCondition, null)
      assert.equal(facts.errors[0].code, entry.errorCode); assert.deepEqual(facts.errors[0].controlFailure, invocation.result.error.controlFailure)
    } else {
      assert.equal(entry.awaitingExplicitSend, true); assert.equal(entry.error, before.queue[0].error); assert.equal(entry.errorCode, before.queue[0].errorCode)
      assert.equal(entry.promptCondition, scene === 'known-null' ? null : undefined)
    }
    const cue = await evaluate(`(()=>{const card=${pending}.querySelector('[data-operation-id="${entry.operationId}"]'),state=card?.querySelector('.composer-pending__state');return{operationId:card?.dataset.operationId??null,label:state?.getAttribute('aria-label')??null,hiddenLabel:state?.querySelector('.composer-pending__sr-only')?.textContent??card?.querySelector('.composer-pending__sr-only')?.textContent??null,icon:state?.querySelector('svg')?.getAttribute('class')??null,headerCount:${pending}.querySelectorAll('.composer-pending__heading,.composer-pending__count').length,readerCount:${pending}.querySelectorAll('.composer-pending__reading').length}})()`)
    assert.equal(cue.operationId, entry.operationId)
    assert.equal(cue.label, scene === 'lost-ack' ? '发送结果待核实' : '本次准备未完成', 'The actual original card distinguishes preparation from unknown overall delivery')
    assert.equal(cue.hiddenLabel, cue.label); assert.ok(cue.icon); assert.equal(cue.headerCount, 0); assert.equal(cue.readerCount, 0)
    // The current product's original per-card More opens the owning Mail/Outbox.
    // Never use the removed header/large hover-reader as a new phase qualification.
    await click(more); await until(`${mail}.matches(':popover-open')&&Boolean(${mail}.querySelector('[data-record-key="queue:${entry.operationId}"]'))`)
    await click(`${mail}.querySelector('[aria-label="Message details"]')`)
    await until(`Boolean(${mail}.querySelector('.conversation-input-details__body'))`); await painted()
    facts = await evaluate('preparationPhase.facts()')
    const displayed = await evaluate(`${mail}.querySelector('.conversation-input-details__body').innerText`)
    for (const line of entry.error.split('\n').filter(Boolean)) assert.ok(displayed.includes(line), 'Original cause lines remain readable in the owning Mail details')
    if (entry.promptCondition !== null) assert.ok(displayed.includes('此前是否已提交仍待核实') || facts.text.includes('发送结果待核实'), 'Unknown overall delivery is retained separately from the preparation-stage failure')
    report.scenes.push({ scene, theme, viewport, before, after: facts, cue, displayed, ipcCalls: report.calls.length - count }); await frame(viewport === 640 ? scene + '-narrow' : scene, theme, facts)
  }
  assert.equal(report.frames.length, 9); report.passed = true
} catch (e) { report.failure = errorFact(e); report.failure.stack = (e as Error).stack }
finally {
  try { await disposeIpc?.() } catch(e) { report.cleanupError = errorFact(e); report.passed = false }
  ipcMain.handle = originalHandle
  if (win && !win.isDestroyed()) win.destroy()
  await writeFile(join(evidence, 'render.json'), JSON.stringify(report, null, 2))
  app.exit(report.passed ? 0 : 1)
}
