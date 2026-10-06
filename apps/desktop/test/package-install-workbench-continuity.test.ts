import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { parseDesktopClientObservation, type DesktopClientObservation } from '../src/shared/client-observation'

// Only external OS/RPC inputs are controlled. Real installer qualification,
// polling, directory cutover, transaction receipt and process-ownership checks run.
const io = vi.hoisted(() => ({
  app: '', candidate: '', pid: 201, cutovers: 0, reads: 0,
  before: null as DesktopClientObservation | null,
  after: null as DesktopClientObservation | null,
  failAfterRead: false, failEveryRead: false,
  tick: 0
}))
const roots: string[] = []
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: (command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    queueMicrotask(async () => {
      try {
        if (command === 'cp' || command === 'ditto') {
          expect(args.at(-2)).toBe(io.candidate)
          expect(args.at(-1)).toBe(join(dirname(io.app), `.AgentMux.install-${process.pid}.app`))
          await cp(args.at(-2)!, args.at(-1)!, { recursive: true })
        } else expect(command, 'No live OS operation is admitted').toBe('codesign')
        child.stdout.end(); child.stderr.end(); child.emit('exit', 0, null)
      } catch (error) { child.emit('error', error) }
    })
    return child
  } }
})
vi.mock('../scripts/package-process-scope.mjs', async original => ({
  ...await original<typeof import('../scripts/package-process-scope.mjs')>(),
  observeApplicationProcesses: async () => ({ serving: io.pid ? [io.pid] : [], crashReporter: [],
    processes: io.pid ? [{ pid: io.pid, ppid: 1, birth: `private-birth-${io.pid}`, command: `${io.app}/Contents/MacOS/AgentMux` }] : [] })
}))
vi.mock('../scripts/package-semantic-host.mjs', async original => ({
  ...await original<typeof import('../scripts/package-semantic-host.mjs')>(),
  prepareSemanticHostReload: async () => null, stopSemanticHostForInstall: async () => {}, confirmSemanticHostReload: async () => {}
}))
vi.mock('../scripts/package-runtime-upgrade.mjs', async original => ({
  ...await original<typeof import('../scripts/package-runtime-upgrade.mjs')>(),
  prepareUiRuntime: async () => null, closeRuntimeUpgrade: async () => {},
  observeUiClient: async (app: string) => {
    expect(app).toBe(io.app)
    if (io.pid === 201) return parseDesktopClientObservation(structuredClone(io.before))
    io.reads++
    if (io.failEveryRead || io.failAfterRead && io.reads > 1) throw new Error('PRIVATE_RPC_UNAVAILABLE')
    return parseDesktopClientObservation(structuredClone(io.after))
  }
}))

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-install-continuity-')); roots.push(root)
  const home = join(root, 'home'), app = join(home, 'Applications/AgentMux.app'), candidate = join(root, 'candidate.app')
  Object.assign(io, { app, candidate, pid: 201, reads: 0, cutovers: 0, failEveryRead: false, failAfterRead: false, tick: 0 })
  const identity = { schema: 'agentmux.package-identity.v1' as const, sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40),
    appVersion: '0.1.0', platform: process.platform, arch: process.arch }
  for (const [directory, sourceCommit] of [[app, 'a'.repeat(40)], [candidate, 'c'.repeat(40)]]) {
    for (const [relative, bytes] of Object.entries({
      'Contents/MacOS/AgentMux': 'Private file, never executed',
      'Contents/Resources/app/package-identity.json': JSON.stringify({ ...identity, sourceCommit }),
      'Contents/Resources/app/out/renderer/release.json': JSON.stringify({ identity: { shell: 'same-shell', ctxmux: 'same-native' } }),
      [`Contents/Resources/app/node_modules/@agentmux/core/vendor/ctxmux/${process.platform}-${process.arch}/manifest.json`]: 'Same private Native artifact'
    })) {
      const target = join(directory!, relative); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
    }
  }
  const session = (kind: 'agent' | 'terminal', regionId: string) => ({ kind, regionId, workspaceId: 'workspace',
    sessionId: `${regionId}-session`, phase: 'attached' as const, processState: 'running' as const,
    control: kind === 'agent'
      ? { kind, hostId: 'local', agentSessionId: `${regionId}-session`, run: { runId: `${regionId}-run` } }
      : { kind, hostId: 'local', runId: `${regionId}-run`, run: { runId: `${regionId}-run` } } })
  const observation = {
    schema: 'agentmux.desktop-client-observation.v1',
    main: { pid: 201, package: identity, renderer: { kind: 'bundled', id: 'd'.repeat(64), identity: { shell: 'same-shell', ctxmux: 'same-native' } },
      storage: { userData: root, sessionData: root, directory: root, localStorage: 'present', detail: null }, runtimes: [] },
    workbench: { loading: false, startupProgress: { step: 'layout' }, activeWorkspaceId: 'workspace', mainSurface: 'workbench',
      focus: { executionSessionId: 'agent-session', pmoSessionId: null },
      desktop: { selection: { surface: 'space', mainSurface: 'workbench', space: null, goalId: null },
        presentation: { provenance: 'observed', state: 'main-visible', tabId: 'tab-a', regionId: 'agent', blockers: [] },
        input: { provenance: 'observed', scope: 'main', ownerKind: 'terminal', tabId: 'tab-a', regionId: 'agent', sessionId: 'agent-session', connected: true, visible: true, inert: false },
        floating: { provenance: 'observed', state: 'closed', topicId: null, tabId: null, regionId: null, sessionId: null, presentation: 'hidden' },
        overlays: { provenance: 'observed', settings: false, quickSwitcher: false }, focus: { executionSessionId: 'agent-session', pmoSessionId: null } },
      tabs: [
        { id: 'tab-a', workspaceId: 'workspace', topicId: 'topic', name: 'Original', titleRegionId: 'agent',
          layout: { root: { type: 'split', direction: 'horizontal', ratio: 0.4, first: { type: 'leaf', regionId: 'agent' }, second: { type: 'leaf', regionId: 'terminal' } }, activeRegionId: 'agent' },
          regions: [session('agent', 'agent'), session('terminal', 'terminal')] },
        { id: 'tab-b', workspaceId: 'workspace', titleRegionId: 'browser',
          layout: { root: { type: 'leaf', regionId: 'browser' }, activeRegionId: 'browser' },
          regions: [{ kind: 'browser', regionId: 'browser', workspaceId: 'workspace', browserId: 'browser-id', url: 'https://example.invalid/original', title: 'Original page', profileId: 'profile', navigationId: 'old-navigation', error: null, loading: false }] }
      ],
      layouts: {
        workspace: { root: { type: 'leaf', groupId: 'group-a' }, activeGroupId: 'group-a', groups: [{ id: 'group-a', activeTabId: 'tab-a', tabOrder: ['tab-a', 'tab-b'], recentTabIds: ['tab-a', 'tab-b'] }] },
        other: { root: { type: 'leaf', groupId: 'group-b' }, activeGroupId: 'group-b', groups: [{ id: 'group-b', activeTabId: null, tabOrder: [], recentTabIds: [] }] }
      }
    }
  }
  io.before = parseDesktopClientObservation(observation)
  io.after = structuredClone(io.before); io.after.main.pid = 202; io.after.main.package!.sourceCommit = 'c'.repeat(40)
  // Advance only this test's retry clock; timers and the 30-second product bound remain original.
  vi.spyOn(Date, 'now').mockImplementation(() => io.tick += 10_000)
  vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('Live signals are forbidden') })
  return { home, app, candidate }
}
async function install(f: Awaited<ReturnType<typeof fixture>>) {
  const { installApplication } = await import('../scripts/package-macos.mjs')
  return installApplication(f.candidate, { intent: 'ui-only', homeDirectory: f.home,
    quit: async () => { expect(io.pid).toBe(201); io.pid = 0; return { wasRunning: true, pids: [201] } },
    launch: async () => { io.pid = 202; io.cutovers++; expect(JSON.parse(await readFile(join(f.app, 'Contents/Resources/app/package-identity.json'), 'utf8')).sourceCommit).toBe('c'.repeat(40)); return [202] }
  })
}
const after = () => io.after!.workbench
const agent = () => after().tabs[0]!.regions[0]! as Extract<DesktopClientObservation['workbench']['tabs'][number]['regions'][number], { kind: 'agent' }>
const browser = () => after().tabs[1]!.regions[0]! as Extract<DesktopClientObservation['workbench']['tabs'][number]['regions'][number], { kind: 'browser' }>

