// Run outside the tested Linux Host. Both public SDK and compiled CLI cross real SSH.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
const [coreRoot, requestPath, reportPath] = process.argv.slice(2).map(value => resolve(value))
const request = JSON.parse(await readFile(requestPath, 'utf8')), { checkpoint, endpoint } = request
assert.equal(endpoint.transport, 'ssh')
assert.equal(endpoint.socketPath, checkpoint.socketPath)
const { connectAgentMuxRpc } = await import(pathToFileURL(join(coreRoot, 'dist/index.js')).href)
const rpc = await connectAgentMuxRpc({ endpoint })
const report = { schema: 'agentmux.portable-channel-ssh-observer.v1', passed: false, checkpoint, endpoint }
report.sdk = await Promise.all(['dist/index.js', 'dist/public-rpc-client.js'].map(async name => {
  const path = join(coreRoot, name); return { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
}))
try {
  const owner = await rpc.call('runtime.owner.identity', {})
  assert.equal(owner.owner.runtimeId, checkpoint.owner.runtimeId)
  assert.equal(owner.owner.ownerInstanceId, checkpoint.owner.ownerInstanceId)
  const agent = await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: checkpoint.agentSessionId } })
  assert.equal(agent.session.run.runId, checkpoint.runId)
  assert.equal(agent.session.nativeHandle.sessionId, checkpoint.native.sessionId)
  const ingress = await rpc.call('connection.ingress.ls', { connectionId: 'discord-connection' })
  const deliveries = await rpc.call('connection.delivery.ls', { connectionId: 'discord-connection', bindingId: 'original-binding', bindingRevision: 1 })
  if (checkpoint.stage === 'reopened') {
    assert.equal(ingress.ingresses.length, 1)
    const exact = await rpc.call('connection.ingress.inspect', { ingressId: ingress.ingresses[0].ingressId })
    assert.equal(exact.inputReceipt.status, 'terminal-confirmed')
    assert.ok(deliveries.deliveries.some(value => value.reference.source.kind === 'native' && value.state === 'confirmed'))
  }
  await rpc.dispose()
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes', '-o', 'StrictHostKeyChecking=yes']
  if (endpoint.port) args.push('-p', String(endpoint.port))
  if (endpoint.identityFile) args.push('-i', endpoint.identityFile)
  const destination = endpoint.user ? endpoint.user + '@' + endpoint.host : endpoint.host
  const { stdout: nativeHashes } = await promisify(execFile)('ssh', [...args, '--', destination,
    ['sha256sum', '--', checkpoint.cli.path, endpoint.command].map(quote).join(' ')], { timeout: 30_000 })
  const hashes = nativeHashes.trim().split('\n').map(line => line.slice(0, 64))
  assert.equal(hashes[0], checkpoint.cli.sha256)
  assert.match(hashes[1], /^[0-9a-f]{64}$/u)
  report.remoteCli = { compiled: checkpoint.cli, launcher: { path: endpoint.command, sha256: hashes[1] } }
  const remote = [endpoint.command, '--endpoint', 'unix:' + endpoint.socketPath, 'agent', 'inspect', '--session', checkpoint.agentSessionId]
  const { stdout } = await promisify(execFile)('ssh', [...args, '--', destination, remote.map(quote).join(' ')], { timeout: 30_000 })
  const cli = JSON.parse(stdout)
  assert.equal(cli.result.session.run.runId, checkpoint.runId)
  assert.equal(cli.result.session.nativeHandle.sessionId, checkpoint.native.sessionId)
  Object.assign(report, { passed: true, owner: owner.owner, nativeSession: agent.session.nativeHandle, ingress, deliveries, cli, clientsDisposed: true })
} catch (error) { report.failure = { code: error.code, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { await rpc.dispose(); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n') }
if (report.passed) process.stdout.write(JSON.stringify({ stage: checkpoint.stage, runtimeId: checkpoint.owner.runtimeId,
  runId: checkpoint.runId, clientsDisposed: true, observerSHA256: createHash('sha256').update(await readFile(reportPath)).digest('hex') }) + '\n')
