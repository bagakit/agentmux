import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

const terminalSource = String.raw`import assert from 'node:assert/strict'
import { readFileSync, watch } from 'node:fs'
assert.ok(process.stdin.isTTY && process.stdout.isTTY)
process.stdin.setRawMode(true)
const marker = process.argv[2]
for (let row = 0; row < 320; row++) process.stdout.write('\u001b[32mprivate-history-'+row+'\u001b[0m\r\n')
process.stdout.write('private-live-ready\r\n')
process.stdin.on('data', bytes => process.stdout.write('private-echo:'+bytes.toString()+'\r\n'))
const started = new Set()
watch(marker, () => {
  const phase = readFileSync(marker, 'utf8')
  if (!['solo', 'with', 'unrelated'].includes(phase) || started.has(phase)) return
  started.add(phase)
  let record = 0
  const timer = setInterval(() => {
    process.stdout.write('private-'+phase+'-burst-'+ ++record +'\r\n')
    if (record === 24) clearInterval(timer)
  }, 15)
})
`

export async function startTerminalNeighbor({ runtime, config, privateRoot, nodeExecutable, name = 'original' }) {
  const executable = path.join(privateRoot, 'terminal-program.mjs')
  const marker = path.join(privateRoot, name + '-burst')
  await writeFile(executable, terminalSource)
  await writeFile(marker, '')
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  const terminal = await runtime.launchTerminal({ hostId: 'local', workspacePath: config.workspaces[0].path,
    shellCommand: 'exec ' + [nodeExecutable, executable, marker].map(quote).join(' ') }, config)
  assert.equal(terminal.kind, 'terminal')
  return { reference: { id: terminal.id, runId: terminal.control.run.runId }, control: terminal.control,
    emit: phase => writeFile(marker, phase) }
}

const twoFrames = 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
const terminalSelector = '[data-workbench-region-id="terminal-region"] .xterm-screen'
const readerSelector = '[data-workbench-region-id="reading-region"] .activity-feed'
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]
function attachmentActivity(calls) {
  return calls.filter(call => ['attach', 'detach', 'replay', 'refresh', 'resize'].includes(call.kind))
}
function sameHistory(before, after) {
  assert.equal(after.sameTerminal, true)
  assert.equal(after.parent, 'terminal-region')
  assert.deepEqual(after.grid, before.grid)
  assert.deepEqual(after.bounds, before.bounds)
  assert.equal(after.buffer.type, before.buffer.type)
  assert.equal(after.buffer.top, before.buffer.top)
  assert.equal(after.buffer.viewport, before.buffer.viewport)
  assert.equal(after.color, before.color)
}

