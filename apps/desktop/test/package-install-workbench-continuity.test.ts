import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { appendFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { parseDesktopClientObservation, parseDesktopClientObservationForInstall, type DesktopClientObservation } from '../src/shared/client-observation'

// Only external OS/RPC inputs are controlled. Real installer qualification,
// polling, directory cutover, transaction receipt and process-ownership checks run.
const io = vi.hoisted(() => ({
  app: '', candidate: '', pid: 201, cutovers: 0, reads: 0,
  before: null as DesktopClientObservation | null,
  after: null as DesktopClientObservation | null,
  failAfterRead: false, failEveryRead: false, outgoingMisses: 0, outgoingReads: 0, missesAfterLaunch: 0,
  tick: 0, nativePlan: null as any, nativeConfirmation: null as any,
  copies: 0, quits: 0, signaturePaths: [] as string[], hashInputs: [] as string[], signatureFailure: false, foreignStage: '', copyTarget: '', resultFacts: null as Record<string, unknown> | null,
  copyFailure: false, cleanupFailure: false, cutoverFailure: false, sourceChange: '' as '' | 'missing' | 'seal', replaceStage: false,
  cleanupProbeUnavailable: '' as '' | 'source' | 'stage'
}))
const roots: string[] = []
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (io.cleanupFailure && String(args[0]).includes('/.AgentMux.install-')) throw new Error('PRIVATE_CLEANUP_FAILED')
    return actual.rm(...args)
  }, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (io.cutoverFailure && args[0] === io.app) throw new Error('PRIVATE_CUTOVER_FAILED')
    return actual.rename(...args)
  }, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    if (io.cleanupProbeUnavailable === 'source' && args[0] === io.candidate || io.cleanupProbeUnavailable === 'stage' && String(args[0]).includes('/.AgentMux.install-'))
      throw new Error('PRIVATE_CLEANUP_OBSERVATION_UNAVAILABLE')
    const observation = await actual.lstat(...args)
    // Only the selected private stage's external UID observation is controlled.
    return args[0] === io.foreignStage ? Object.assign(Object.create(observation), { uid: process.getuid!() + 1 }) : observation
  } }
})
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: (command: string, args: string[]) => {
    if (command === 'shasum') {
      io.hashInputs.push(args.at(-1)!)
      expect(args.slice(0, 2)).toEqual(['-a', '256'])
      expect(args.at(-1)?.startsWith(dirname(io.candidate) + '/')).toBe(true)
      return actual.spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    }
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    queueMicrotask(async () => {
      try {
        if (command === 'cp' || command === 'ditto') {
          io.copies++
          expect(args.at(-2)).toBe(command === 'cp' ? io.candidate + '/.' : io.candidate)
          if (io.copyTarget) expect(args.at(-1)).toBe(io.copyTarget)
          else expect(args.at(-1)).toMatch(new RegExp(`^${dirname(io.app)}/\\.AgentMux\\.install-${process.pid}-[a-f0-9-]{36}\\.app$`))
          await cp(args.at(-2)!, args.at(-1)!, { recursive: true })
          if (io.copyFailure) throw new Error('PRIVATE_COPY_FAILED')
        } else {
          expect(command, 'No live OS operation is admitted').toBe('codesign')
          io.signaturePaths.push(args.at(-1)!)
          if (io.sourceChange === 'missing') await rm(io.candidate, { recursive: true })
          if (io.sourceChange === 'seal') await writeFile(join(io.candidate, 'Contents/_CodeSignature/CodeResources'), 'changed signed source')
          if (io.replaceStage) {
            await rename(args.at(-1)!, args.at(-1)! + '.original')
            // The replacement is an external observation at the same pathname.
            await mkdir(args.at(-1)!)
            await writeFile(join(args.at(-1)!, 'foreign-content'), 'preserve this replacement')
          }
          if (io.signatureFailure) throw new Error('PRIVATE_SIGNATURE_INVALID')
        }
        child.stdout.end(); child.stderr.end(); child.emit('exit', 0, null)
      } catch (error) { child.emit('error', error) }
    })
    return child
  } }
})
vi.mock('../scripts/package-process-scope.mjs', async original => ({
  ...await original<typeof import('../scripts/package-process-scope.mjs')>(),
  observeApplicationProcesses: async () => ({ serving: io.pid ? [io.pid] : [], crashReporter: [],
    admissions: io.pid ? [{ uid: process.getuid!(), pid: io.pid, ppid: 1, birth: `private-birth-${io.pid}`,
      classification: 'gui', source: 'private-observed-main', initial: { classification: 'gui', source: 'private-observed-main' } }] : [],
    processes: io.pid ? [{ pid: io.pid, ppid: 1, birth: `private-birth-${io.pid}`, command: `${io.app}/Contents/MacOS/AgentMux` }] : [] })
}))
vi.mock('../scripts/package-semantic-host.mjs', () => ({
  prepareSemanticHostReload: async () => null, stopSemanticHostForInstall: async () => {}, confirmSemanticHostReload: async () => {}
}))
vi.mock('../scripts/package-runtime-upgrade.mjs', async original => ({
  ...await original<typeof import('../scripts/package-runtime-upgrade.mjs')>(),
  prepareUiRuntime: async () => io.nativePlan, confirmUiRuntime: async () => io.nativeConfirmation, closeRuntimeUpgrade: async () => {},
  observeUiClient: async (app: string) => {
    expect(app).toBe(io.app)
    if (io.pid === 201) {
      io.outgoingReads++
      if (io.outgoingMisses > 0) { io.outgoingMisses--; throw new Error('CONTROL_TIMEOUT') }
      return parseDesktopClientObservationForInstall(structuredClone(io.before))
    }
    io.reads++
    if (io.missesAfterLaunch > 0) { io.missesAfterLaunch--; throw new Error('CONTROL_TIMEOUT') }
    if (io.failEveryRead || io.failAfterRead && io.reads > 1) throw new Error('PRIVATE_RPC_UNAVAILABLE')
    return parseDesktopClientObservationForInstall(structuredClone(io.after))
  }
}))

