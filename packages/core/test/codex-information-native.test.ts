import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it.runIf(process.platform === 'darwin')('installed Codex original actor reaches public information and model-control CLI without a model request', async () => {
  const candidate = process.env.AMX_INFORMATION_CANDIDATE
  if (!candidate) throw new Error('This native product proof requires the exact compiled gate candidate.')
  const root = await mkdtemp(join(tmpdir(), 'amx-codex-information-'))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const env = objectCliEnvironment(root, { HOME: root, USERPROFILE: root,
    NODE_OPTIONS: '--import=' + pathToFileURL(resolve(import.meta.dirname, 'fixtures/agent-information-loader.mjs')).href,
    AGENTMUX_TEST_OBJECT_CLI: join(candidate, 'core/bin/amux') })
  const owner = fork(resolve(import.meta.dirname, 'fixtures/codex-information-native-owner.mjs'), [root], { env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let diagnostic = ''; owner.stderr!.on('data', bytes => { diagnostic += bytes })
  const exited = new Promise(resolve => owner.once('exit', resolve))
  cleanup.push(async () => {
    if (owner.exitCode !== null || owner.signalCode !== null) return
    owner.send({ type: 'close' }); const timeout = setTimeout(() => owner.kill('SIGKILL'), 5000)
    try { expect(await exited, diagnostic).toBe(0) } finally { clearTimeout(timeout) }
  })
  const message = () => new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The private native owner did not reply: ' + diagnostic)), 15000)
    owner.once('message', value => { clearTimeout(timeout); resolve(value) })
    owner.once('error', error => { clearTimeout(timeout); reject(error) })
    owner.once('exit', code => { clearTimeout(timeout); reject(new Error('Native owner exited ' + code + ': ' + diagnostic)) })
  })
  const original = await message(); expect(original.type, diagnostic).toBe('ready')
  expect(original.version).toMatch(/^codex-cli \d+\.\d+\.\d+$/u)
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
  expect(before.configuration.options).toEqual([expect.objectContaining({ id: 'model', category: 'model', currentValue: original.initialModel })])
  const input = { target: before.target, operationId: 'native-original-model-selection', configId: 'model', value: original.selectedModel,
    expectedRevision: before.configuration.revision }
  const receipt = await cli(['agent', 'configuration', 'set', '--input', '-'], input)
  expect(receipt).toMatchObject({ outcome: 'applied', operationId: input.operationId, target: before.target,
    acknowledgement: { options: [{ currentValue: original.selectedModel }] } })
  expect(await cli(['agent', 'configuration', 'set', '--input', '-'], input)).toEqual(receipt)
  const after = await cli(infoArgs)
  expect(after.target).toEqual(before.target); expect(after.snapshot.nativeSessionId).toBe(original.nativeId)
  expect(after.snapshot.model.id).toBe(original.selectedModel)
  const pending = message(); owner.send({ type: 'stats' }); const stats = await pending
  expect(stats.thread).toMatchObject({ id: original.nativeId, model: original.selectedModel, canAcceptDirectInput: true, status: { type: 'idle' } })
  expect(stats.runtimeWrites).toBe(0); expect(stats.turnEvents).toBe(0); expect(stats.configUnchanged).toBe(true); expect(stats.exited).toBe(false)
  expect(stats.network.filter((request: { method: string }) => request.method !== 'GET')).toEqual([])
  expect(stats.nativeMethods.filter((method: string) => method === 'thread/start')).toHaveLength(1)
  expect(stats.nativeMethods).not.toContain('turn/start')
  console.info('Installed native Codex proof:', original.version, 'original thread model confirmed; zero model requests and Runtime writes; private config unchanged.')
}, 60000)
