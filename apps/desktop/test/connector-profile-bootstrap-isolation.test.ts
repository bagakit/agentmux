import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { ConnectionPort } from '@agentmux/core/connections'
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'

const fixture = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await vi.importActual<typeof import('node:os')>('node:os')
  const { join } = await import('node:path')
  const bootstrap = await mkdtemp(join(tmpdir(), 'amux-connector-profile-bootstrap-'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(bootstrap, 'state'))
  vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE', join(bootstrap, 'state', 'spatial-state.json'))
  return { bootstrap, home: join(bootstrap, 'home'), profile: join(bootstrap, 'profile'),
    handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: any[]) => any>(),
    connections: undefined as ConnectionPort | undefined }
})
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => fixture.home }))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  app: { getPath: (name: string) => name === 'home' ? fixture.home : fixture.profile, getAppPath: () => fixture.profile },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: any[]) => any) => fixture.handlers.set(channel, handler),
    removeHandler: (channel: string) => fixture.handlers.delete(channel), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}, session: {}
}))
// Reuse the original IPC bootstrap substrate without opening the user's control endpoint.
// The captured port is the real createConnectionServices/SQLite owner created by registerIpc.
vi.mock('@agentmux/core', async actual => ({ ...await actual<typeof import('@agentmux/core')>(), AgentMuxControlServer: class {
  constructor(options: { connections: ConnectionPort }) { fixture.connections = options.connections }
  async start() {} async stop() {}
} }))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({ list: async () => [], snapshot: async () => ({ demands: [] }), subscribe: () => () => {} }) }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))

import { AgentMuxMemoryAgentSessionStore, LocalExecutionHost } from '@agentmux/core'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services.js'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { registerIpc } from '../src/main/ipc.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { WorkspaceFiles } from '../src/main/workspace-files.js'

const roots: string[] = [], exec = promisify(execFile)
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true }))) })
afterAll(async () => { await rm(fixture.bootstrap, { recursive: true }) })

