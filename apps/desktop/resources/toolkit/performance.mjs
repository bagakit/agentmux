import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { parseMetricsObservation, parseToolkitResultDocument, TOOLKIT_RESULT_DOCUMENT_MAX_BYTES } from '@agentmux/core/control'
import { AgentMuxRpcLines, rpcEncode, parseRpcRequest, parseRpcResponse, rpcRecord, rpcResponseError } from '@agentmux/core/public-rpc-http'
const cli = process.argv[2]
if (!cli) throw new Error('Performance requires the packaged public CLI path.')
let sequence = 0, ended = false, failed = false, abandoned = false
let subscriptionId, eventSequence = 0
const frames = new AgentMuxRpcLines(), cancelled = new AbortController()
const child = spawn(process.execPath, [cli, 'system', 'metrics', 'watch'], { stdio: ['ignore','pipe','pipe'], env: process.env })
const closed = new Promise(resolve => child.once('close', resolve))
const utf8 = new TextEncoder()
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
  const observation = parseMetricsObservation(value)
  await output({ schema: 'agentmux.toolkit.result.v1', event: 'result', sequence: ++sequence,
    payload: observation, document: documentFor(observation) })
}
async function output(value) {
  if (ended) return
  // write(false) has admitted this frame. Wait before consuming another one.
  if (!process.stdout.write(rpcEncode(value))) await once(process.stdout, 'drain', { signal: cancelled.signal })
}
function stop(reason) {
  if (ended) return
  ended = true; cancelled.abort(); child.kill('SIGTERM')
  if (reason) {
    failed = true
    process.stdout.write(rpcEncode({ schema: 'agentmux.toolkit.result.v1', event: 'error', reason: String(reason).slice(0,4096) }))
  }
}
function cancel() { abandoned = true; stop() }
process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
process.stdout.once('error', () => stop()); process.stdout.once('close', () => stop())
child.stderr.on('data', bytes => stop(bytes.toString('utf8')))
child.once('error', error => stop(error.message))
async function accept(value) {
  if (subscriptionId === undefined) {
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
  else if (event.type === 'error') throw new Error(rpcRecord(event.error).message ?? 'Metrics query failed.')
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
      frames.accept(bytes.subarray(offset, end), frame => { value = frame; complete = true })
      if (complete) await accept(value)
      offset = end
    }
    if (ended) break
  }
  if (!ended) frames.end()
} catch (error) { if (!ended) stop(error.message) }
const code = await closed
process.exitCode = failed || (code !== 0 && code !== null) ? 1 : 0
// Explicit cancellation discards this reader's pending output, after the
// original CLI child has closed. Normal end/EOF still flushes every frame.
if (abandoned) process.exit(process.exitCode)