export async function exerciseTerminalNeighbor({ win, read, ready, until, click, shot, taskMetrics, calls, core,
  runtime, config, privateTerminal, nodeExecutable, append }) {
  const debuggerClient = win.webContents.debugger
  const inspect = () => read('liveTerminalProof()')
  const wheel = (point, deltaY) => debuggerClient.sendCommand('Input.dispatchMouseEvent',
    { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY })
  const untilTail = (tail) => ready(`(()=>{const state=liveTerminalProof();return state?.buffer.tail===${JSON.stringify(tail)} && state})()`)
  const visiblePoint = (selector) => read(`(()=>{const element=document.querySelector(${JSON.stringify(selector)}),r=element?.getBoundingClientRect();
    if(!r?.width||!r.height)throw Error('Original split reading region is absent');return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  const readyBefore = await untilTail('private-live-ready')
  assert.ok(readyBefore.buffer.base > 200)
  assert.equal(readyBefore.buffer.viewport, readyBefore.buffer.base)
  await click(`document.querySelector(${JSON.stringify(terminalSelector)})`)
  await ready('liveTerminalProof().focused')
  await read(twoFrames)
  const before = await inspect()
  const attachment = structuredClone(attachmentActivity(calls))
  assert.equal(attachment.filter(call => call.kind === 'attach').length, 1)
  assert.equal(attachment.find(call => call.kind === 'attach')?.runId, privateTerminal.reference.runId)
  const scrolling = []
  const scroll = async delta => {
    const state = await inspect(), started = performance.now()
    await wheel(state.bounds, delta)
    const next = await ready(`(()=>{const state=liveTerminalProof();return state.buffer.viewport ${delta < 0 ? '<' : '>'} ${state.buffer.viewport} && state})()`)
    await read(twoFrames)
    scrolling.push(performance.now() - started)
    assert.ok(next.focused)
    assert.equal(next.sameTerminal, true)
    return next
  }
  const up = await scroll(-420)
  assert.match(up.buffer.top, /^private-history-/u)
  assert.equal(up.color, 2, 'The original ANSI green is retained in the actual xterm cells')
  assert.match((await scroll(-240)).buffer.top, /^private-history-/u)
  const older = await inspect()
  const bytesFor = (snapshot, runId, field) => snapshot[field]
    .filter(event => event.run === runId).reduce((total, event) => total + event.bytes, 0)
  const oneOutputWindow = async (phase, trigger) => {
    const initial = await inspect()
    const framesFrom = await read('readingProof.metrics.frames.length')
    const before = await taskMetrics()
    await trigger()
    await untilTail('private-' + phase + '-burst-24')
    await read(twoFrames)
    const last = await inspect(), after = await taskMetrics()
    const frames = await read(`readingProof.metrics.frames.slice(${framesFrom})`)
    assert.ok(frames.length > 0)
    sameHistory(older, last)
    assert.ok(last.focused)
    assert.ok(last.buffer.base > initial.buffer.base)
    const originalBytes = bytesFor(last, privateTerminal.reference.runId, 'events') - bytesFor(initial, privateTerminal.reference.runId, 'events')
    assert.ok(originalBytes > 0, 'The original terminal receives actual live output bytes')
    return { initial, last, frames, before, after, originalBytes, frameP95: p95(frames) }
  }
  const solo = await oneOutputWindow('solo', () => privateTerminal.emit('solo'))
  const unrelated = await startTerminalNeighbor({ runtime, config, privateRoot: config.workspaces[0].path,
    nodeExecutable, name: 'unrelated' })
  // Use the same native Main/event channel for one additional private Run.
  const other = await runtime.attachSession(win.webContents.id, unrelated.control, 0, config)
  const readyOther = await until(async () => {
    const sample = await core.readRunReplay(unrelated.control.run, 0, 'raw')
    return sample.replay.some(chunk => chunk.data.includes('private-live-ready')) && sample
  }, 'the unrelated original CLI has installed its bounded output source')
  const cursorBefore = readyOther.run.latestOutputBytes
  const shared = await oneOutputWindow('with', async () => {
    await Promise.all([privateTerminal.emit('with'), unrelated.emit('unrelated')])
    const received = await ready(`(()=>{const state=liveTerminalProof();return state.ingress.some(event=>event.run===${JSON.stringify(unrelated.reference.runId)}) && state})()`)
    assert.ok(received.events.every(event => event.subscriber === event.run), 'No unrelated Run may reach a scoped renderer consumer')
  })
  const otherReplay = await until(async () => {
    const sample = await core.readRunReplay(unrelated.control.run, cursorBefore, 'raw')
    return sample.replay.some(chunk => chunk.data.includes('private-unrelated-burst-24')) && sample
  }, 'the unrelated native Run emitted its original bounded output')
  assert.equal(shared.originalBytes, solo.originalBytes, 'Hold original terminal output bytes fixed across the two conditions')
  const duringNative = await inspect()
  sameHistory(older, duringNative)
  assert.equal(duringNative.buffer.base - shared.initial.buffer.base, solo.last.buffer.base - solo.initial.buffer.base,
    'Both output windows added the same number of original visible terminal lines')
  const unrelatedBytes = bytesFor(duringNative, unrelated.reference.runId, 'ingress')
  assert.ok(unrelatedBytes > 0, 'The unrelated native Run reached the original Renderer transport')
  assert.ok(duringNative.events.every(event => event.subscriber === event.run), 'No unrelated Run may reach a scoped renderer consumer')
  await runtime.detachSession(win.webContents.id, other.attachmentId)

  const reading = await visiblePoint(readerSelector)
  const readerBefore = await read('readingProof.events.filter(event=>event.type==="wheel").length')
  await wheel(reading, -250)
  await ready(`readingProof.events.slice(${readerBefore}).some(event=>event.type==='wheel' && event.detail.trusted && event.detail.deltaY===-250)`)
  const cut = await ready('readingProof.nativeCut()')
  const recordId = await append()
  const accepted = await ready(`readingProof.appendDisposition(${JSON.stringify(cut)},${JSON.stringify(recordId)},false)`)
  await read(twoFrames)
  const duringReader = await inspect()
  sameHistory(older, duringReader)
  assert.ok(duringReader.focused, 'Passive adjacent reading and append preserve terminal focus')
  assert.deepEqual([duringReader.buffer.x, duringReader.buffer.y], [older.buffer.x, older.buffer.y])

  const flow = await read(`(()=>{const button=[...document.querySelectorAll(${JSON.stringify(readerSelector + ' .wf-head[aria-expanded="false"]')})]
    .find(node=>node.getClientRects().length);if(!button)return false;button.dataset.proofTerminalAdjacent='true';return true})()`)
  assert.equal(flow, true, 'The original adjacent Reader offers a collapsible process')
  const detail = "document.querySelector('[data-proof-terminal-adjacent]')"
  await click(detail)
  await ready(detail + '?.getAttribute("aria-expanded")==="true"')
  await click(detail)
  await ready(detail + '?.getAttribute("aria-expanded")==="false"')
  sameHistory(older, await inspect())
  await click(`document.querySelector(${JSON.stringify(terminalSelector)})`)
  await ready('liveTerminalProof().focused')

  const back = await scroll(4800)
  assert.equal(back.buffer.viewport, back.buffer.base)
  const input = []
  const acceptEcho = async (text, started) => {
    const state = await untilTail('private-echo:' + text)
    await read(twoFrames)
    input.push(performance.now() - started)
    assert.ok(state.focused)
    assert.equal(state.sameTerminal, true)
    return state
  }
  const asciiStarted = performance.now()
  await debuggerClient.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: 'z' })
  await acceptEcho('z', asciiStarted)
  const pendingInput = calls.filter(call => call.kind === 'write').length
  await debuggerClient.sendCommand('Input.imeSetComposition', { text: '组', selectionStart: 1, selectionEnd: 1 })
  const composing = await ready('(()=>{const state=liveTerminalProof();return state.input.includes("compositionstart") && state.preedit==="组" && state})()')
  assert.ok(composing.focused)
  assert.equal(calls.filter(call => call.kind === 'write').length, pendingInput, 'Preedit cannot send any native bytes')
  const imeStarted = performance.now()
  await debuggerClient.sendCommand('Input.insertText', { text: '组合' })
  const after = await acceptEcho('组合', imeStarted)
  await ready('liveTerminalProof().preedit===null')
  assert.deepEqual(after.grid, before.grid)
  assert.deepEqual(attachmentActivity(calls), attachment, 'Reading, disclosure and live bytes cannot reattach or resize the original terminal')
  const live = (await core.listRuns()).find(run => run.runId === privateTerminal.reference.runId)
  assert.equal(live?.state, 'running')
  assert.deepEqual(calls.filter(call => call.kind === 'write').map(call => [call.runId, call.bytes, call.source]), [
    [privateTerminal.reference.runId, 1, 'user'], [privateTerminal.reference.runId, 6, 'user']
  ])
  await shot('terminal-neighbor')
  return { before, up, older, duringReader, duringNative, after, live, calls, originalAttachment: attachment,
    unrelated: { runId: unrelated.reference.runId, rawBytes: otherReplay.replay.reduce((n, row) => n + row.dataBytes.byteLength, 0), rendererBytes: unrelatedBytes },
    reader: { recordId, acceptedRevision: accepted.accepted.revision }, timings: { scroll: scrolling, scrollP95: p95(scrolling),
      input, inputP95: p95(input), nativeOutput: { solo, shared } } }
}