function directory(root: string, profile: 'default' | 'a' | 'b') {
  return profile === 'default' ? join(root, 'home', '.agentmux', 'connectors') : join(root, profile, 'connectors')
}
const secret = 'owned-profile-credential'
const operation = (profile: string) => 'profile-policy-' + profile
async function seed(root: string, profile: 'default' | 'a' | 'b') {
  const services = await createConnectionServices({ directory: directory(root, profile) })
  try {
    const saved = await services.secrets.store({ operationId: 'credential-' + profile, secret })
    await services.connections.configure({ operationId: 'connection-operation-' + profile, expectedRevision: null,
      connection: { connectionId: 'connection-' + profile, adapterId: 'owned-metadata', application: { domain: 'profile.example', appId: 'app-' + profile }, label: profile, enabled: false, credentialRef: saved.credentialRef } })
    await services.connections.service!.configure({ operationId: operation(profile), expectedRevision: 0, service: { enabled: false } })
    return saved.credentialRef
  } finally { services.close() }
}
async function registered(root: string, profile: 'default' | 'a' | 'b') {
  fixture.home = join(root, 'home')
  fixture.profile = join(root, profile === 'default' ? 'ordinary-user-data' : profile)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(fixture.profile, 'state'))
  vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE', join(fixture.profile, 'state', 'spatial-state.json'))
  if (profile === 'default') vi.stubEnv('AGENTMUX_DESKTOP_USER_DATA', undefined)
  else vi.stubEnv('AGENTMUX_DESKTOP_USER_DATA', fixture.profile)
  const resolveSecret = vi.spyOn(ConnectionSecrets.prototype, 'resolve')
  fixture.handlers.clear(); fixture.connections = undefined
  let config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [{ id: 'resource', name: 'Owned', hostId: 'local', path: fixture.profile, kind: 'folder' as const }] }
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: [] })
  vi.spyOn(runtime, 'attach').mockReturnValue(() => {})
  const sender = Object.assign(new EventEmitter(), { id: 783, isDestroyed: () => false, send: vi.fn(), mainFrame: { framesInSubtree: [] } })
  const host = new LocalExecutionHost(), files = new WorkspaceFiles(() => host)
  const dispose = await registerIpc({ initialConfig: config, window: { setBackgroundColor: vi.fn(), isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow, runtime,
    workbenchWindows: { setNativeOwner: () => () => {} } as Parameters<typeof registerIpc>[0]['workbenchWindows'],
    configStore: { get: async () => config, validate: (value: typeof config) => value, save: async (value: typeof config) => { config = value; return value } } as never, progressLoops: { subscribe: () => () => {} } as never,
    scratchTopics: { setNameAudit: vi.fn() } as never, workspaceFiles: files })
  expect(fixture.connections).toBeDefined()
  // Finish the unrelated real bootstrap writer before changing the fixture's profile or removing it.
  await fixture.handlers.get('notesStorage:inspect')!({ sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent)
  return { connections: fixture.connections!, resolveSecret, dispose,
    invoke: async (channel: string, ...args: any[]) => {
      const handler = fixture.handlers.get(channel); expect(handler).toBeTypeOf('function')
      return await handler!({ sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent, ...args)
    } }
}
async function original(f: Awaited<ReturnType<typeof registered>>, profile: string) {
  expect(f.resolveSecret).not.toHaveBeenCalled()
  expect((await f.connections.list()).connections.map(row => row.config.connectionId)).toEqual(['connection-' + profile])
  expect(await f.connections.service!.get()).toEqual({ enabled: false, revision: 1 })
  expect((await f.connections.service!.inspect({ operationId: operation(profile) })).operation).toMatchObject({ operationId: operation(profile), service: { enabled: false, revision: 1 } })
}

it('keeps the actual registered default and explicit profile owners separate without resolving credentials for metadata', async () => {
  const root = await mkdtemp(join(fixture.bootstrap, 'owned-')); roots.push(root)
  for (const profile of ['default', 'a', 'b'] as const) await seed(root, profile)
  for (const profile of ['a', 'b', 'default', 'a'] as const) {
    const f = await registered(root, profile)
    try {
      await original(f, profile)
      for (const foreign of ['default', 'a', 'b'].filter(name => name !== profile)) {
        expect((await f.connections.inspect({ operationId: 'connection-operation-' + foreign })).operation).toBeNull()
        expect((await f.connections.service!.inspect({ operationId: operation(foreign) })).operation).toBeNull()
      }
    } finally { await f.dispose() }
  }
})

it('reopens original profile records in a second owned process without reseeding the private credential owner', async ({ task }) => {
  const inherited = process.env.AGENTMUX_TEST_PROFILE_STORAGE_REOPEN
  if (inherited) {
    const expected = JSON.parse(await readFile(inherited, 'utf8')) as { root: string; parentPid: number; credentialRef: string }
    const f = await registered(expected.root, 'a')
    try {
      await original(f, 'a')
      const stored = await f.invoke('connections:storeCredential', { operationId: 'credential-a', secret })
      expect(stored).toEqual({ credentialRef: expected.credentialRef })
      expect((await f.connections.inspect({ operationId: 'connection-after-reopen' })).operation).toMatchObject({ operationId: 'connection-after-reopen', connection: { revision: 2, config: { label: 'Saved before child' } } })
      expect(process.pid).not.toBe(expected.parentPid)
      await writeFile(join(expected.root, 'child-receipt.json'), JSON.stringify({ pid: process.pid, credentialRef: stored.credentialRef }))
    } finally { await f.dispose() }
    return
  }
  const root = await mkdtemp(join(fixture.bootstrap, 'owned-')); roots.push(root)
  await seed(root, 'default'); const credentialRef = await seed(root, 'a'); await seed(root, 'b')
  const f = await registered(root, 'a')
  try {
    await original(f, 'a')
    const current = (await f.connections.list()).connections[0]!
    await f.connections.configure({ operationId: 'connection-after-reopen', expectedRevision: current.revision, connection: { ...current.config, label: 'Saved before child' } })
  } finally { await f.dispose() }
  const request = join(root, 'reopen-request.json')
  await writeFile(request, JSON.stringify({ root, parentPid: process.pid, credentialRef }))
  const repository = resolve(import.meta.dirname, '../../..'), config = process.env.AGENTMUX_TEST_PROFILE_STORAGE_CONFIG ?? join(repository, 'vitest.config.ts')
  await exec(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, 'apps/desktop/test/connector-profile-bootstrap-isolation.test.ts', '-t', 'reopens original profile records in a second owned process'],
    { cwd: repository, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', AGENTMUX_TEST_PROFILE_STORAGE_REOPEN: request }, maxBuffer: 2 * 1024 * 1024 })
  const receipt = JSON.parse(await readFile(join(root, 'child-receipt.json'), 'utf8'))
  expect(receipt).toEqual({ pid: expect.any(Number), credentialRef }); expect(receipt.pid).not.toBe(process.pid)
  Object.assign(task.meta, { profileReopen: { parentPid: process.pid, childPid: receipt.pid, originalConnectionRevision: 2 } })
  for (const profile of ['default', 'b'] as const) {
    const untouched = await registered(root, profile)
    try { await original(untouched, profile) } finally { await untouched.dispose() }
  }
}, 30_000)