afterEach(async () => {
  if (process.env.PACKAGE_STAGE_FACTS && expect.getState().currentTestName?.includes('[prepared-stage]')) {
    await appendFile(process.env.PACKAGE_STAGE_FACTS, JSON.stringify({ test: expect.getState().currentTestName, copies: io.copies, quits: io.quits, cutovers: io.cutovers, signaturePaths: io.signaturePaths, hashInputs: io.hashInputs, result: io.resultFacts, liveSignals: [], runtimeConnections: [] }) + '\n')
  }
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  io.cleanupFailure = false
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-install-continuity-')); roots.push(root)
  const home = join(root, 'home'), app = join(home, 'Applications/AgentMux.app'), candidate = join(root, 'candidate.app')
  Object.assign(io, { app, candidate, pid: 201, reads: 0, cutovers: 0, failEveryRead: false, failAfterRead: false, outgoingMisses: 0, outgoingReads: 0, missesAfterLaunch: 0, tick: 0, nativePlan: null, nativeConfirmation: null, copies: 0, quits: 0, signaturePaths: [], hashInputs: [], signatureFailure: false, foreignStage: '', copyTarget: '', resultFacts: null, copyFailure: false, cleanupFailure: false, cutoverFailure: false, sourceChange: '', replaceStage: false, cleanupProbeUnavailable: '' })
  const identity = { schema: 'agentmux.package-identity.v1' as const, sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40),
    appVersion: '0.1.0', platform: process.platform, arch: process.arch }
  for (const [directory, sourceCommit] of [[app, 'a'.repeat(40)], [candidate, 'c'.repeat(40)]]) {
    for (const [relative, bytes] of Object.entries({
      'Contents/MacOS/AgentMux': 'Private file, never executed',
      'Contents/_CodeSignature/CodeResources': 'Private signature seal, OS verification remains controlled',
      'Contents/Resources/app/package-identity.json': JSON.stringify({ ...identity, sourceCommit }),
      'Contents/Resources/app/out/renderer/release.json': JSON.stringify({ identity: { shell: 'same-shell', ctxmux: 'same-native' } }),
      [`Contents/Resources/app/node_modules/@agentmux/core/vendor/ctxmux/${process.platform}-${process.arch}/manifest.json`]: 'Same private Native artifact'
    })) {
      const target = join(directory!, relative); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
    }
  }
  const session = (kind: 'agent' | 'terminal', regionId: string) => ({ kind, regionId, workspaceId: 'workspace',
    sessionId: `${regionId}-${kind === 'terminal' ? 'run' : 'session'}`, phase: 'attached' as const, processState: 'running' as const,
    control: kind === 'agent'
      ? { kind, hostId: 'local', agentSessionId: `${regionId}-session`, run: { runId: `${regionId}-run` } }
      : { kind, hostId: 'local', runId: `${regionId}-run`, run: { runId: `${regionId}-run` } } })
  const observation = {
    schema: 'agentmux.desktop-client-observation.v1',
    main: { pid: 201, package: identity, renderer: { kind: 'bundled', id: 'd'.repeat(64), identity: { shell: 'same-shell', ctxmux: 'same-native' } },
      storage: { userState: { path: join(root, 'workbench-user-state.json'), availability: 'present',
        contentDigest: 'e'.repeat(64), sizeBytes: 1, diskDurability: 'unconfirmed', confirmedAt: null, lastFailure: null,
        lastConfirmedWrite: { path: join(root, 'workbench-user-state.json'), contentDigest: 'e'.repeat(64), sizeBytes: 1,
          diskDurability: 'confirmed', confirmedAt: 1 } }, spatialRevision: 1 }, runtimes: [] },
    workbench: { loading: false, startupProgress: { step: 'layout' }, startupAgentAvailability: null, activeWorkspaceId: 'workspace', mainSurface: 'workbench',
      persistence: { userStatePending: false, userStateContentDigest: 'e'.repeat(64), spatial: { revision: 1, aligned: true } },
      focus: { executionSessionId: 'agent-session', pmoSessionId: null },
      survey: { pageReferences: [], collectedZoneIds: ['zone-missing', 'zone-a'],
        organization: { ungrouped: ['zone-a'], groups: [{ groupId: 'survey-group', name: 'Retained research', collapsed: true, zoneIds: ['zone-missing', 'closed-zone-slot'] }] },
        selection: { zoneId: 'zone-a', selection: [{ tabId: 'tab-b', regionId: 'browser' }], active: { tabId: 'tab-b', regionId: 'browser' } } },
      desktop: { selection: { surface: 'space', mainSurface: 'workbench', focusView: null, space: null, goalId: null },
        presentation: { provenance: 'observed', state: 'main-visible', tabId: 'tab-a', regionId: 'agent', blockers: [] },
        input: { provenance: 'observed', scope: 'main', ownerKind: 'terminal', tabId: 'tab-a', regionId: 'agent', sessionId: 'agent-session', connected: true, visible: true, inert: false },
        floating: { provenance: 'observed', state: 'closed', topicId: null, tabId: null, regionId: null, sessionId: null, presentation: 'hidden' },
        overlays: { provenance: 'observed', settings: false, quickSwitcher: false }, focus: { executionSessionId: 'agent-session', pmoSessionId: null, agent: null } },
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
  // Advance only this test's retry clock by one fifth of the product's 300-second GUI hang guard;
  // timers and the shipped bound remain original.
  vi.spyOn(Date, 'now').mockImplementation(() => io.tick += 60_000)
  vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('Live signals are forbidden') })
  return { home, app, candidate }
}
async function install(f: Awaited<ReturnType<typeof fixture>>, intent: 'ui-only' | 'full' = 'ui-only', preparedApplicationPath: string | null = null, selectedSource = f.candidate) {
  const { installApplication } = await import('../scripts/package-macos.mjs')
  io.copyTarget = preparedApplicationPath ?? ''
  return installApplication(selectedSource, { intent, homeDirectory: f.home, preparedApplicationPath,
    quit: async (_path: string, admissions: unknown[]) => { expect(io.pid).toBe(201); io.quits++; io.pid = 0; return { wasRunning: true, pids: [201], admissions } },
    launch: async () => { io.pid = 202; io.cutovers++; expect(JSON.parse(await readFile(join(f.app, 'Contents/Resources/app/package-identity.json'), 'utf8')).sourceCommit).toBe('c'.repeat(40)); return [202] }
  })
}

function capturePackageProgress() {
  const rows: Record<string, unknown>[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    const line = String(chunk)
    if (line.startsWith('package_progress=')) rows.push(JSON.parse(line.slice('package_progress='.length)))
    return true
  })
  return rows
}

it('[package-progress] reports unavailable reads during the original GUI qualification and stops after installation', async () => {
  const f = await fixture(), rows = capturePackageProgress()
  io.outgoingMisses = 1; io.missesAfterLaunch = 1
  const schedule = setInterval
  const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay) => {
    expect(delay).toBe(5_000)
    return schedule(callback, 25)
  })
  const clear = vi.spyOn(globalThis, 'clearInterval')
  const result = await install(f)
  expect(result.ui.status).toBe('committed')
  for (const stage of ['outgoing-gui', 'installed-gui']) {
    const progress = rows.filter(row => row.stage === stage)
    expect(progress[0]).toMatchObject({ status: 'started' })
    expect(progress).toEqual(expect.arrayContaining([expect.objectContaining({
      status: 'waiting', lastFailedCheck: 'app-inspect-unavailable', lastQueryMs: expect.any(Number), elapsedMs: expect.any(Number)
    })]))
    expect(progress.at(-1)).toMatchObject({ status: 'finished' })
  }
  for (const interval of timer.mock.results) expect(clear).toHaveBeenCalledWith(interval.value)
  expect(io.outgoingReads).toBe(2)
  expect(io.reads).toBe(2)
})

it('[package-progress] reports mismatched workbench fields without disclosing compared values', async () => {
  const f = await fixture(), rows = capturePackageProgress()
  const changedFocus = 'PRIVATE_FOCUS_VALUE'
  after().focus.executionSessionId = changedFocus
  after().layouts.workspace!.groups[0]!.activeTabId = 'tab-b'
  const error = await install(f).catch(error => error)
  expect(error.transaction.ui.continuity.after.workbench.focus.executionSessionId).toBe(changedFocus)
  expect(error.transaction.ui.status).toBe('unknown')
  expect(rows.at(-1)).toMatchObject({ stage: 'installed-gui', status: 'failed', check: 'workbench-continuity',
    lastFailedCheck: 'workbench-continuity', changedWorkbenchFields: ['focus', 'layouts'], lastQueryMs: expect.any(Number) })
  expect(JSON.stringify(rows)).not.toContain(changedFocus)
  expect(JSON.stringify(rows)).not.toContain(f.home)
  expect(io.cutovers).toBe(1)
})

