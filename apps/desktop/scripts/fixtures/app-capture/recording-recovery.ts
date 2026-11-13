import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../../../../../packages/core/src/public-rpc-server.js'
import { AppRecordingOwner } from '../../../src/main/app-recording.js'
import { createAppCapturePort } from '../../../src/main/app-capture-owner.js'
import type { AppCaptureSource } from '../../../src/main/app-capture.js'

const exec = promisify(execFile), root = process.env.AGENTMUX_CAPTURE_PROOF_ROOT!, originalRoot = process.env.AGENTMUX_RECORDING_ORIGINAL_ROOT!
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const report: Record<string, any> = { passed: false, pid: process.pid, checks: [], sources: ['original saved recording', 'production AppRecordingOwner', 'real Core service', 'actual CLI', 'new OS process'] }
const owners: AppRecordingOwner[] = []
let captures = 0, sequence = 0
const source = { capture: async () => { captures++; throw new Error('Recovery must not capture another workface') } } as AppCaptureSource
const retained = new AppRecordingOwner({ directory: join(originalRoot, 'recordings'), capture: source.capture })
owners.push(retained)
const port = createAppCapturePort(source, retained), socket = join(root, 'capture.sock')
const server = new AgentMuxControlServer({ captures: port }, socket)
async function cli(method: string, params: unknown, output?: string) {
  const input = join(root, `input-${++sequence}.json`); await writeFile(input, JSON.stringify(params))
  const args = [process.env.AGENTMUX_CAPTURE_PROOF_CLI!, '--endpoint', `unix:${socket}`, ...method.split('.'), '--input', input, ...(output ? ['--output', output] : [])]
  try {
    const result = await exec(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, maxBuffer: 32 * 1024 * 1024 })
    return { ...JSON.parse(result.stdout), cliExitCode: 0 }
  } catch (error) {
    const result = error as Error & { stdout?: string; stderr?: string; code?: number }
    if (result.stdout?.trim().startsWith('{')) return { ...JSON.parse(result.stdout), cliExitCode: result.code }
    if (result.stderr?.trim().startsWith('{')) return { ...JSON.parse(result.stderr), cliExitCode: result.code }
    throw error
  }
}
try {
  await server.start()
  const read = await cli('app.record.read', { operationId: 'moving-workface' }, join(root, 'recovered.webm'))
  assert.equal(read.ok, true, JSON.stringify(read)); assert.equal(read.result.recording.state, 'completed')
  report.completedOriginal = read.result.recording
  const abandoned = new AppRecordingOwner({ directory: join(originalRoot, 'crash/recordings'), capture: source.capture })
  owners.push(abandoned); port.call = createAppCapturePort(source, abandoned).call
  const observed = await cli('app.record.inspect', { operationId: 'abandoned-original' })
  assert.equal(observed.ok, true, JSON.stringify(observed))
  assert.equal(observed.result.recording.state, 'interrupted', 'native owner restart must retain interrupted state')
  assert.equal(observed.result.recording.finishedAt, null, 'An unavailable native end time must remain unknown')
  report.interruptedOriginal = observed.result.recording
  const beforeRecovery = JSON.parse(await readFile(join(originalRoot, 'crash/recordings', `${hash('published-original')}.json`), 'utf8'))
  assert.equal(beforeRecovery.recording.state, 'stopping', 'The real producer exited before its final metadata was saved')
  assert.equal(beforeRecovery.recording.bytes, 0)
  const recoveredBytes = await cli('app.record.read', { operationId: 'published-original' }, join(root, 'partial.webm'))
  assert.equal(recoveredBytes.ok, true, JSON.stringify(recoveredBytes))
  assert.equal(recoveredBytes.result.recording.state, 'interrupted')
  const exitedProducer = JSON.parse(await readFile(join(originalRoot, 'crash/result.json'), 'utf8'))
  assert.equal(recoveredBytes.result.recording.sha256, exitedProducer.published.sha256, 'Saved original bytes survive receipt interruption')
  assert.equal(hash(await readFile(join(root, 'partial.webm'))), exitedProducer.published.sha256)
  report.partialOriginal = recoveredBytes.result.recording
  assert.equal(captures, 0, 'Recovery observes original files without new capture')
  report.checks.push('real-process-restart', 'completed-artifact-preserved', 'active-original-interrupted', 'published-bytes-recovered')
  report.passed = true
} catch (error) { report.error = error instanceof Error ? error.stack : String(error) }
finally {
  const cleanup = await Promise.allSettled([server.stop(), ...owners.map(owner => owner.dispose())])
  const failures = cleanup.filter(result => result.status === 'rejected')
  if (failures.length) { report.passed = false; report.cleanupErrors = failures.map(failure => String((failure as PromiseRejectedResult).reason)) }
  await writeFile(process.env.AGENTMUX_CAPTURE_PROOF_RESULT!, JSON.stringify(report))
  process.exitCode = report.passed ? 0 : 1
}
