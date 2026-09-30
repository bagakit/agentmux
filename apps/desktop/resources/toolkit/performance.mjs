import { spawn } from 'node:child_process'
import { TextDecoder } from 'node:util'
const cli = process.argv[2]
if (!cli) throw new Error('Performance requires the packaged public CLI path.')
let sequence = 0, buffer = '', ended = false, failed = false
const decoder = new TextDecoder('utf-8', { fatal: true })
const child = spawn(process.execPath, [cli, 'metrics', 'watch'], { stdio: ['ignore','pipe','pipe'], env: process.env })
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
      const frame = JSON.parse(line)
      if (frame.ok !== true || frame.operation !== 'metrics.watch') throw new Error(frame.error?.message ?? 'Metrics query failed.')
      if (frame.event === 'snapshot') output({ schema: 'agentmux.toolkit.result.v1', event: 'result', sequence: ++sequence, payload: frame.result.observation })
      else if (frame.event === 'end') stop()
      else if (frame.event !== 'attached') throw new Error('Metrics stream boundary is invalid.')
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
