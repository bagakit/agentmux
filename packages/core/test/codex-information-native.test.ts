import { fork } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const qualification = ['codex', 'integration'].includes(process.env.AMX_INFORMATION_MODE ?? '') ||
  ['native', 'integration'].includes(process.env.AMX_MODEL_SYNC_MODE ?? '')

it.runIf(qualification)('installed Codex old-capability actor reaches independent public information and model-control CLI without a model request', async () => {
  if (process.platform !== 'darwin') throw new Error('This owned native proof requires its actual macOS process owner.')
  const candidate = process.env.AMX_INFORMATION_CANDIDATE
  if (!candidate) throw new Error('This native product proof requires the exact compiled gate candidate.')
  const root = await mkdtemp(join(tmpdir(), 'amx-codex-information-'))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const env = objectCliEnvironment(root, { HOME: root, USERPROFILE: root,
    NODE_OPTIONS: '--import=' + pathToFileURL(resolve(import.meta.dirname, 'fixtures/agent-information-loader.mjs')).href,
    AGENTMUX_TEST_OBJECT_CLI: join(candidate, 'core/bin/amux'),
    ...(process.env.AGENTMUX_TEST_CODEX_BINARY ? { AGENTMUX_TEST_CODEX_BINARY: process.env.AGENTMUX_TEST_CODEX_BINARY } : {}) })
  const owner = fork(resolve(import.meta.dirname, 'fixtures/codex-information-native-owner.mjs'), [root], { env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let diagnostic = ''; owner.stderr!.on('data', bytes => { diagnostic += bytes })
  const exited = new Promise(resolve => owner.once('exit', resolve))
  let cleanupReceipt: Record<string, unknown> | undefined
  const close = async () => {
    if (owner.exitCode !== null || owner.signalCode !== null) {
      expect(owner.exitCode, diagnostic).toBe(0)
      expect(cleanupReceipt, 'The original owner must report its completed cleanup.').toBeDefined()
      return cleanupReceipt
    }
    const closing = message()
    owner.send({ type: 'close' }); const timeout = setTimeout(() => owner.kill('SIGKILL'), 5000)
    try {
      const receipt = await closing
      expect(receipt).toMatchObject({ type: 'closed', cleanup: { nativeExited: true, nativeProcessGone: true,
        nativeBackendGone: true, networkConnections: 0, configUnchanged: true, configFileUnwritten: true, modelHttpRequests: 0 } })
      expect(await exited, diagnostic).toBe(0)
      cleanupReceipt = receipt.cleanup
      return cleanupReceipt
    } finally { clearTimeout(timeout) }
  }
  cleanup.push(async () => { await close() })
  const message = () => new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The private native owner did not reply: ' + diagnostic)), 15000)
    owner.once('message', value => { clearTimeout(timeout); resolve(value) })
    owner.once('error', error => { clearTimeout(timeout); reject(error) })
    owner.once('exit', code => { clearTimeout(timeout); reject(new Error('Native owner exited ' + code + ': ' + diagnostic)) })
  })
  const original = await message(); expect(original.type, diagnostic).toBe('ready')
  expect(original.version.trim()).not.toBe('')
  expect(original.command).toBe(process.env.AGENTMUX_TEST_CODEX_BINARY ?? 'codex')
  if (original.launcher) expect(original.launcher).toMatchObject({ executable: expect.any(String), sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) })
  if (original.nativeBinary) {
    expect(original.nativeBinary).toMatchObject({ executable: expect.any(String), device: expect.any(String), inode: expect.any(String) })
    expect(original.nativeBinary.sha256).toMatch(/^[0-9a-f]{64}$/u)
  }
  expect(original.actor).toMatchObject({ protocolId: 'codex-app-server-v2-0.163', actorId: 'private-information-actor',
    lifecycleOperationId: 'private-information-lifecycle', configurationObservationDeclared: false })
  const cli = async (args: string[], input?: unknown) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + original.endpoint, ...args], env,
      input === undefined ? '' : JSON.stringify(input), 15000)
    expect(result.code, result.stderr + result.stdout).toBe(0)
    return JSON.parse(result.stdout).result
  }
  const infoArgs = ['agent', 'information', 'inspect', '--host', 'local', '--session', original.input.agentSessionId, '--run', original.input.expectedRun.runId]
  const before = await cli(infoArgs)
  expect(before.snapshot).toMatchObject({ nativeSessionId: original.nativeId, model: { id: original.initialModel, scope: 'next-turn' } })
  expect(before.snapshot.plan).toBeUndefined()
  expect(before.configuration).toBeNull()
  const configuration = await cli(['agent', 'configuration', 'inspect', '--host', 'local', '--session', original.input.agentSessionId, '--run', original.input.expectedRun.runId])
  expect(configuration.target).toEqual(before.target)
  expect(configuration.snapshot.options).toEqual([expect.objectContaining({ id: 'model', category: 'model', currentValue: original.initialModel })])
  expect(configuration.snapshot.observation).toMatchObject({ state: 'confirmed', issue: { code: 'AGENT_CONFIGURATION_OBSERVATION_UNSUPPORTED' } })
  expect(configuration.snapshot.observation.sequence).toBeUndefined()
  const input = { target: configuration.target, operationId: 'native-original-model-selection', configId: 'model', value: original.selectedModel,
    expectedRevision: configuration.snapshot.revision }
  const receipt = await cli(['agent', 'configuration', 'set', '--input', '-'], input)
  expect(receipt).toMatchObject({ outcome: 'applied', operationId: input.operationId, target: before.target,
    acknowledgement: { options: [{ currentValue: original.selectedModel }] } })
  expect(await cli(['agent', 'configuration', 'set', '--input', '-'], input)).toEqual(receipt)
  const after = await cli(infoArgs)
  expect(after.target).toEqual(before.target); expect(after.snapshot.nativeSessionId).toBe(original.nativeId)
  expect(after.snapshot.model.id).toBe(original.selectedModel)
  expect(after.configuration).toEqual(receipt.acknowledgement)
  const pending = message(); owner.send({ type: 'stats' }); const stats = await pending
  expect(stats.thread).toMatchObject({ id: original.nativeId, model: original.selectedModel, canAcceptDirectInput: true, status: { type: 'idle' } })
  expect(stats.thread.sessionId).toBe(original.nativeRuntimeSessionId)
  expect(stats.runtimeWrites).toBe(0); expect(stats.turnEvents).toBe(0); expect(stats.configUnchanged).toBe(true); expect(stats.exited).toBe(false)
  expect(stats.configFileUnwritten).toBe(true)
  expect(stats.network.filter((request: { method: string }) => request.method !== 'GET')).toEqual([])
  expect(stats.nativeMethods.filter((method: string) => method === 'thread/start')).toHaveLength(1)
  expect(stats.nativeMethods).not.toContain('turn/start')
  const trace = process.env.AMX_MODEL_SYNC_NATIVE_TRACE
  const requests = trace ? (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const connections = new Set(requests.filter(frame => frame.threadId === original.nativeId).map(frame => frame.connection))
  const originalRequests = requests.filter(frame => connections.has(frame.connection) && frame.phase === 'send' && frame.method)
  if (trace) {
    const setters = originalRequests.filter(frame => frame.method === 'thread/settings/update')
    expect(setters).toHaveLength(1); expect(setters[0].id).toBe(receipt.nativeOperationId)
    expect(originalRequests.filter(frame => frame.method === 'turn/start')).toEqual([])
    expect(originalRequests.filter(frame => frame.method === 'thread/start')).toHaveLength(1)
  }
  const closed = await close()
  await rm(root, { recursive: true, force: true })
  const rootRemoved = await access(root).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error })
  expect(rootRemoved).toBe(true)
  const proof = { command: original.command, version: original.version, launcher: original.launcher, nativeBinary: original.nativeBinary,
    fingerprintIssues: original.fingerprintIssues, nativeId: original.nativeId, nativeRuntimeSessionId: stats.thread.sessionId,
    nativeProcessId: original.nativePid, actor: original.actor, initialModel: original.initialModel, selectedModel: original.selectedModel,
    before, configuration, input, receipt, after, stats, cleanup: { ...closed, rootRemoved },
    nativeRequestCounts: Object.fromEntries([...new Set(originalRequests.map(frame => frame.method))].sort().map(method => [method, originalRequests.filter(frame => frame.method === method).length])) }
  if (process.env.AMX_INFORMATION_NATIVE_EVIDENCE) await writeFile(process.env.AMX_INFORMATION_NATIVE_EVIDENCE, JSON.stringify(proof, null, 2) + '\n')
  console.info('Installed native Codex old-actor proof:', JSON.stringify({ command: proof.command, version: proof.version, launcher: proof.launcher,
    nativeBinary: proof.nativeBinary, fingerprintIssues: proof.fingerprintIssues, nativeId: proof.nativeId,
    actor: proof.actor, turnEvents: stats.turnEvents, modelHttpRequests: stats.network.filter((request: { method: string }) => request.method !== 'GET').length,
    runtimeWrites: stats.runtimeWrites, configUnchanged: stats.configUnchanged, configFileUnwritten: stats.configFileUnwritten,
    nativeRequestCounts: proof.nativeRequestCounts, cleanup: proof.cleanup }))
}, 60000)
