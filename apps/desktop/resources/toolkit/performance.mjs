import { spawn } from 'node:child_process'
import { TextDecoder } from 'node:util'
import { parseMetricsObservation } from '@agentmux/core/control'
import { parseRpcRequest, parseRpcResponse, rpcRecord, rpcResponseError } from '@agentmux/core/public-rpc-http'
const cli = process.argv[2]
if (!cli) throw new Error('Performance requires the packaged public CLI path.')
let sequence = 0, buffer = '', ended = false, failed = false
let subscriptionId, eventSequence = 0
const decoder = new TextDecoder('utf-8', { fatal: true })
const child = spawn(process.execPath, [cli, 'system', 'metrics', 'watch'], { stdio: ['ignore','pipe','pipe'], env: process.env })
const output = value => {
  if (ended) return
  const line = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(line) > 256 * 1024 || !process.stdout.write(line)) stop('Performance output exceeded its bounded consumer.')
}
function stop(reason) {
  if (ended) return
  if (reason) {
    failed = true
    process.stdout.write(JSON.stringify({ schema: 'agentmux.toolkit.result.v1', event: 'error', reason: String(reason).slice(0,4096) }) + '\n')
  }
  ended = true; child.kill('SIGTERM')
}
process.once('SIGINT', () => stop()); process.once('SIGTERM', () => stop())
process.stdout.once('error', () => stop())
child.stdout.on('data', bytes => {
  if (ended) return
  try {
    buffer += decoder.decode(bytes, { stream: true })
    let lf
    while (!ended && (lf = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,lf); buffer = buffer.slice(lf+1)
      if (Buffer.byteLength(line) > 256 * 1024) throw new Error('Metrics frame exceeded budget.')
      const value = JSON.parse(line)
      if (subscriptionId === undefined) {
        const response = parseRpcResponse(value), failure = rpcResponseError(response)
        if (failure) throw failure
        const opening = rpcRecord(response.result, ['subscriptionId', 'method', 'initial'])
        if (opening.method !== 'system.metrics.watch' || typeof opening.subscriptionId !== 'string' || !opening.subscriptionId) {
          throw new Error('Metrics subscription opening belongs to another stream.')
        }
        const initial = rpcRecord(opening.initial, ['observation'])
        subscriptionId = opening.subscriptionId
        output({ schema: 'agentmux.toolkit.result.v1', event: 'result', sequence: ++sequence, payload: parseMetricsObservation(initial.observation) })
      } else {
        const frame = parseRpcRequest(value)
        if (frame.id !== undefined || frame.method !== 'system.subscription.event') throw new Error('Metrics stream boundary is invalid.')
        const notification = rpcRecord(frame.params, ['subscriptionId', 'method', 'sequence', 'event'])
        if (notification.subscriptionId !== subscriptionId || notification.method !== 'system.metrics.watch' ||
            !Number.isSafeInteger(notification.sequence) || notification.sequence !== eventSequence + 1) {
          throw new Error('Metrics subscription identity or sequence is invalid.')
        }
        eventSequence = notification.sequence
        const event = rpcRecord(notification.event, ['type', 'data', 'error'])
        if (event.type === 'snapshot') output({ schema: 'agentmux.toolkit.result.v1', event: 'result', sequence: ++sequence, payload: parseMetricsObservation(event.data) })
        else if (event.type === 'end') stop()
        else if (event.type === 'error') throw new Error(rpcRecord(event.error).message ?? 'Metrics query failed.')
        else throw new Error('Metrics stream boundary is invalid.')
      }
    }
    if (Buffer.byteLength(buffer) > 256 * 1024) throw new Error('Incomplete metrics frame exceeded budget.')
  } catch (error) { stop(error.message) }
})
child.stderr.on('data', bytes => { if (!ended) stop(bytes.toString('utf8')) })
child.once('error', error => stop(error.message))
child.once('close', code => {
  if (!ended) {
    try { buffer += decoder.decode() } catch (error) { stop(error.message) }
  }
  if (buffer.length && !ended) stop('Metrics ended with an incomplete NDJSON frame.')
  ended = true; process.exitCode = failed || (code !== 0 && code !== null) ? 1 : 0
})