const after = () => io.after!.workbench
const agent = () => after().tabs[0]!.regions[0]! as Extract<DesktopClientObservation['workbench']['tabs'][number]['regions'][number], { kind: 'agent' }>
const browser = () => after().tabs[1]!.regions[0]! as Extract<DesktopClientObservation['workbench']['tabs'][number]['regions'][number], { kind: 'browser' }>

it.each(['before', 'after', 'both'] as const)('[survey-install] a missing %s Survey observation keeps the activated GUI and healthy Runs without certifying complete continuity', async missing => {
  const f = await fixture()
  if (missing !== 'after') delete io.before!.workbench.survey
  if (missing !== 'before') delete after().survey
  const result = await install(f)
  expect(result.ui.status).toBe('unknown')
  expect(result.ui.reason).toContain('Survey')
  if (missing !== 'before') expect(result.ui.observation.workbench).not.toHaveProperty('survey')
  expect(result.ui.continuity).toEqual({ before: io.before, after: io.after })
  expect(io.pid).toBe(202); expect(io.cutovers).toBe(1)
  expect(agent().control!.run.runId).toBe('agent-run')
})

it('[survey-install] observes an explicitly empty saved Survey as known empty', async () => {
  const f = await fixture(), empty = { pageReferences: [], collectedZoneIds: [], organization: { ungrouped: [], groups: [] }, selection: null }
  io.before!.workbench.survey = structuredClone(empty); after().survey = structuredClone(empty)
  const result = await install(f)
  expect(result.ui.status).toBe('committed'); expect(result.ui.observation.workbench.survey).toEqual(empty)
  expect(io.pid).toBe(202); expect(io.cutovers).toBe(1)
})

it.each([
  ['membership', () => { after().survey!.collectedZoneIds = [] }],
  ['implicit ungrouped order', () => {
    io.before!.workbench.survey!.organization = { ungrouped: [], groups: [] }
    after().survey!.organization = { ungrouped: [], groups: [] }
    after().survey!.collectedZoneIds.reverse()
  }],
  ['stored missing reference', () => { after().survey!.organization.groups[0]!.zoneIds = ['closed-zone-slot'] }],
  ['stored closed slot', () => { after().survey!.organization.groups[0]!.zoneIds = ['zone-missing'] }],
  ['group collapse', () => { after().survey!.organization.groups[0]!.collapsed = false }],
  ['group name', () => { after().survey!.organization.groups[0]!.name = 'Other collection' }],
  ['member order', () => { after().survey!.organization.groups[0]!.zoneIds.reverse() }],
  ['independent selection', () => { after().survey!.selection = null }]
] as const)('[survey-install] changed %s cannot borrow unchanged Tabs to certify continuity', async (_field, change) => {
  const f = await fixture(), tabs = structuredClone(io.before!.workbench.tabs)
  change(); const before = structuredClone(io.before), expected = structuredClone(io.after)
  const error = await install(f).catch(error => error)
  expect(error.message).toBe('The original workbench, Region descriptors or focus have not been restored.')
  expect(error.transaction.ui.status).toBe('unknown'); expect(error.transaction.ui.continuity).toEqual({ before, after: expected })
  expect(after().tabs).toEqual(tabs); expect(io.pid).toBe(202); expect(io.cutovers).toBe(1)
  expect(agent().control!.run.runId).toBe('agent-run')
})

it.each([
  { hostId: 'local', current: 0, total: 2, pending: true, waiting: true },
  { phase: 'unconfirmed', detail: { unavailable: ['executor-observation'] } }
])('actual installation retains auxiliary startup detail without making it admission authority: %j', async detail => {
  const f = await fixture()
  Object.assign(io.before!.workbench, { startupAgentAvailability: detail })
  Object.assign(after(), { startupAgentAvailability: detail })
  const original = structuredClone(io.before)
  const outcome = await install(f).then(result => ({ result, error: null }), error => ({ result: null, error: String(error) }))
  expect(outcome.error, 'Auxiliary startup detail must not reject an otherwise qualified original workbench').toBeNull()
  expect(outcome.result?.ui.status).toBe('committed')
  expect(outcome.result?.ui.observation.workbench.startupAgentAvailability).toEqual(detail)
  expect(io.before).toEqual(original)
  expect(io.cutovers).toBe(1)
  expect(() => parseDesktopClientObservation(original), 'The current public producer stays strict').toThrow()
})

it.each(['legacy', 'opaque'] as const)('actual installation preserves %s auxiliary desktop observations without using them as identity', async shape => {
  const f = await fixture()
  const { focusView: _focusView, ...selection } = io.before!.workbench.desktop.selection
  const desktop = shape === 'legacy' ? { ...io.before!.workbench.desktop, selection: { ...selection, spaceView: null } }
    : { provenance: 'unavailable', detail: ['selection', { input: 'unknown' }] }
  Object.assign(io.before!.workbench, { desktop })
  Object.assign(after(), { desktop: { detail: 'independent-new-observation' } })
  const original = structuredClone(io.before), expected = structuredClone(io.after)
  const outcome = await install(f).then(result => ({ result, error: null }), error => ({ result: null, error: String(error) }))
  expect(outcome.error, 'Unconsumed desktop detail must not gate the original identity').toBeNull()
  expect(outcome.result?.ui.status).toBe('committed')
  expect(outcome.result?.ui.observation).toEqual(expected)
  expect(io.before).toEqual(original); expect(io.cutovers).toBe(1)
  expect(() => parseDesktopClientObservation(original), 'The current public producer stays strict').toThrow()
})

it.each(['storage', 'focus', 'layout', 'Run'] as const)('actual installation keeps required %s strict beside opaque desktop observation', async field => {
  const f = await fixture()
  Object.assign(io.before!.workbench, { desktop: { provenance: 'unknown' } })
  if (field === 'storage') Object.assign(io.before!.main.storage!.userState!, { availability: 'unqualified' })
  if (field === 'focus') Object.assign(io.before!.workbench.focus, { executionSessionId: 14 })
  if (field === 'layout') Object.assign(io.before!.workbench.layouts.workspace!.root, { type: 'other' })
  if (field === 'Run') {
    const region = io.before!.workbench.tabs[0]!.regions[0] as ReturnType<typeof agent>
    region.control!.run.runId = ''
  }
  const error = await install(f).catch(error => error)
  expect(error.transaction.ui.status).toBe('not-started')
  expect(io.pid).toBe(201); expect(io.cutovers).toBe(0)
})

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

it.each(['', 'Updated by the original page'])('actual installation preserves recovery when the page title becomes %j', async title => {
  const f = await fixture(), original = structuredClone(io.before)
  browser().title = title
  const outcome = await install(f).then(result => ({ result, error: null }), error => ({ result: null, error: String(error) }))
  expect(outcome.error).toBeNull()
  expect(outcome.result?.ui.status).toBe('committed')
  expect(io.cutovers).toBe(1)
  expect(io.before).toEqual(original)
  expect(browser().title).toBe(title)
})