it('actual installation admits registry insertion changes and object keys without reordering presentation', async () => {
  const f = await fixture(), original = structuredClone(io.before)
  after().layouts = Object.fromEntries(Object.entries(after().layouts).reverse())
  after().tabs.reverse(); after().tabs[1]!.regions.reverse()
  const layout = after().layouts.workspace!
  after().layouts.workspace = { groups: layout.groups, activeGroupId: layout.activeGroupId, root: layout.root }
  const outcome = await install(f).then(result => ({ result, error: null }), error => ({ result: null, error: String(error) }))
  expect(outcome.error).toBeNull()
  expect(outcome.result?.ui.status).toBe('committed')
  expect(io.cutovers).toBe(1)
  expect(io.before).toEqual(original)
})

const changes: [string, () => void][] = [
  ['tab order', () => after().layouts.workspace!.groups[0]!.tabOrder.reverse()],
  ['recent order', () => after().layouts.workspace!.groups[0]!.recentTabIds.reverse()],
  ['active tab', () => { after().layouts.workspace!.groups[0]!.activeTabId = 'tab-b' }],
  ['focus', () => { after().focus.executionSessionId = 'terminal-session' }],
  ['active workspace', () => { after().activeWorkspaceId = 'other' }],
  ['main surface', () => { after().mainSurface = 'agents' }],
  ['tab metadata', () => { after().tabs[0]!.name = 'Changed' }],
  ['topic', () => { after().tabs[0]!.topicId = 'other-topic' }],
  ['region workspace', () => { agent().workspaceId = '__notes__' }],
  ['region session', () => { agent().sessionId = 'new-session' }],
  ['split ratio', () => { const root = after().tabs[0]!.layout.root; if (root.type === 'split') root.ratio = 0.6 }],
  ['split direction', () => { const root = after().tabs[0]!.layout.root; if (root.type === 'split') root.direction = 'vertical' }],
  ['split positions', () => { const root = after().tabs[0]!.layout.root; if (root.type === 'split') [root.first, root.second] = [root.second, root.first] }],
  ['active region', () => { after().tabs[0]!.layout.activeRegionId = 'terminal' }],
  ['missing tab', () => { after().tabs.pop() }],
  ['missing region', () => { after().tabs[0]!.regions.pop() }],
  ['duplicate tab', () => { after().tabs.push(structuredClone(after().tabs[0]!)) }],
  ['duplicate region', () => { after().tabs[0]!.regions.push(structuredClone(agent())) }],
  ['browser descriptor', () => { browser().url = 'https://example.invalid/other' }]
]
it.each(changes)('actual installation rejects changed %s and retains exact observations', async (_name, change) => {
  const f = await fixture(); change()
  const before = structuredClone(io.before), expected = structuredClone(io.after)
  const error = await install(f).catch(error => error)
  expect(error.message).toBe('The original workbench, Region descriptors or focus have not been restored.')
  expect(error.transaction.ui.status).toBe('unknown'); expect(error.transaction.ui.continuity).toEqual({ before, after: expected })
  expect(error.transaction.native.status).toBe('deferred'); expect(io.pid).toBe(202); expect(io.cutovers).toBe(1)
})
it.each([
  ['missing control', () => { agent().control = null }],
  ['different Run', () => { agent().control!.run.runId = 'different-run' }],
  ['different Host', () => { agent().control!.hostId = 'different-host' }]
] as const)('actual installation keeps healthy Run qualification for %s', async (_name, change) => {
  const f = await fixture(); change()
  const error = await install(f).catch(error => error)
  expect(error.message).toBe('An original healthy Run is not yet available in its restored Region.')
  expect(error.transaction.ui.status).toBe('unknown'); expect(error.transaction.ui.continuity.after).toEqual(io.after)
})
it.each([
  ['missing navigation', () => { browser().navigationId = '' }],
  ['page error', () => { browser().error = 'PRIVATE_NAVIGATION_FAILED' }]
] as const)('actual installation keeps Browser qualification for %s', async (_name, change) => {
  const f = await fixture(); change()
  const error = await install(f).catch(error => error)
  expect(error.message).toBe('An original Browser page has not reopened; its Region is preserved but UI activation is unconfirmed.')
  expect(error.transaction.ui.status).toBe('unknown')
})
it('rejection retains the last successful observation when a later RPC read is unavailable', async () => {
  const f = await fixture(); after().focus.executionSessionId = 'changed-focus'; io.failAfterRead = true
  const expected = structuredClone(io.after), error = await install(f).catch(error => error)
  expect(error.message).toBe('PRIVATE_RPC_UNAVAILABLE'); expect(io.reads).toBeGreaterThan(1)
  expect(error.transaction.ui.continuity).toEqual({ before: io.before, after: expected })
  const { reportInstallTransaction } = await import('../scripts/package-macos.mjs')
  let receipt = ''
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { receipt += String(chunk); return true })
  reportInstallTransaction(error.transaction)
  output.mockRestore()
  expect(JSON.parse(receipt.split('\n').find(line => line.startsWith('install_transaction='))!.slice('install_transaction='.length))).toEqual(error.transaction)
  // The persisted receipt is a snapshot, not a mutable fixture/owner reference.
  after().focus.executionSessionId = 'later-focus'
  expect(error.transaction.ui.continuity.after).toEqual(expected)
})
it('unavailable activation never invents an after observation', async () => {
  const f = await fixture(); io.failEveryRead = true
  const error = await install(f).catch(error => error)
  expect(error.message).toBe('PRIVATE_RPC_UNAVAILABLE')
  expect(error.transaction.ui.continuity).toEqual({ before: io.before, after: null })
})
it('outgoing qualification failure preserves the observed snapshot without requesting quit', async () => {
  const f = await fixture(); io.before!.workbench.loading = true
  const error = await install(f).catch(error => error)
  expect(error.transaction.ui.status).toBe('not-started')
  expect(error.transaction.ui.continuity).toEqual({ before: null, after: io.before })
  expect(io.pid).toBe(201); expect(io.cutovers).toBe(0)
})
