// @vitest-environment happy-dom
import { act } from 'react'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, SshHostConfig } from '../src/shared/contracts'

const bridge = vi.hoisted(() => ({ root: '', api: null as AgentMuxPreloadApi | null, handlers: new Map<string, (...values: unknown[]) => unknown>(),
  invoke: vi.fn(), checks: [] as unknown[] }))
vi.mock('electron', () => ({
  app: { getPath: () => bridge.root, getAppPath: () => process.cwd() + '/apps/desktop', isPackaged: false, once: vi.fn(), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: (name: string, value: AgentMuxPreloadApi) => { bridge.api = value; Object.defineProperty(window, name, { value, configurable: true }) } },
  ipcMain: { handle: (channel: string, handler: (...values: unknown[]) => unknown) => bridge.handlers.set(channel, handler),
    removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), send: vi.fn() }, webFrame: { getZoomFactor: () => 1 },
  nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}, session: {}, safeStorage: {},
  globalShortcut: { register: () => true, unregister: vi.fn(), isRegistered: () => false }
}))
// Unrelated Main startup services are leaves. The registered maintenance IPC,
// ConfigOwner, Main maintenance owners and both Core managers remain production.
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('../src/main/browser-profile-manager', async () => ({ BrowserProfileManager: (await import('./helpers/settings-ipc-fixture')).SettingsBrowserProfiles }))
vi.mock('../src/main/browser-view-manager', async () => ({ BrowserViewManager: (await import('./helpers/settings-ipc-fixture')).SettingsBrowserViews }))
vi.mock('../src/main/notes-storage-owner', async () => ({ NotesStorageOwner: (await import('./helpers/settings-ipc-fixture')).SettingsNotesStorage }))
vi.mock('../src/main/native-overlay-windows', () => ({ NativeOverlayWindows: class { dispose() {} resourceProcessIds() { return [] } } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
vi.mock('@agentmux/connectors', async original => ({ ...await original<typeof import('@agentmux/connectors')>(),
  createConnectionServices: async () => ({ connections: { list: async () => [] }, secrets: {}, onChannelMetadataChanged: () => () => {}, close: async () => {} }) }))

import '../src/preload/index'
import ctxmuxContract from '../../../packages/core/src/ctxmux-artifact-contract.json'
const PROTOCOL_VERSION = ctxmuxContract.protocol
import { AgentMuxMemoryAgentSessionStore, AgentMuxApplicationAccessOwner, RemoteCoreUpgradeManager, SshExecutionHost } from '@agentmux/core'
import { INSPECT_CORE_OWNER, READ_CORE_MAINTENANCE, OWNER_GONE, STAGE_CORE, START_CORE, SELECT_CORE_RELEASE } from '../../../packages/core/src/remote-core-upgrade-programs'
import { CTXMUX_VERSION } from '../../../packages/core/src/ctxmux-run-adapter'
import { PROBE_CORE_INSTALL } from '../../../packages/core/src/remote-core-install-programs'
import { HostCorePanel } from '../src/renderer/src/components/settings/HostCorePanel'
import { api } from '../src/renderer/src/lib/api'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { RuntimeController } from '../src/main/runtime-controller'
import { testWorkbenchUserState } from './helpers/workbench-user-state-fixture'
import { testAppDocumentSources } from './helpers/app-document-fixture'
import { settingsScratchTopics, settingsWorkbenchWindows, settingsWorkspaceFiles, prepareSettingsIpcDirectory } from './helpers/settings-ipc-fixture'
import { localRuntimeConnector } from './helpers/local-runtime-connector'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})
/** Only the external SSH programs and candidate bytes are controlled. This is
 * actual maintenance admission/receipts, not physical Core/Native replacement. */
async function fixture(unbound = false) {
  const root = await mkdtemp(join(tmpdir(), 'amx-maintenance-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
  bridge.root = root; bridge.handlers.clear(); bridge.invoke.mockReset(); bridge.checks = []
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  await prepareSettingsIpcDirectory(root)
  const digest = 'a'.repeat(64), nativeDigest = 'b'.repeat(64), archivePath = join(root, 'candidate.tar.gz')
  await writeFile(archivePath, 'Controlled offline candidate')
  const artifact = { digest, sourceCommit: 'candidate-source', version: '0.1.0', ownerProtocolVersion: 2, requiredNativeProtocolVersion: PROTOCOL_VERSION,
    nativeBuild: 'native-source', nativeDigest, archivePath, archiveDigest: createHash('sha256').update(await readFile(archivePath)).digest('hex'), files: [] }
  vi.spyOn(RemoteCoreUpgradeManager.prototype, 'artifact').mockResolvedValue(artifact)
  const host: SshHostConfig = { id: 'saved-original', kind: 'ssh', label: 'Original Host', hostname: 'controlled.invalid',
    ...(!unbound ? { runtimeId: 'original-runtime', remoteCommand: '/controlled/original/launcher/amux', remoteSocketPath: '/controlled/runtime/control.sock' } : {}) }
  const native = { instanceId: 'original-native', processId: 202, buildIdentity: 'ctxmuxd/' + CTXMUX_VERSION, protocolVersion: PROTOCOL_VERSION }
  let owner = { runtimeId: 'original-runtime', ownerInstanceId: 'original-core', protocolVersion: 2, processId: 101, ctxmux: native }
  let launch = { node: '/controlled/bin/node', cli: '/controlled/original/core/dist/headless-runtime-cli.js', cwd: '/controlled/work', processId: 101, startTicks: '1234',
    env: { HOME: '/controlled/home', PATH: '/controlled/bin:/usr/bin', AGENTMUX_STATE_DIRECTORY: '/controlled/state', AGENTMUX_RUNTIME_DIRECTORY: '/controlled/runtime', AGENTMUX_AGENT_SESSION_STORE: '/controlled/state/sessions.json' },
    stateDirectory: '/controlled/state', runtimeDirectory: '/controlled/runtime', storePath: '/controlled/state/sessions.json',
    nativeSha256: nativeDigest, nativeProcessId: native.processId, nativeStartTicks: '4321', nativeArtifactDirectory: '/controlled/original/vendor/ctxmux/linux-x64',
    nativeManifestSha256: 'e'.repeat(64), nativeInstanceId: native.instanceId, nativeRuntimeId: 'original-native-runtime', nativeBuildId: native.buildIdentity,
    platform: 'linux-x64', deploymentDigest: 'd'.repeat(64), version: '0.1.0', sourceCommit: 'original-source' }
  const originalSession = { agentSessionId: 'kept-session', run: { runId: 'kept-run' } }
  const originalRun = { runId: 'kept-run', pid: 404, state: 'running', outputBytes: 100, durableOutputBytes: 100, inputBytes: 3 }
  const effects: string[] = [], programs: string[] = []
  const ssh = vi.spyOn(SshExecutionHost.prototype, 'run').mockImplementation(async (_command, args = [], options = {}) => {
    const p = JSON.parse(String(options.input)), program = args[1]; programs.push(program ?? '')
    let output: unknown
    if (program === PROBE_CORE_INSTALL) return { stdout: '', stderr: 'Original probe traceback: unsupported subprocess keyword', exitCode: 1 }
    if (program === INSPECT_CORE_OWNER) {
      expect(p.runtimeId).toBe(host.runtimeId); expect(p.socket).toBe(host.remoteSocketPath)
      const { nativeInstanceId: _instance, nativeRuntimeId: _runtime, nativeBuildId: _build, ...physical } = launch
      output = { ...physical, ...(p.receipt ? { ownerReceipt: { status: 'matching', path: p.receipt.path } } : {}) }
    } else if (program === READ_CORE_MAINTENANCE) {
      if (p.shutdown) { effects.push('stop-original-core'); output = { owner, accepted: true } }
      else output = { owner, bootstrap: { storePath: launch.storePath, hostProcessId: owner.processId, sessions: [originalSession] },
        nativeRuns: [originalRun], nativeRuntime: { daemonInstanceId: native.instanceId, runtimeId: launch.nativeRuntimeId,
          protocolGeneration: PROTOCOL_VERSION, runtimeIdPersistence: 'state_dir', buildId: native.buildIdentity, platform: 'linux', arch: 'x86_64',
          capabilities: { 'native.start': 1, 'native.recoverable_input': 1, 'native.recoverable_stop': 1, 'services.persistent_state': 1, 'services.planned_exec_upgrade_continuity': 1 } } }
    } else if (program === STAGE_CORE) { effects.push('stage-candidate'); output = { releaseDirectory: '/controlled/state/core-releases/' + digest, remoteCommand: '/controlled/state/core-releases/' + digest + '/launcher/amux', digest } }
    else if (program === OWNER_GONE) output = { gone: true }
    else if (program === START_CORE) {
      effects.push('start-new-core'); owner = { ...owner, ownerInstanceId: 'updated-core', processId: 303 }
      launch = { ...launch, processId: owner.processId, startTicks: '5555', deploymentDigest: digest, cli: '/controlled/state/core-releases/' + digest + '/dist/headless-runtime-cli.js' }
      output = { processId: owner.processId }
    } else if (program === SELECT_CORE_RELEASE) { effects.push('select-current'); output = { current: digest } }
    else throw Error('Unexpected SSH program in bounded maintenance consumer')
    return { stdout: JSON.stringify(output), stderr: '', exitCode: 0 }
  })
  const calls = vi.spyOn(RemoteCoreUpgradeManager.prototype, 'upgrade')
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
  cleanups.push(() => runtime.dispose())
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const sender = Object.assign(new EventEmitter(), { id: 714, isDestroyed: () => false, send: vi.fn() })
  const window = { id: 7, setBackgroundColor: vi.fn(), isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow
  const config = { ...structuredClone(DEFAULT_CONFIG), hosts: [...DEFAULT_CONFIG.hosts, host] }
  const applicationAccess = new AgentMuxApplicationAccessOwner({ path: join(root, 'applications.sqlite'), resolveHost: async () => { throw Error('This maintenance consumer does not access application profiles.') } })
  cleanups.push(() => applicationAccess.dispose())
  const stop = await registerIpc({ window, appDocumentSources: testAppDocumentSources(sender), workbenchWindows: settingsWorkbenchWindows(window),
    configStore: { get: async () => config, validate: (value: unknown) => value, save: async (value: unknown) => value } as never,
    initialConfig: config, runtime, applicationAccess, workbenchUserState: testWorkbenchUserState(),
    scratchTopics: settingsScratchTopics(), workspaceFiles: settingsWorkspaceFiles() })
  cleanups.push(stop)
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
    const handler = bridge.handlers.get(channel); expect(handler).toBeTypeOf('function')
    const result = await handler!({ sender, senderFrame: Reflect.get(sender, 'mainFrame') } as unknown as IpcMainInvokeEvent, ...values)
    if (channel === 'hosts:upgradeCheck') bridge.checks.push(result)
    return structuredClone(result)
  })
  return { host, effects, ssh, calls, programs, originalSession, originalRun, root }
}
it('one explicit Core-only action crosses real Renderer/Preload/trusted IPC/Main into the original Core maintenance owner', async () => {
  const f = await fixture()
  await dom.render(<HostCorePanel host={f.host} committed={f.host} active />)
  await vi.waitFor(() => expect(bridge.checks).toHaveLength(1))
  expect(f.effects).toEqual([]); expect(f.calls).not.toHaveBeenCalled()
  expect(dom.container.querySelectorAll('[data-host-upgrade]')).toHaveLength(1)
  expect(dom.container.querySelector('[data-host-install]')).toBeNull()
  expect(dom.container.querySelector('[data-upgrade-action]')?.textContent, JSON.stringify(bridge.checks[0])).toBe('Update Core')
  await dom.click('[data-upgrade-action]')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Deployment completed'))
  expect(f.calls).toHaveBeenCalledExactlyOnceWith(f.host, Reflect.get(bridge.checks[0] as object, 'expected'), expect.any(String))
  const operation = f.calls.mock.calls[0]![2]
  expect(operation).toBeTruthy()
  expect(f.effects).toEqual(['stage-candidate', 'stop-original-core', 'start-new-core', 'select-current'])
  expect(bridge.invoke.mock.calls.filter(([channel]) => channel === 'hosts:upgrade')).toHaveLength(1)
  expect(dom.container.querySelector('[aria-label="Review upgrade"]')).toBeNull()
  expect(await api.hosts.upgradeInspect(f.host, operation)).toMatchObject({ status: 'completed', operationId: operation, expected: Reflect.get(bridge.checks[0] as object, 'expected') })
  expect(f.effects).toHaveLength(4)
  expect(f.originalSession).toEqual({ agentSessionId: 'kept-session', run: { runId: 'kept-run' } })
  expect(f.originalRun).toMatchObject({ runId: 'kept-run', pid: 404, inputBytes: 3 })
  expect(dom.draft()).toBe('Keep my draft')
})
it('actual unbound Host probe failure stays unknown with no installation or deployment', async () => {
  const f = await fixture(true)
  await dom.render(<HostCorePanel host={f.host} committed={f.host} active />)
  await vi.waitFor(() => expect(bridge.checks).toHaveLength(1))
  await dom.click('[data-upgrade-action]')
  await vi.waitFor(() => expect(f.programs).toContain(PROBE_CORE_INSTALL))
  expect(dom.container.querySelector('[data-host-install]')).toBeNull()
  expect(dom.container.querySelectorAll('[data-host-upgrade]')).toHaveLength(1)
  expect(dom.container.textContent).not.toContain('Set up this machine')
  const raw = Array.from(dom.container.querySelectorAll('.host-upgrade__diagnostic-message')).find(node => node.textContent?.includes('unsupported subprocess keyword'))!
  expect(raw.closest('details')?.open).toBe(false)
  expect(f.effects).toEqual([]); expect(f.calls).not.toHaveBeenCalled()
  expect(bridge.invoke.mock.calls.filter(([channel]) => channel === 'hosts:install')).toHaveLength(0)
})