it.each(['https://example.invalid/private', 'about:blank'])('actual installation accepts private Browser restart from %s into the same empty page', async url => {
  const f = await fixture()
  Object.assign(io.before!.workbench.tabs[1]!.regions[0]!, { mode: 'private', profileId: null, url })
  Object.assign(browser(), { mode: 'private', profileId: null, url: 'about:blank', title: 'Private page' })
  const original = structuredClone(io.before), expected = structuredClone(io.after)
  const result = await install(f)
  expect(result.ui.status).toBe('committed')
  expect(result.ui.observation).toEqual(expected)
  expect(io.before).toEqual(original); expect(io.after).toEqual(expected); expect(io.cutovers).toBe(1)
})

it.each(['retained URL', 'different URL', 'mode', 'Profile', 'Browser identity', 'normal URL', 'unspecified mode URL'] as const)(
  'actual installation rejects changed private Browser restart %s without rewriting observations', async field => {
    const f = await fixture(), originalBrowser = io.before!.workbench.tabs[1]!.regions[0]! as ReturnType<typeof browser>
    Object.assign(originalBrowser, { mode: 'private', profileId: null })
    Object.assign(browser(), { mode: 'private', profileId: null, url: 'about:blank' })
    if (field === 'retained URL') browser().url = originalBrowser.url
    if (field === 'different URL') browser().url = 'https://example.invalid/other-private'
    if (field === 'mode') browser().mode = 'normal'
    if (field === 'Profile') browser().profileId = 'foreign-profile'
    if (field === 'Browser identity') browser().browserId = 'replacement-browser'
    if (field === 'normal URL') { originalBrowser.mode = 'normal'; browser().mode = 'normal' }
    if (field === 'unspecified mode URL') { delete originalBrowser.mode; delete browser().mode }
    const before = structuredClone(io.before), expected = structuredClone(io.after)
    const error = await install(f).catch(error => error)
    expect(error.message).toBe('The original workbench, Region descriptors or focus have not been restored.')
    expect(error.transaction.ui.status).toBe('unknown')
    expect(error.transaction.ui.continuity).toEqual({ before, after: expected })
    expect(io.before).toEqual(before); expect(io.after).toEqual(expected); expect(io.cutovers).toBe(1)
  }
)

it('actual installation preserves an original unconfirmed Browser without requiring it to open', async () => {
  const f = await fixture()
  const originalBrowser = io.before!.workbench.tabs[1]!.regions[0]!
  Object.assign(originalBrowser, { navigationId: null, nativeOwner: 'unconfirmed' })
  Object.assign(browser(), { navigationId: null, nativeOwner: 'unconfirmed' })
  const original = structuredClone(io.before)
  const result = await install(f)
  expect(result.ui.status).toBe('committed')
  expect(io.cutovers).toBe(1)
  expect(io.before).toEqual(original)
  expect(browser().navigationId).toBeNull()
  expect(browser().nativeOwner).toBe('unconfirmed')
})

