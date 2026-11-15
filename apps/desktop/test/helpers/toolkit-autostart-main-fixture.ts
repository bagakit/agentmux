import { afterEach, expect, vi } from 'vitest'
import { appendFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AgentMuxControlServer, AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { ConfigStore } from '../../src/main/config-store.js'
import { ConfigOwner } from '../../src/main/config-owner.js'
import { RuntimeController } from '../../src/main/runtime-controller.js'
import { ToolkitOwner } from '../../src/main/toolkit-owner.js'
import { toolkitRuntime } from './toolkit-runtime.fixture.js'
import { localRuntimeConnector } from './local-runtime-connector.js'

const environment = vi.hoisted(() => ({ directory: process.cwd() }))
vi.mock('electron', () => ({ app: { getPath: () => environment.directory, getAppPath: () => resolve('apps/desktop') } }))
const execute = promisify(execFile)
const evidence = process.env.AGENTMUX_TOOLKIT_EVIDENCE
let endpoint = ''
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
export async function record(name: string, value: unknown) {
  if (evidence) { await mkdir(evidence, { recursive: true }); await appendFile(join(evidence, name + '.jsonl'), JSON.stringify(value) + '\n') }
}
export async function until(check: () => Promise<void>) { await vi.waitFor(check, { timeout: 10000, interval: 25 }) }
export async function oneCli(...args: string[]) {
  const result = await execute(process.execPath, [resolve('packages/core/dist/agentmux.js'), '--endpoint', endpoint, ...args], { env: process.env })
  return JSON.parse(result.stdout)
}
export async function nativeMain() {
  const native = await toolkitRuntime(), directory = native.directory
  environment.directory = directory
  for (const key of Object.keys(process.env)) if (key.startsWith('AGENTMUX_') || key.startsWith('CTXMUX_')) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', directory)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(directory, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(directory, 'messages.ndjson'))
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', join(directory, 'sessions.json'))
  endpoint = 'unix:' + join(directory, 'toolkit.sock')
  let store!: ConfigStore
  let runtime!: RuntimeController, toolkit!: ToolkitOwner, server!: AgentMuxControlServer
  async function open() {
    store = new ConfigStore(join(directory, 'config.json'))
    let config = await store.get()
    const owner = new ConfigOwner({ read: () => config,
      prepare: (current, next) => toolkit.prepareConfig(current, next), save: next => store.save(next),
      publish: next => { config = next; toolkit.configurationChanged() } })
    runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
    runtime.commit(await runtime.prepare(config))
    toolkit = new ToolkitOwner({ config: owner, receiptPath: join(directory, 'toolkit-receipts.json'),
      openRunPort: () => runtime.toolkitRunPort(), enabled: () => false,
      launch: () => ({ runner: process.execPath, cli: resolve('packages/core/dist/agentmux.js'),
        script: resolve('apps/desktop/resources/toolkit/performance.mjs'), cwd: directory, env: { PATH: directory } }) })
    server = new AgentMuxControlServer({ coreClients: () => [], execute: async () => { throw new Error('Unexpected non-Toolkit operation') }, toolkit }, join(directory, 'toolkit.sock'))
    await server.start()
    await toolkit.load()
  }
  async function closeOwners() { await server?.stop(); await toolkit?.dispose(); await runtime?.dispose() }
  cleanup.push(async () => {
    await closeOwners()
    for (const run of await native.activation.client.list()) {
      if (run.state.type === 'running') await native.activation.client.stop(await native.activation.client.prepareStop(run.id))
      await native.activation.client.remove(run.id)
    }
    const result = await native.cleanup()
    await record('autostart-cleanup', result)
    expect(result.childExit).toBe('confirmed'); expect(result.namespace).toBe('removed')
  })
  await open()
  return { directory, get store() { return store }, async restart() { await closeOwners(); await open() } }
}
