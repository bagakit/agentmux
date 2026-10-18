import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { sessionObservationResult } from '../../../src/shared/session-observation-result'

const [directory, evidence] = process.argv.slice(2) as [string, string]
app.setPath('userData', join(directory, 'user-data'))
app.setPath('sessionData', join(directory, 'session-data'))
app.disableHardwareAcceleration()
let window: BrowserWindow, mode = 'typed', failureCode = 'CONTROL_CONNECTION_FAILED', passed = 0
const reports: any[] = [], calls: Array<{ channel: string; args: unknown[] }> = [], cases: string[] = []
const body = new TextEncoder().encode('original private continuation\r\n')
const control = { kind: 'terminal', hostId: 'local', runId: 'original-run', run: { runId: 'original-run' } }
const session = { id: 'original-run', kind: 'terminal', hostId: 'local', workspacePath: directory, providerId: null, label: 'Private terminal',
  createdAt: 1, updatedAt: 1, latestOutputBytes: body.length, status: { state: 'running', source: 'run-process', observedAt: 1 }, processState: 'running', control }
const original = { attachmentId: 'original-lease', session, currentSize: { cols: 80, rows: 24 }, terminal: { type: 'unknown', reason: 'origin_unknown' },
  resizeRevision: 0, replay: [{ run: control.run, startByte: 0, endByte: body.length, dataBytes: body }], gap: null }
