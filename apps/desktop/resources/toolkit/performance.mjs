import { parseToolkitResultDocument, TOOLKIT_RESULT_DOCUMENT_MAX_BYTES } from '@agentmux/core/toolkit-result-document'
import { connectToolkitResultChannel } from '@agentmux/core/toolkit-result-channel'
import { ToolkitFailureCapture, toolkitFailureError } from '@agentmux/core/toolkit-performance-failure'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { parseMetricsObservation } from '@agentmux/core/control'
import { AgentMuxRpcLines, rpcEncode, parseRpcRequest, parseRpcResponse, rpcRecord, rpcResponseError } from '@agentmux/core/public-rpc-http'
const cli = process.argv[2]
if (!cli) throw new Error('Performance requires the packaged public CLI path.')
const resultChannel = await connectToolkitResultChannel()
// Native startup/stdout/stderr remain terminal diagnostics, never result frames.
let sequence = 0, ended = false, failed = false, abandoned = false
let subscriptionId, eventSequence = 0
const frames = new AgentMuxRpcLines(), cancelled = new AbortController()
const child = spawn(process.execPath, [cli, 'system', 'metrics', 'watch'], { stdio: ['ignore','pipe','pipe'], env: process.env })
const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
const utf8 = new TextEncoder()
const captureFailure = process.env.AGENTMUX_PERFORMANCE_CAPTURE_FAILURE === '1'
let stage = 'cli-spawn', frame, stdoutCursor = 0, stderrCursor = 0
const stderrCapture = captureFailure ? new ToolkitFailureCapture('metrics-rpc-stderr', 0) : null
function documentFor(observation) {
  const totals = observation.runTotals, runs = observation.process.data ?? []
  const document = { schema: 'agentmux.toolkit.result.v1', summary: 'Runs',
    items: [
      { label: 'Tracked Runs', value: totals ? String(totals.coverage.trackedRuns) : 'Unknown' },
      { label: 'Observed roots', value: totals ? String(totals.coverage.observedRoots) : 'Unknown' },
      { label: 'Missing roots', value: totals ? String(totals.coverage.missingRoots) : 'Unknown' },
      { label: 'Processes · unique PID union', value: totals?.processCount == null ? 'Unknown' : String(totals.processCount) },
      { label: 'CPU · 10s peak of same-batch readings', value: totals?.cpuPercent == null ? 'Unknown' : String(totals.cpuPercent) + '%' },
      { label: 'RSS · latest PID sum (KiB)', value: totals?.rssKib == null ? 'Unknown' : String(totals.rssKib) }
    ], links: [], notice: observation.process.state === 'available' ? '' : (observation.process.state + (observation.process.reason ? ': ' + observation.process.reason : '')).slice(0, 4096),
    agentCards: { fields: ['avatar', 'name', 'status', 'provider', 'workspace'], items: [], omittedItems: runs.length } }
  let bytes = utf8.encode(JSON.stringify(document)).length
  for (const run of runs) {
    if (document.agentCards.items.length === 128) break
    const reference = { kind: 'run', hostId: run.hostId, runId: run.runId }
    const card = { reference, metrics: [] }
    const extra = utf8.encode(JSON.stringify(card)).length + (document.agentCards.items.length ? 1 : 0)
    // The original omission count has at least as many digits as its final value.
    if (bytes + extra > TOOLKIT_RESULT_DOCUMENT_MAX_BYTES) break
    bytes += extra; document.agentCards.items.push(card); document.agentCards.omittedItems--
  }
  return parseToolkitResultDocument(document)
}
async function result(value) {
  stage = 'cli-metrics-payload'
  const observation = parseMetricsObservation(value)
  stage = 'cli-document'
  const document = documentFor(observation)
  stage = 'cli-output'
  await output({ schema: 'agentmux.toolkit.result.v1', event: 'result', sequence: ++sequence,
    payload: observation, document, diagnostics: { stderrBytes: stderrCursor, stderr: stderrCursor ? stderrCapture?.value ?? null : null } })
}
async function output(value) {
  if (ended) return
  // write(false) has admitted this frame. Wait before consuming another one.
  if (!resultChannel.write(rpcEncode(value))) await once(resultChannel, 'drain', { signal: cancelled.signal })
}
function stop(error, details) {
  if (ended) return
  ended = true; cancelled.abort(); child.kill('SIGTERM')
  if (error !== undefined) {
    failed = true
    const failure = details ?? { stage, error: toolkitFailureError(error, captureFailure), bytes: frame?.value ?? null, diagnosticOutput: stderrCursor && stderrCapture ? [stderrCapture.value] : [], exit: null }
    resultChannel.write(rpcEncode({ schema: 'agentmux.toolkit.result.v1', event: 'error', reason: failure.error.message, failure }))
  }
}
function cancel() { abandoned = true; stop() }
process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
resultChannel.once('error', () => stop()); resultChannel.once('close', () => stop())
child.stderr.on('data', bytes => {
  // Stderr is diagnostic output, not the typed RPC failure channel. Drain without
  // building a queue; retain only the original bounded head/tail on explicit capture.
  stderrCapture?.append(bytes); stderrCursor += bytes.length
})
child.once('error', error => stop(error, { stage: 'cli-spawn', error: toolkitFailureError(error, captureFailure), bytes: null, exit: null }))
async function accept(value) {
  if (subscriptionId === undefined) {
    stage = 'cli-rpc-opening'
    const response = parseRpcResponse(value), failure = rpcResponseError(response)
    if (failure) throw failure
    const opening = rpcRecord(response.result, ['subscriptionId', 'method', 'initial'])
    if (opening.method !== 'system.metrics.watch' || typeof opening.subscriptionId !== 'string' || !opening.subscriptionId) {
      throw new Error('Metrics subscription opening belongs to another stream.')
    }
    const initial = rpcRecord(opening.initial, ['observation'])
    subscriptionId = opening.subscriptionId
    await result(initial.observation)
    return
  }
  stage = 'cli-rpc-notification'
  const frame = parseRpcRequest(value)
  if (frame.id !== undefined || frame.method !== 'system.subscription.event') throw new Error('Metrics stream boundary is invalid.')
  const notification = rpcRecord(frame.params, ['subscriptionId', 'method', 'sequence', 'event'])
  if (notification.subscriptionId !== subscriptionId || notification.method !== 'system.metrics.watch' ||
      !Number.isSafeInteger(notification.sequence) || notification.sequence !== eventSequence + 1) {
    throw new Error('Metrics subscription identity or sequence is invalid.')
  }
  eventSequence = notification.sequence
  const event = rpcRecord(notification.event, ['type', 'data', 'error'])
  if (event.type === 'snapshot') await result(event.data)
  else if (event.type === 'end') stop()
  else if (event.type === 'error') {
    const failure = rpcRecord(event.error)
    const error = new Error(failure.message ?? 'Metrics query failed.')
    if (typeof failure.code === 'string') error.code = failure.code
    throw error
  }
  else throw new Error('Metrics stream boundary is invalid.')
}
try {
  // Feed at most one complete frame at a time to the public decoder. Awaiting
  // its output also bounds reading when one pipe chunk contains several frames.
  for await (const bytes of child.stdout) {
    let offset = 0
    while (!ended && offset < bytes.length) {
      const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline + 1
      let value, complete = false
      if (captureFailure) {
        frame ??= new ToolkitFailureCapture('metrics-rpc-stdout', stdoutCursor)
        frame.append(bytes.subarray(offset, end))
      }
      stdoutCursor += end - offset
      stage = 'cli-rpc-json'
      frames.accept(bytes.subarray(offset, end), frame => { value = frame; complete = true })
      if (complete) { await accept(value); frame = undefined }
      offset = end
    }
    if (ended) break
  }
  if (!ended) { stage = 'cli-eof'; frames.end() }
} catch (error) { if (!ended) stop(error) }
const exit = await closed
if (!ended && (exit.code !== 0 || exit.signal !== null)) {
  const error = new Error('Metrics CLI exited unsuccessfully.')
  stop(error, { stage: 'cli-eof', error: toolkitFailureError(error, captureFailure), bytes: frame?.value ?? (stderrCursor ? stderrCapture?.value ?? null : null), diagnosticOutput: stderrCursor && stderrCapture ? [stderrCapture.value] : [], exit })
}
process.exitCode = failed || (exit.code !== 0 && exit.code !== null) ? 1 : 0
// Explicit cancellation discards this reader's pending output, after the
// original CLI child has closed. Normal end/EOF still flushes every frame.
if (abandoned) { resultChannel.destroy(); process.exit(process.exitCode) }
else resultChannel.end()
