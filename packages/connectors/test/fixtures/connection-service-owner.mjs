import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import * as core from '@agentmux/core'

// Run the actual Host sources with Node's type transform; only local .js source imports need resolution.
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(source))) return next(source.href, context)
    }
    throw error
  }
} })
const root = process.argv[2], mode = process.argv[3]
if (mode === 'execution') {
  const { startAgentMuxHost } = await import('../../../../apps/host/src/host.ts')
  const { createDesktopExternalInputAuthority } = await import('../../../../apps/host/src/external-input-authority.ts')
  const authority = createDesktopExternalInputAuthority({ desktopSocketPath: join(root, 'service.sock'), executionHostId: 'local' })
  let checks = 0, release
  const held = Number(process.argv[4])
  process.on('message', message => { if (message.kind === 'release-authority') release?.() })
  const store = new core.AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  if (held === 5) {
    const commit = store.compareAndSwapMetadata.bind(store)
    let paused = false
    store.compareAndSwapMetadata = async (...args) => {
      await commit(...args)
      const next = args[1]?.promptCompletionAdmission
      if (!paused && next?.submissionId.startsWith('ingress-message-') && !next.acknowledged) {
        paused = true
        process.send({ kind: 'authority-held', phase: 'original-claim-saved' })
        await new Promise(resolve => { release = resolve })
      }
    }
  }
  core.AgentMuxClient.prototype.connect = async function () {
    await this.registry.load('local'); this.connected = true
    const cursors = new Map(), writes = new Map()
    const run = runId => ({ runId, lifecycleOperationId: null, program: 'claude', args: [], workspacePath: root, pid: null,
      state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursors.get(runId) ?? 0, nativeService: null })
    this.kernel.isConnected = () => true
    this.kernel.status = async runId => run(runId)
    this.kernel.identity = () => ({ daemonInstanceId: 'controlled-runtime', protocolVersion: 1, buildIdentity: 'controlled-io' })
    this.kernel.input = async (runId, input) => {
      const key = JSON.stringify([runId, input.operationId]), saved = writes.get(key)
      if (saved) return { run: run(runId), appliedByteRange: saved }
      const startByte = cursors.get(runId) ?? 0
      if (startByte !== input.expectedByte) throw new Error('Original ordered byte claim changed')
      const appliedByteRange = { startByte, endByte: startByte + Buffer.byteLength(input.data) }
      writes.set(key, appliedByteRange); cursors.set(runId, appliedByteRange.endByte)
      await appendFile(join(root, 'execution-effects'), JSON.stringify({ runId, operationId: input.operationId, data: input.data }) + '\n')
      process.send({ kind: 'input-applied' })
      return { run: run(runId), appliedByteRange }
    }
    this.kernel.observeOutput = async runId => ({ run: run(runId), gap: null, terminal: { type: 'not-requested' }, resizeRevision: 1, replay: [], close: async () => {} })
    this.kernel.attach = async () => { throw new Error('No test attachment is required') }
    this.kernel.detach = async () => {}; this.kernel.stop = async () => { throw new Error('Healthy Run must remain available') }
    this.providers.get('claude').planPromptInput = text => ({ kind: 'single-phase', data: text + '\r' })
  }
  await startAgentMuxHost({ store, socketPath: join(root, 'semantic.sock'),
    desktopSocketPath: join(root, 'service.sock'), mobileBuildDirectory: join(root, 'absent-mobile-assets'),
    externalInputAuthority: { assertCurrent: async (author, intent) => {
      if (++checks === held && held !== 5) { process.send({ kind: 'authority-held', checks }); await new Promise(resolve => { release = resolve }) }
      return await authority.assertCurrent(author, intent)
    } } })
} else {
  const { createConnectionServices } = await import('../../src/connection-services.ts')
  const owner = await createConnectionServices({ directory: root, adapters: [] })
  const service = owner.connections.service, configure = service.configure.bind(service)
  service.configure = async input => {
    const result = await configure(input)
    if (mode === 'drop-policy-reply') { process.send({ kind: 'policy-committed' }); return await new Promise(() => {}) }
    return result
  }
  const server = new core.AgentMuxControlServer({ socketPath: join(root, 'service.sock'), connections: owner.connections, coreClients: () => [] })
  await server.start()
}
process.send({ kind: 'ready' })