it('actual installation still rejects replacing an original unconfirmed Browser identity', async () => {
  const f = await fixture()
  Object.assign(io.before!.workbench.tabs[1]!.regions[0]!, { navigationId: null, nativeOwner: 'unconfirmed' })
  Object.assign(browser(), { navigationId: null, nativeOwner: 'unconfirmed', browserId: 'replacement' })
  const error = await install(f).catch(error => error)
  expect(error.message).toBe('The original workbench, Region descriptors or focus have not been restored.')
  expect(error.transaction.ui.status).toBe('unknown')
  expect(error.transaction.ui.continuity.before).toEqual(io.before)
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
  ['browser descriptor', () => { browser().url = 'https://example.invalid/other' }],
  ['browser identity', () => { browser().browserId = 'different-browser' }],
  ['browser profile', () => { browser().profileId = 'different-profile' }]
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
  ['missing navigation', () => { Object.assign(browser(), { navigationId: null, nativeOwner: 'unconfirmed' }) }],
  ['page error', () => { browser().error = 'PRIVATE_NAVIGATION_FAILED' }]
] as const)('actual installation retains local Browser observation for %s without gating the original workbench', async (_name, change) => {
  const f = await fixture(); change()
  const original = structuredClone(io.before), expected = structuredClone(io.after)
  const outcome = await install(f).then(result => ({ result, error: null }), error => ({ result: null, error: error.message }))
  expect(outcome.error, 'A local Browser observation must not revoke the restored original workbench').toBeNull()
  expect(outcome.result?.ui.status).toBe('committed')
  expect(outcome.result?.ui.observation).toEqual(expected)
  expect(io.before).toEqual(original)
  expect(io.cutovers).toBe(1)
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
it('a relaunched GUI that answers after the former 30-second window still commits', async () => {
  // One missed read already spans a 60-second clock step, beyond the former 30-second window.
  const f = await fixture(); io.missesAfterLaunch = 1
  const result = await install(f)
  expect(result.ui.status).toBe('committed')
  expect(io.reads).toBe(2)
})
it('a Region that had no confirmed Run before the update keeps the activated GUI and reports it unconfirmed', async () => {
  const f = await fixture()
  for (const side of [io.before!.workbench, after()]) {
    const region = side.tabs[0]!.regions[0]! as { control: unknown; phase: string; regionId: string }
    region.control = null; region.phase = 'launching'
  }
  const result = await install(f)
  expect(result.ui.status).toBe('unknown')
  expect(result.ui.reason).toContain(io.before!.workbench.tabs[0]!.regions[0]!.regionId)
  expect(result.ui.continuity).toEqual({ before: io.before, after: io.after })
  expect(io.pid).toBe(202); expect(io.cutovers).toBe(1)
})
it('unavailable activation never invents an after observation', async () => {
  const f = await fixture(); io.failEveryRead = true
  const error = await install(f).catch(error => error)
  expect(error.message).toBe('PRIVATE_RPC_UNAVAILABLE')
  expect(error.transaction.ui.continuity).toEqual({ before: io.before, after: null })
})
it('a missed outgoing read is retried and the original workbench still installs', async () => {
  const f = await fixture(); io.outgoingMisses = 1
  const result = await install(f)
  expect(io.outgoingReads).toBe(2)
  expect(result.ui.status).toBe('committed')
  expect(io.cutovers).toBe(1)
})
it('an outgoing read that stays unavailable rejects without requesting quit', async () => {
  const f = await fixture(); io.outgoingMisses = Infinity
  const error = await install(f).catch(error => error)
  expect(error.message).toBe('CONTROL_TIMEOUT')
  expect(error.transaction.ui.status).toBe('not-started')
  expect(io.outgoingReads).toBeGreaterThan(1)
  expect(io.pid).toBe(201); expect(io.cutovers).toBe(0)
})
it('outgoing qualification failure preserves the observed snapshot without requesting quit', async () => {
  const f = await fixture(); io.before!.workbench.loading = true
  const error = await install(f).catch(error => error)
  expect(error.transaction.ui.status).toBe('not-started')
  expect(error.transaction.ui.continuity).toEqual({ before: null, after: io.before })
  expect(io.outgoingReads, 'A failed check on an actual observation is not retried').toBe(1)
  expect(io.pid).toBe(201); expect(io.cutovers).toBe(0)
})

it.each(['ui-only', 'full'] as const)('old-producer %s installation keeps the running App and reaches the original cold route after normal exit', async intent => {
  const f = await fixture(), userData = join(f.home, 'Library/Application Support/AgentMux')
  const original = join(userData, 'original-user-data'), bytes = 'PRIVATE retained old user bytes'
  await mkdir(userData, { recursive: true }); await writeFile(original, bytes)
  io.before!.main.storage = { userData, sessionData: userData, directory: userData, localStorage: 'present', detail: null }
  delete io.before!.workbench.persistence
  const error = await install(f, intent).catch(error => error)
  expect(error.message).toContain("original application's normal Quit")
  expect(error.transaction.ui.status).toBe('not-started')
  expect(io.pid).toBe(201); expect(io.cutovers).toBe(0)
  expect(JSON.parse(await readFile(join(f.app, 'Contents/Resources/app/package-identity.json'), 'utf8')).sourceCommit).toBe('a'.repeat(40))
  expect(await readFile(original, 'utf8')).toBe(bytes)
  // This is a new external observation after the original normal exit, never a forced Quit.
  io.pid = 0
  const result = await install(f, intent)
  expect(result.ui.status).toBe('unknown')
  expect(result.ui.reason).toContain('Without an outgoing workbench observation')
  expect(io.pid).toBe(202); expect(io.cutovers).toBe(1)
  expect(await readFile(original, 'utf8')).toBe(bytes)
})

const rawTerminal = (observation = io.after!) => observation.workbench.tabs[0]!.regions[1]! as Extract<DesktopClientObservation['workbench']['tabs'][number]['regions'][number], { kind: 'terminal' }>
async function terminalRebindingFixture() {
  const f = await fixture(), root = dirname(f.candidate)
  const runtime = { runtimeId: 'private-runtime', daemonInstanceId: 'private-instance', buildId: 'private-build', protocolGeneration: 22 }
  const local = { hostId: 'local', identity: { hostId: 'local', buildIdentity: runtime.buildId, protocolVersion: 22, processId: null, instanceId: runtime.daemonInstanceId } }
  io.before!.main.runtimes = [structuredClone(local)]; io.after!.main.runtimes = [structuredClone(local)]
  rawTerminal(io.before!).processState = 'interrupted'
  Object.assign(rawTerminal(), { sessionId: 'replacement-run', control: { kind: 'terminal', hostId: 'local', runId: 'replacement-run', run: { runId: 'replacement-run' } } })
  const states = { 'terminal-run': { id: 'terminal-run', state: { type: 'interrupted', reason: 'daemon_restart' }, spec: { cwd: '/private/original-cwd' } },
    'replacement-run': { id: 'replacement-run', state: { type: 'running' }, spec: { cwd: '/private/original-cwd' } } }
  const config = join(root, 'native.json'), sdk = join(root, 'sdk.mjs'), reads = join(root, 'native-reads.ndjson')
  await writeFile(reads, '')
  await writeFile(sdk, `import {readFileSync,appendFileSync} from 'node:fs';export class CtxmuxClient {
    constructor(options){ const config=JSON.parse(readFileSync(${JSON.stringify(config)},'utf8'));if(JSON.stringify(options.expectedRuntimeIdentity)!==JSON.stringify(config.runtime))throw Error('PRIVATE_NATIVE_IDENTITY_CHANGED') }
    async status(id){appendFileSync(${JSON.stringify(reads)},JSON.stringify({id})+'\\n');const config=JSON.parse(readFileSync(${JSON.stringify(config)},'utf8'));if(config.error)throw Error(config.error);return config.states[id]}
    async listPage(){throw Error('UNRELATED_INVENTORY_FORBIDDEN')} }
  `)
  io.nativePlan = { newSdk: sdk, old: { socketPath: join(root, 'private.sock') } }
  io.nativeConfirmation = { runtime: structuredClone(runtime), originalRuns: [] }
  const sourceLoader = pathToFileURL(join(import.meta.dirname, '../scripts/fixtures/install-terminal-continuity/source-loader.mjs')).href
  vi.stubEnv('NODE_OPTIONS', (process.env.NODE_OPTIONS ?? '') + ' --experimental-transform-types --import=' + sourceLoader)
  const state = { runtime, states, error: '' }
  const save = async () => writeFile(config, JSON.stringify(state))
  await save()
  return { ...f, state, save, reads }
}
it('[terminal-install] admits only proven interrupted raw replacement and records exact Native bindings', async () => {
  const f = await terminalRebindingFixture(), original = structuredClone(io.before), expected = structuredClone(io.after)
  const outcome = await install(f).then(result => ({ result, error: null }), error => ({ result: null, error: error.message }))
  expect(outcome.error, 'Proven raw Run replacement must qualify through the real installer').toBeNull()
  const result = outcome.result!
  expect(result.ui.status, 'Typed raw Run replacement must not masquerade as durable Session loss').toBe('committed')
  expect(result.ui.terminalRebindings).toEqual([{ tabId: 'tab-a', regionId: 'terminal', hostId: 'local',
    previousRunId: 'terminal-run', currentRunId: 'replacement-run', runtimeId: f.state.runtime.runtimeId, daemonInstanceId: f.state.runtime.daemonInstanceId,
    previous: { id: 'terminal-run', state: f.state.states['terminal-run'].state, workspacePath: '/private/original-cwd' },
    current: { id: 'replacement-run', state: f.state.states['replacement-run'].state, workspacePath: '/private/original-cwd' } }])
  expect((await readFile(f.reads, 'utf8')).trim().split('\n').map(row => JSON.parse(row).id)).toEqual(['terminal-run', 'replacement-run'])
  expect(io.before).toEqual(original); expect(io.after).toEqual(expected); expect(io.pid).toBe(202); expect(io.cutovers).toBe(1)
})
it.each(['old-running', 'old-exited', 'reason', 'new-ended', 'cwd', 'missing-cwd', 'wrong-run', 'unknown', 'Native-owner', 'UI-owner', 'Host', 'control', 'healthy-Terminal', 'Agent-SID', 'focus', 'layout', 'missing-plan', 'same-SID-control-run', 'same-SID-host'] as const)(
  '[terminal-install] refuses unproven replacement %s and retains the activated GUI and original evidence', async field => {
    const f = await terminalRebindingFixture(), previous = f.state.states['terminal-run'], current = f.state.states['replacement-run']
    if (field === 'old-running') Object.assign(previous, { state: { type: 'running' } })
    if (field === 'old-exited') Object.assign(previous, { state: { type: 'exited', code: 0 } })
    if (field === 'reason') previous.state.reason = 'other-interruption'
    if (field === 'new-ended') Object.assign(current, { state: { type: 'exited', code: 0 } })
    if (field === 'cwd') current.spec.cwd = '/private/other-cwd'
    if (field === 'missing-cwd') Object.assign(previous, { spec: undefined })
    if (field === 'wrong-run') current.id = 'foreign-run'
    if (field === 'unknown') f.state.error = 'PRIVATE_NATIVE_UNKNOWN'
    if (field === 'Native-owner') f.state.runtime.daemonInstanceId = 'changed-owner'
    if (field === 'UI-owner') io.after!.main.runtimes[0]!.identity.instanceId = 'changed-owner'
    if (field === 'Host') rawTerminal().control!.hostId = 'different-host'
    if (field === 'control') rawTerminal().control!.run.runId = 'different-run'
    if (field === 'healthy-Terminal') rawTerminal(io.before!).processState = 'running'
    if (field === 'Agent-SID') agent().sessionId = 'different-Agent-SID'
    if (field === 'focus') after().focus.executionSessionId = 'different-focus'
    if (field === 'layout') after().layouts.workspace!.groups[0]!.tabOrder.reverse()
    if (field === 'missing-plan') io.nativePlan = null
    if (field === 'same-SID-control-run') rawTerminal().sessionId = 'terminal-run'
    if (field === 'same-SID-host') Object.assign(rawTerminal(), { sessionId: 'terminal-run', control: { kind: 'terminal', hostId: 'foreign-host', runId: 'terminal-run', run: { runId: 'terminal-run' } } })
    await f.save()
    const before = structuredClone(io.before), expected = structuredClone(io.after), error = await install(f).catch(error => error)
    expect(error.transaction?.ui.status, 'No generic Terminal-ID exemption may certify unproved continuity').toBe('unknown')
    expect(error.transaction.ui.continuity).toEqual({ before, after: expected })
    expect(io.before).toEqual(before); expect(io.after).toEqual(expected); expect(io.pid).toBe(202); expect(io.cutovers).toBe(1)
  }
)


it('[prepared-stage] default installation still copies and qualifies the selected candidate', async () => {
  const f = await fixture()
  const result = await install(f, 'full')
  expect(result.ui.status).toBe('committed')
  expect(io.copies).toBe(1); expect(io.quits).toBe(1); expect(io.cutovers).toBe(1)
  expect(io.signaturePaths).toHaveLength(1)
  expect(await readdir(dirname(f.app))).toEqual(['AgentMux.app'])
})

it.each(['copy', 'signature', 'qualification'] as const)('[stage-cleanup] %s failure reclaims only this attempt and preserves the signed source and live App', async failure => {
  const f = await fixture(), unrelated = join(dirname(f.app), '.AgentMux.install-123.app')
  await mkdir(unrelated); await writeFile(join(unrelated, 'retained'), 'other attempt')
  if (failure === 'copy') io.copyFailure = true
  if (failure === 'signature') io.signatureFailure = true
  if (failure === 'qualification') io.before!.workbench.loading = true
  const error = await install(f).catch(error => error)
  expect(error).toBeInstanceOf(Error)
  expect(error.installStage.status).toBe('removed')
  expect(await readdir(dirname(f.app))).toEqual(['.AgentMux.install-123.app', 'AgentMux.app'])
  expect(await readFile(join(unrelated, 'retained'), 'utf8')).toBe('other attempt')
  expect(await readFile(join(f.candidate, 'Contents/MacOS/AgentMux'), 'utf8')).toContain('Private file')
  expect(io.pid).toBe(201); expect(io.quits).toBe(0)
  if (failure === 'qualification') {
    expect(error.transaction.ui.status).toBe('not-started')
    expect(error.transaction.installStage).toEqual(error.installStage)
  }
})

it.each(['missing', 'seal'] as const)('[stage-cleanup] a %s signed source preserves the continuation candidate', async change => {
  const f = await fixture(); io.signatureFailure = true; io.sourceChange = change
  const error = await install(f).catch(error => error)
  expect(error.message).toContain('PRIVATE_SIGNATURE_INVALID')
  expect(error.installStage.status).toBe('retained')
  expect(await readFile(join(error.installStage.path, 'Contents/_CodeSignature/CodeResources'), 'utf8')).toContain('Private signature seal')
  expect(io.pid).toBe(201); expect(io.quits).toBe(0)
})

it('[stage-cleanup] a replaced stage object is retained at the same pathname', async () => {
  const f = await fixture(); io.signatureFailure = true; io.replaceStage = true
  const error = await install(f).catch(error => error)
  expect(error.message).toContain('PRIVATE_SIGNATURE_INVALID')
  expect(error.installStage.status).toBe('retained')
  expect(error.installStage.reason).toContain('changed identity')
  expect(await readFile(join(error.installStage.path, 'foreign-content'), 'utf8')).toBe('preserve this replacement')
})

it('[stage-cleanup] cleanup failure preserves the original installation error and transaction', async () => {
  const f = await fixture(); io.before!.workbench.loading = true; io.cleanupFailure = true
  const error = await install(f).catch(error => error)
  expect(error.message).toBe('The saved workbench is still loading; no UI commit can be confirmed.')
  expect(error.transaction.ui.status).toBe('not-started')
  expect(error.installStage).toEqual({ status: 'retained', path: io.signaturePaths[0], reason: 'PRIVATE_CLEANUP_FAILED' })
  expect(await lstat(error.installStage.path)).toBeDefined()
  expect(io.pid).toBe(201); expect(io.quits).toBe(0)
})

it('[stage-cleanup] cutover failure retains the qualified candidate for continuation', async () => {
  const f = await fixture(); io.cutoverFailure = true
  const error = await install(f).catch(error => error)
  expect(error.message).toBe('PRIVATE_CUTOVER_FAILED')
  expect(error.installStage.status).toBe('retained')
  expect(error.installStage.reason).toContain('cutover began')
  expect(await readFile(join(error.installStage.path, 'Contents/MacOS/AgentMux'), 'utf8')).toContain('Private file')
  expect(await readFile(join(f.app, 'Contents/MacOS/AgentMux'), 'utf8')).toContain('Private file')
})

it.each(['source', 'stage'] as const)('[stage-cleanup] unavailable %s cleanup evidence does not block the original successful install', async probe => {
  const f = await fixture(); io.cleanupProbeUnavailable = probe
  const result = await install(f)
  expect(result.ui.status).toBe('committed')
  expect(io.quits).toBe(1); expect(io.cutovers).toBe(1)
  expect(await readdir(dirname(f.app))).toEqual(['AgentMux.app'])
})

it('[stage-cleanup] a retained uniquely named stage can be explicitly adopted without another copy', async () => {
  const f = await fixture(); io.signatureFailure = true; io.cleanupFailure = true
  const error = await install(f).catch(error => error), stage = error.installStage.path
  io.signatureFailure = false; io.cleanupFailure = false
  const result = await install(f, 'full', stage)
  expect(result.ui.status).toBe('committed')
  expect(io.copies).toBe(1)
  expect(io.signaturePaths).toEqual([stage, stage])
  expect(await readdir(dirname(f.app))).toEqual(['AgentMux.app'])
})

it('[prepared-stage] reuses the exact retained directory without copy or removal through the full install consumer', async () => {
  const f = await fixture(), stage = join(dirname(f.app), '.AgentMux.install-73421.app')
  await cp(f.candidate, stage, { recursive: true })
  const original = await lstat(stage)
  const result = await install(f, 'full', stage)
  const activated = await lstat(f.app)
  expect(result.ui.status).toBe('committed'); expect(result.native.status).toBe('unchanged')
  expect(io.copies).toBe(0); expect(io.quits).toBe(1); expect(io.cutovers).toBe(1)
  expect(io.signaturePaths).toEqual([stage])
  expect({ dev: activated.dev, ino: activated.ino, uid: activated.uid }).toEqual({ dev: original.dev, ino: original.ino, uid: original.uid })
  io.resultFacts = { ui: result.ui.status, native: result.native.status, original: { dev: original.dev, ino: original.ino, uid: original.uid }, activated: { dev: activated.dev, ino: activated.ino, uid: activated.uid }, originalRunId: agent().control!.run.runId }
  expect(agent().control!.run.runId).toBe('agent-run')
  expect(browser().browserId).toBe('browser-id')
  expect(JSON.parse(await readFile(join(f.candidate, 'Contents/Resources/app/package-identity.json'), 'utf8')).sourceCommit).toBe('c'.repeat(40))
})

it.each(['outside', 'wrong-name', 'symlink', 'file', 'foreign-uid'] as const)('[prepared-stage] rejects %s before quit or cutover while retaining all original directories', async kind => {
  const f = await fixture()
  const stage = kind === 'outside' ? join(dirname(f.home), '.AgentMux.install-73421.app')
    : join(dirname(f.app), kind === 'wrong-name' ? 'retained.app' : '.AgentMux.install-73421.app')
  if (kind === 'symlink') await symlink(f.candidate, stage, 'dir')
  else if (kind === 'file') await writeFile(stage, 'Private non-directory stage')
  else await cp(f.candidate, stage, { recursive: true })
  if (kind === 'foreign-uid') io.foreignStage = stage
  await expect(install(f, 'full', stage)).rejects.toThrow('prepared installer stage')
  expect(io.copies).toBe(0); expect(io.quits).toBe(0); expect(io.cutovers).toBe(0); expect(io.signaturePaths).toEqual([])
  expect((await lstat(stage)).isSymbolicLink()).toBe(kind === 'symlink')
  expect(JSON.parse(await readFile(join(f.app, 'Contents/Resources/app/package-identity.json'), 'utf8')).sourceCommit).toBe('a'.repeat(40))
})

it('[prepared-stage] rejects a different package identity before quit or cutover and preserves the stage', async () => {
  const f = await fixture(), stage = join(dirname(f.app), '.AgentMux.install-73421.app')
  await cp(f.candidate, stage, { recursive: true })
  const identityPath = join(stage, 'Contents/Resources/app/package-identity.json')
  const identity = JSON.parse(await readFile(identityPath, 'utf8')); identity.sourceCommit = 'd'.repeat(40)
  await writeFile(identityPath, JSON.stringify(identity))
  await expect(install(f, 'full', stage)).rejects.toThrow('Package identity mismatch')
  expect(io.copies).toBe(0); expect(io.quits).toBe(0); expect(io.cutovers).toBe(0); expect(io.signaturePaths).toEqual([])
  expect(JSON.parse(await readFile(identityPath, 'utf8'))).toEqual(identity)
  expect(JSON.parse(await readFile(join(f.app, 'Contents/Resources/app/package-identity.json'), 'utf8')).sourceCommit).toBe('a'.repeat(40))
})

it('[prepared-stage] still verifies the retained signature before quit or cutover', async () => {
  const f = await fixture(), stage = join(dirname(f.app), '.AgentMux.install-73421.app')
  await cp(f.candidate, stage, { recursive: true }); io.signatureFailure = true
  await expect(install(f, 'full', stage)).rejects.toThrow('PRIVATE_SIGNATURE_INVALID')
  expect(io.copies).toBe(0); expect(io.quits).toBe(0); expect(io.cutovers).toBe(0); expect(io.signaturePaths).toEqual([stage])
  expect((await lstat(stage)).isDirectory()).toBe(true)
  expect(JSON.parse(await readFile(join(f.app, 'Contents/Resources/app/package-identity.json'), 'utf8')).sourceCommit).toBe('a'.repeat(40))
})


it('[prepared-stage] adopts the same real retained object as its selected signed source without copy', async () => {
  const f = await fixture(), stage = join(dirname(f.app), '.AgentMux.install-73421.app')
  await cp(f.candidate, stage, { recursive: true })
  const original = await lstat(stage)
  const result = await install(f, 'full', stage, stage)
  expect(result.ui.status).toBe('committed'); expect(result.native.status).toBe('unchanged')
  expect(io.copies).toBe(0); expect(io.quits).toBe(1); expect(io.cutovers).toBe(1); expect(io.signaturePaths).toEqual([stage])
  expect((await lstat(f.app)).ino).toBe(original.ino)
  io.resultFacts = { selectedSourceIsPreparedObject: true, originalInode: original.ino, activatedInode: (await lstat(f.app)).ino, ui: result.ui.status, native: result.native.status }
})

it.each(['Contents/MacOS/AgentMux', 'Contents/_CodeSignature/CodeResources'])('[prepared-stage] rejects same identity with different signed bytes in %s before quit or cutover', async artifact => {
  const f = await fixture(), stage = join(dirname(f.app), '.AgentMux.install-73421.app')
  await cp(f.candidate, stage, { recursive: true })
  await writeFile(join(stage, artifact), 'Different private signed artifact bytes')
  await expect(install(f, 'full', stage)).rejects.toThrow('does not match the selected signed application')
  expect(io.copies).toBe(0); expect(io.quits).toBe(0); expect(io.cutovers).toBe(0); expect(io.signaturePaths).toEqual([])
  expect(JSON.parse(await readFile(join(stage, 'Contents/Resources/app/package-identity.json'), 'utf8'))).toEqual(JSON.parse(await readFile(join(f.candidate, 'Contents/Resources/app/package-identity.json'), 'utf8')))
  expect(await readFile(join(stage, artifact), 'utf8')).toBe('Different private signed artifact bytes')
  expect(JSON.parse(await readFile(join(f.app, 'Contents/Resources/app/package-identity.json'), 'utf8')).sourceCommit).toBe('a'.repeat(40))
})


it('[prepared-stage] rejects a canonical reverse alias to the retained stage before quit or cutover', async () => {
  const f = await fixture(), stage = join(dirname(f.app), '.AgentMux.install-73421.app')
  await cp(f.candidate, stage, { recursive: true })
  await rm(f.app, { recursive: true }); await symlink(stage, f.app, 'dir')
  // This real alias serves the staged identity; keep the controlled GUI facts
  // accurate so deleting only the new guard reaches the actual bad cutover.
  io.before!.main.package = JSON.parse(await readFile(join(stage, 'Contents/Resources/app/package-identity.json'), 'utf8'))
  const canonical = await stat(f.app), retained = await lstat(stage)
  expect((await lstat(f.app)).isSymbolicLink()).toBe(true)
  expect({ dev: canonical.dev, ino: canonical.ino }).toEqual({ dev: retained.dev, ino: retained.ino })
  io.resultFacts = { reverseAlias: true, canonical: { dev: canonical.dev, ino: canonical.ino }, retained: { dev: retained.dev, ino: retained.ino } }
  await expect(install(f, 'full', stage)).rejects.toThrow('different real directory from the canonical application')
  expect(io.copies).toBe(0); expect(io.quits).toBe(0); expect(io.cutovers).toBe(0); expect(io.signaturePaths).toEqual([])
  expect((await lstat(f.app)).isSymbolicLink()).toBe(true)
  expect((await lstat(stage)).ino).toBe(retained.ino)
  expect((await stat(f.app)).ino).toBe(retained.ino)
})


it.each(['before', 'after', 'both'] as const)('[survey-pages-install] missing %s Page reference facts stay unknown through the original installer without blocking healthy GUI and Runs', async missing => {
  const f = await fixture()
  if (missing !== 'after') Reflect.deleteProperty(io.before!.workbench.survey!, 'pageReferences')
  if (missing !== 'before') Reflect.deleteProperty(after().survey!, 'pageReferences')
  const original = structuredClone(io.before), expected = structuredClone(io.after)
  const outcome = await install(f).then(result => ({ result, error: null }), error => ({ result: null, error }))
  expect(io.pid).toBe(202); expect(io.quits).toBe(1); expect(io.cutovers).toBe(1)
  expect(agent().control!.run.runId).toBe('agent-run'); expect(io.before).toEqual(original); expect(io.after).toEqual(expected)
  expect(outcome.error, 'Only an observed Page reference may enter workbench identity').toBeNull()
  expect(outcome.result?.ui.status, 'An absent Page reference is unknown, never complete continuity').toBe('unknown')
  expect(outcome.result?.ui.reason).toContain('Page reference')
  expect(outcome.result?.ui.continuity).toEqual({ before: original, after: expected })
  if (missing !== 'after') expect(outcome.result?.ui.continuity?.before?.workbench.survey).not.toHaveProperty('pageReferences')
  if (missing !== 'before') expect(outcome.result?.ui.observation.workbench.survey).not.toHaveProperty('pageReferences')
})

it('[survey-pages-install] current explicitly empty Page references remain known and can certify unchanged original workbench', async () => {
  const f = await fixture(), original = structuredClone(io.before), expected = structuredClone(io.after), result = await install(f)
  expect(result.ui.status).toBe('committed'); expect(result.ui.observation.workbench.survey?.pageReferences).toEqual([])
  expect(io.before).toEqual(original); expect(io.after).toEqual(expected); expect(agent().control!.run.runId).toBe('agent-run')
})

it.each(['Browser occupant', 'Region identity', 'reference order', 'removed reference'] as const)('[survey-pages-install] changed known %s cannot certify Page continuity', async change => {
  const f = await fixture(), references = [{ regionId: 'page-one', browserId: 'browser-one' }, { regionId: 'page-two', browserId: 'browser-two' }]
  Object.assign(io.before!.workbench.survey!, { pageReferences: structuredClone(references) }); Object.assign(after().survey!, { pageReferences: structuredClone(references) })
  if (change === 'Browser occupant') after().survey!.pageReferences[0]!.browserId = 'replacement-browser'
  if (change === 'Region identity') after().survey!.pageReferences[0]!.regionId = 'replacement-region'
  if (change === 'reference order') after().survey!.pageReferences.reverse()
  if (change === 'removed reference') after().survey!.pageReferences.pop()
  const original = structuredClone(io.before), expected = structuredClone(io.after)
  const outcome = await install(f).then(result => ({ result, error: null }), error => ({ result: null, error }))
  expect(io.pid).toBe(202); expect(io.before).toEqual(original); expect(io.after).toEqual(expected); expect(agent().control!.run.runId).toBe('agent-run')
  expect(outcome.error, 'Known Page reference changes must withhold complete continuity').toBeTruthy()
  expect(outcome.error?.message).toBe('The original workbench, Region descriptors or focus have not been restored.')
  expect(outcome.error?.transaction.ui.status).toBe('unknown'); expect(outcome.error?.transaction.ui.continuity).toEqual({ before: original, after: expected })
})

it.each(['empty to nonempty', 'nonempty to empty'] as const)('[survey-pages-install] changed known %s Page references cannot borrow an empty array as unknown', async change => {
  const f = await fixture(), reference = { regionId: 'browser', browserId: 'browser-id' }
  if (change === 'empty to nonempty') after().survey!.pageReferences.push(reference)
  else io.before!.workbench.survey!.pageReferences.push(reference)
  const original = structuredClone(io.before), expected = structuredClone(io.after)
  const outcome = await install(f).then(result => ({ result, error: null }), error => ({ result: null, error }))
  expect(io.before).toEqual(original); expect(io.after).toEqual(expected); expect(io.pid).toBe(202); expect(agent().control!.run.runId).toBe('agent-run')
  expect(outcome.error, 'An observed empty array must still participate in identity comparison').toBeTruthy()
  expect(outcome.error?.message).toBe('The original workbench, Region descriptors or focus have not been restored.')
  expect(outcome.error?.transaction.ui.status).toBe('unknown')
})

it.each(['membership', 'organization', 'selection', 'layout', 'Run', 'save pending'] as const)('[survey-pages-install] unknown Page observation does not weaken original %s authority', async field => {
  const f = await fixture(); Reflect.deleteProperty(io.before!.workbench.survey!, 'pageReferences')
  if (field === 'membership') after().survey!.collectedZoneIds = []
  if (field === 'organization') after().survey!.organization.groups[0]!.collapsed = false
  if (field === 'selection') after().survey!.selection = null
  if (field === 'layout') after().layouts.workspace!.groups[0]!.tabOrder.reverse()
  if (field === 'Run') agent().control!.run.runId = 'different-unconfirmed-run'
  if (field === 'save pending') io.before!.workbench.persistence!.userStatePending = true
  const original = structuredClone(io.before), expected = structuredClone(io.after)
  const outcome = await install(f).then(result => ({ result, error: null }), error => ({ result: null, error }))
  expect(io.before).toEqual(original); expect(io.after).toEqual(expected)
  expect(outcome.error, 'An unrelated missing Page observation cannot remove an existing installation guard').toBeTruthy()
  expect(outcome.result).toBeNull()
  if (field === 'save pending') { expect(io.pid).toBe(201); expect(io.quits).toBe(0); expect(io.cutovers).toBe(0); expect(outcome.error?.transaction.ui.status).toBe('not-started') }
  else { expect(io.pid).toBe(202); expect(io.cutovers).toBe(1); expect(outcome.error?.transaction.ui.status).toBe('unknown') }
})

it.each([
  { name: 'null', value: null },
  { name: 'non-array', value: { regionId: 'browser', browserId: 'browser-id' } },
  { name: 'missing Browser identity', value: [{ regionId: 'browser' }] },
  { name: 'unowned field', value: [{ regionId: 'browser', browserId: 'browser-id', extra: true }] }
])('[survey-pages-install] provided malformed $name Page facts reject before quitting the original GUI', async ({ value }) => {
  const f = await fixture(); Object.assign(io.before!.workbench.survey!, { pageReferences: value })
  const original = structuredClone(io.before), expected = structuredClone(io.after)
  const outcome = await install(f).then(result => ({ result, error: null }), error => ({ result: null, error }))
  expect(io.before).toEqual(original); expect(io.after).toEqual(expected); expect(io.pid).toBe(201); expect(io.quits).toBe(0); expect(io.cutovers).toBe(0)
  expect(outcome.error, 'A provided malformed value must not be treated as an unavailable observation').toBeTruthy()
  expect(outcome.error?.transaction.ui.status).toBe('not-started')
})
