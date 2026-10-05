import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("tmp") } }))
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => <textarea /> }))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { resolveGoalsPreferences } from '../src/shared/goals-preferences'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { parseSettingsCommand } from '../../../packages/core/src/settings-cli'
import { executeSettingsControl } from '../src/main/settings-control'
import { ConfigStore } from '../src/main/config-store'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const key = 'goals.requesterAsSupervisor'
const checkbox = () => dom.container.querySelector<HTMLInputElement>('[aria-label="Use the requesting Agent as Supervisor"]')!
const save = () => dom.click('[data-settings-pane="goals"] [data-settings-save-bar] button')
beforeEach(() => useAppStore.setState({ config: structuredClone(composerConfig), loading: false, error: null,
  sessions: [composerSession('healthy-source')], demands: {}, detectExecutors: async () => {}, checkHost: async () => {} }))

it('requester Supervisor setting actual Source CLI executable saves through private public socket and Main ConfigOwner', async () => {
  const f = await configOwnerFixture(), directory = await mkdtemp(join(tmpdir(), 'amux-supervisor-setting-'))
  const require = createRequire(import.meta.url), { build } = createRequire(require.resolve('vite'))('esbuild')
  const repository = resolve(import.meta.dirname, '../../..'), cli = join(directory, 'agentmux.mjs')
  const server = new AgentMuxControlServer({ execute: async request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Wrong owner')
    return executeSettingsControl(request, f.owner)
  } }, join(directory, 'control.sock'))
  try {
    await build({ entryPoints: [join(repository, 'packages/core/src/agentmux.ts')], outfile: cli, bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
      alias: { '@agentmux/demand/goals': join(repository, 'packages/demand/src/goals.ts'), '@agentmux/demand': join(repository, 'packages/demand/src/index.ts'),
        '@scure/base': join(repository, 'node_modules/.pnpm/@scure+base@2.2.0/node_modules/@scure/base/index.js') },
      banner: { js: "import { createRequire as bundleRequire } from 'node:module'; const require=bundleRequire(import.meta.url);" } })
    await server.start()
    const run = promisify(execFile), args = [cli, '--endpoint', `unix:${server.path}`, 'settings']
    const env = { ...process.env, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined }
    const inspect = JSON.parse((await run(process.execPath, [...args, 'inspect', key], { env, timeout: 10000 })).stdout).result
    expect(inspect.entries[0]).toMatchObject({ key, value: true, default: true })
    const saved = JSON.parse((await run(process.execPath, [...args, 'set', key, 'false'], { env, timeout: 10000 })).stdout).result
    expect(saved.entry.value).toBe(false)
    expect((await new ConfigStore(f.store.filePath).get()).goals).toEqual({ requesterAsSupervisor: false })
    useAppStore.setState({ config: f.owner.current })
    await dom.render(<SettingsPanel initialSection="goals" onClose={() => {}} />)
    expect(checkbox().checked).toBe(false)
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }) }
}, 20000)

it('requester Supervisor setting crosses original GUI, RPC and durable ConfigOwner with authored defaults and no Agent actions', async () => {
  const f = await configOwnerFixture()
  useAppStore.setState({ config: f.owner.current })
  const facts = { sessions: useAppStore.getState().sessions, demands: useAppStore.getState().demands,
    tabs: useAppStore.getState().tabs, layouts: useAppStore.getState().layouts }
  const input = vi.spyOn(api.sessions, 'write'), launch = vi.spyOn(api.sessions, 'launchAgent')
  let pendingWrite: Promise<import('../src/shared/contracts').AppConfig> | undefined
  const write = vi.spyOn(api.config, 'save').mockImplementation((value, expected) => pendingWrite = (async () => {
    const saved = await f.owner.edit(expected!, value)
    useAppStore.setState({ config: saved }); return saved
  })())
  const rpc = new AgentMuxRpcService({ execute: async request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Wrong owner')
    return executeSettingsControl(request, f.owner)
  } })
  const call = async (args: string[]) => { const command = await parseSettingsCommand(args)
    return rpc.call(command.method, command.params, { transport: 'unix', principal: { kind: 'user', id: 'setting-proof' } }) }
  await dom.render(<SettingsPanel initialSection="goals" onClose={() => {}} />)
  expect(checkbox().checked).toBe(true)
  expect(resolveGoalsPreferences(undefined).requesterAsSupervisor).toBe(true)
  expect((await call(['inspect', key])).entries).toEqual([{ key, kind: 'boolean', value: true, default: true }])
  expect(f.owner.current.goals).toBeUndefined()
  expect(dom.container.textContent).toContain('Continue starts separately')
  await dom.click('[aria-label="Use the requesting Agent as Supervisor"]')
  // Another original client first writes a different Goals field while this draft is open.
  await call(['set', 'goals.showFinished', 'true'])
  await act(async () => useAppStore.setState({ config: f.owner.current }))
  await save()
  await act(async () => { await pendingWrite })
  expect(write).toHaveBeenCalledTimes(1)
  expect(f.owner.current.goals).toEqual({ showFinished: true, requesterAsSupervisor: false })
  expect((await new ConfigStore(f.store.filePath).get()).goals).toEqual(f.owner.current.goals)
  expect((await call(['inspect', key])).entries[0].value).toBe(false)
  await call(['set', key, 'true'])
  await act(async () => useAppStore.setState({ config: f.owner.current }))
  expect(checkbox().checked).toBe(true)
  expect((await new ConfigStore(f.store.filePath).get()).goals?.requesterAsSupervisor).toBe(true)
  for (const value of ['TRUE', '1']) await expect(call(['set', key, value])).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  expect(() => f.store.validate({ ...f.owner.current, goals: { requesterAsSupervisor: 'true' } })).toThrow()
  expect(input).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
  for (const [field, value] of Object.entries(facts)) expect(useAppStore.getState()[field as keyof typeof facts]).toBe(value)
})

it('requester Supervisor setting preserves dirty choice on write failure and later edits while save is pending', async () => {
  const f = await configOwnerFixture(), release = deferred<void>()
  useAppStore.setState({ config: f.owner.current })
  let pendingWrite: Promise<import('../src/shared/contracts').AppConfig> | undefined
  const write = vi.spyOn(api.config, 'save').mockRejectedValueOnce(new Error('Controlled write failure')).mockImplementation((value, expected) => pendingWrite = (async () => {
    await release.promise
    const saved = await f.owner.edit(expected!, value); useAppStore.setState({ config: saved }); return saved
  })())
  await dom.render(<SettingsPanel initialSection="goals" onClose={() => {}} />)
  await dom.click('[aria-label="Use the requesting Agent as Supervisor"]'); await save()
  expect(checkbox().checked).toBe(false)
  expect(dom.container.querySelector('[role=alert]')?.textContent).toContain('Controlled write failure')
  expect(f.owner.current.goals).toBeUndefined()
  await save()
  expect(write.mock.calls[1]![1]?.goals?.requesterAsSupervisor).toBe(true)
  await dom.click('[aria-label="Use the requesting Agent as Supervisor"]')
  await act(async () => { release.resolve(); await pendingWrite })
  expect(f.owner.current.goals?.requesterAsSupervisor).toBe(false)
  expect(checkbox().checked).toBe(true)
  expect(dom.container.textContent).toContain('Unsaved changes')
})