ipcMain.on('ui:themeBootstrap', event => { event.returnValue = { status: 'unavailable', message: 'Private transport proof does not mount appearance.' } })
const channels = ['conversationLandmarks:list', 'conversationLandmarks:apply', 'sessions:attach', 'sessions:refreshAttachment', 'sessions:replay', 'sessions:restart', 'sessions:controlContinuity']
for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => {
  calls.push({ channel, args })
  if (mode === 'timeout' && channel === 'sessions:restart') return new Promise(() => {})
  return sessionObservationResult(async () => {
    if (mode === 'typed' || (mode === 'recover' && channel === 'sessions:attach')) throw Object.assign(new Error('Same display text for every classification.'), { code: failureCode, detail: 'original machine detail' })
    if (mode === 'unknown') throw new Error('Same display text for every classification.')
    if (channel === 'conversationLandmarks:list') return { hostId: 'local', agentSessionId: 'private-agent', revision: 0, points: [], recordedOperation: null }
    if (channel === 'conversationLandmarks:apply') return { hostId: 'local', agentSessionId: 'private-agent', revision: 1, points: [],
      recordedOperation: { input: args[0], actor: { kind: 'user', id: 'private-user' }, revision: 1 } }
    if (channel === 'sessions:replay') return { replay: original.replay, gap: null }
    if (channel === 'sessions:restart') return { agentSessionId: 'private-agent', expectedRun: control.run, previousRun: control.run,
      operationId: 'original-operation', phase: 'unconfirmed', canRetry: false, observedAt: 1 }
    if (channel === 'sessions:controlContinuity') return { hostId: 'local', result: { state: 'retired',
      retirement: { agentSessionId: 'private-agent', hostId: 'local', run: control.run, source: 'user', observedAt: 1 },
      receipt: { request: args[1], outcome: 'cancelled', reason: 'explicit-cancel', activeAttemptOperationId: 'original-attempt',
        attemptCount: 1, attemptLimitBefore: 1, attemptLimitAfter: 1, phaseAtCommit: 'cancelled', observedAt: 1 } } }
    return original
  })
})
ipcMain.handle('sessions:resize', (_event, _id, cols, rows) => ({ cols, rows }))
ipcMain.handle('sessions:detach', () => {})
ipcMain.handle('clientIncidents:open', () => ({ producerInstanceId: 'private-producer' }))
ipcMain.handle('clientIncidents:report', (_event, _producer, report) => { reports.push(report); return { accepted: true } })
const evaluate = (code: string) => window.webContents.executeJavaScript(code)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(read: () => Promise<any>, accept: (value: any) => boolean) {
  for (let i = 0; i < 180; i++) { const value = await read(); if (accept(value)) return value; await delay(25) }
  throw new assert.AssertionError({ message: 'Actual isolated terminal consumer did not settle to its expected state.' })
}
async function run() {
  await app.whenReady(); app.dock?.hide()
  window = new BrowserWindow({ show: false, width: 800, height: 500, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: join(directory, 'preload.cjs') } })
  window.webContents.on('console-message', (_event, ...args) => console.log('private-page', ...args))
  window.webContents.on('preload-error', (_event, _path, error) => console.error('private-preload', error))
  const preferences = window.webContents.getLastWebPreferences()
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false)
  await window.loadFile(join(directory, 'renderer/index.html'))
  await until(() => evaluate('typeof window.bridgeProof'), value => value === 'object')
  cases.push('seven actual isolated observation methods preserve original code and detail')
  const all = await evaluate('bridgeProof.everyMethod()')
  assert.equal(all.length, 7)
  for (const failure of all) { assert.equal(failure.code, 'CONTROL_CONNECTION_FAILED', 'Page-world observation code must survive both real Electron boundaries'); assert.equal(failure.detail, 'original machine detail') }
  assert.deepEqual([...new Set(calls.map(call => call.channel))].sort(), [...channels].sort()); passed++
  cases.push('seven original successful observation payloads reach the page without nested envelopes')
  mode = 'success'
  const success = await evaluate('bridgeProof.everyMethod()')
  assert.equal(success.length, 7)
  assert.ok(success.every((value: any) => value.code === null && value.returned && value.returned.ok === undefined))
  assert.equal(success[0].returned.revision, 0); assert.equal(success[1].returned.recordedOperation.input.operationId, 'original-landmark')
  assert.deepEqual(success[2].returned.session.control, control); assert.equal(success[3].returned.attachmentId, 'original-lease')
  assert.equal(success[4].returned.replay[0].endByte, body.length); assert.equal(success[5].returned.operationId, 'original-operation')
  assert.equal(success[6].returned.result.retirement.run.runId, 'original-run'); passed++


  // Accelerate only the existing 60s timeout in the isolated preload world; the original budget is observed.
  cases.push('existing restart timeout crosses the same plain bridge without a second timer')
  mode = 'timeout'
  await window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: `globalThis.originalTimer=setTimeout;globalThis.observedBudgets=[];globalThis.setTimeout=(callback,ms,...args)=>{if(ms===60000){observedBudgets.push(ms);return originalTimer(callback,1,...args)}return originalTimer(callback,ms,...args)};true` }])
  try { const result = await evaluate('bridgeProof.restart()'); assert.equal(result.code, 'SESSION_RESTART_UNCONFIRMED') }
  finally { await window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: 'globalThis.setTimeout=originalTimer;true' }]) }
  assert.deepEqual(await window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: 'observedBudgets' }]), [60000]); passed++

  cases.push('actual page-side finite recovery consumer preserves same target and original success')
  mode = 'recover'; calls.length = 0
  await evaluate(`bridgeProof.observe(${JSON.stringify(control)})`)
  const live = await until(() => evaluate('bridgeProof.read()'), value => value.result?.attachmentId === 'original-lease')
  assert.equal(live.result.replay[0].endByte, body.length); assert.deepEqual(live.result.session.control, control)
  const attaches = calls.filter(call => call.channel === 'sessions:attach'), refreshes = calls.filter(call => call.channel === 'sessions:refreshAttachment')
  assert.equal(attaches.length, 1); assert.equal(refreshes.length, 1)
  assert.deepEqual(refreshes[0]!.args, [control, null, 0]); assert.deepEqual(live.failures, [{ code: 'CONTROL_CONNECTION_FAILED' }]); passed++

  for (const code of ['CONTROL_PROTOCOL_ERROR', null]) {
    cases.push(code ? 'protocol failure remains a service window' : 'plain unknown remains a service window')
    mode = code ? 'typed' : 'unknown'; failureCode = code ?? ''; calls.length = 0
    await evaluate(`bridgeProof.observe(${JSON.stringify(control)})`)
    await until(() => evaluate('bridgeProof.read()'), value => value.failures?.length === 1)
    await delay(650)
    assert.equal(calls.filter(call => call.channel === 'sessions:attach').length, 1)
    assert.equal(calls.filter(call => call.channel === 'sessions:refreshAttachment').length, 0)
    const final = await evaluate('bridgeProof.read()'); assert.equal(final.result, undefined); assert.equal(final.failures[0].code, code ?? 'SESSION_OBSERVATION_UNCONFIRMED'); passed++
  }
  await evaluate('bridgeProof.dispose()')
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ ok: true, pid: process.pid, passed, cases, preferences: {
    sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration }, calls, reports,
    scope: 'Actual production preload, page API and finite recovery helper; private Main envelope producer only. Prior mounted Main/PTY proof composes at the unchanged API success/failure seam; no actual Runtime or user application.' }, null, 2) + '\n')
}
run().then(() => { window?.destroy(); app.quit() }).catch(error => {
  writeFileSync(join(evidence, 'failure.json'), JSON.stringify({ name: error.name, message: error.message, stack: error.stack, pid: process.pid, passed, cases, calls }, null, 2) + '\n')
  console.error(error); window?.destroy(); app.exit(1)
})
