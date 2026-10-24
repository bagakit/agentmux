// @vitest-environment happy-dom
import { appendFileSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createClientUiRoot } from './helpers/client-ui-render'
import { parseSpaceControlRequest, parseSpaceControlSuccessReceipt } from '../../../packages/core/src/space-control-parser'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import type { AgentMuxSurveyOrganization } from '@agentmux/core/control'
import { api } from '../src/renderer/src/lib/api'
import { prepareRendererUpdate, restorePersistedUiState, useAppStore } from '../src/renderer/src/store'
import { effectiveSurveyOrganization, executeSurveyList, restoreSurveyOrganization, surveyOrganizationZoneIds } from '../src/renderer/src/lib/survey-list'
import { protectedFacts, startWorkfaceFixture, config, privateEnvironment } from './helpers/workface-control-fixture'
import { objectCliReceipt } from '../../../packages/core/test/helpers/object-cli-receipt'
import * as presentationOwner from '../src/renderer/src/lib/mobile-presentation'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { restorePersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'

vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))

const original = useAppStore.getState(), empty = (): AgentMuxSurveyOrganization => ({ ungrouped: [], groups: [] })
const { build } = createRequire(resolve('packages/core/package.json'))('esbuild')
const exec = promisify(execFile)
let directory: string, cli: string, fixture: Awaited<ReturnType<typeof startWorkfaceFixture>>
let zones: string[]
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'amux-survey-list-cli-')); cli = join(directory, 'amux.mjs')
  await symlink(resolve('packages/core/node_modules'), join(directory, 'node_modules'), 'dir')
  await build({ entryPoints: ['packages/core/src/agentmux.ts'], outfile: cli, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'survey-list-source-cli', setup(builder: any) { builder.onLoad({ filter: /\.ts$/ }, (args: { path: string }) => {
      const file = relative(process.cwd(), args.path), source = readFileSync(args.path, 'utf8')
      if (!file.startsWith('packages/core/src/')) return null
      const mutant = process.env.SURVEY_LIST_MUTANT ? JSON.parse(process.env.SURVEY_LIST_MUTANT) : null
      const code = mutant?.file === file ? source.replace(mutant.before, mutant.after) : source
      if (process.env.SURVEY_LIST_LOADED) appendFileSync(process.env.SURVEY_LIST_LOADED, JSON.stringify({ consumer: 'compiled-cli', file, sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
      return { contents: code, loader: 'ts' }
    }) } }] })
}, 30_000)
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })
beforeEach(async () => {
  vi.restoreAllMocks(); localStorage.clear(); useAppStore.setState(original, true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture = await startWorkfaceFixture()
  const result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'original-survey-discovery', operation: 'space.ls', target: {} })
  expect(result.operation).toBe('space.ls')
  if (result.operation !== 'space.ls') throw new Error('Original catalog required')
  zones = [...new Set(result.catalog.zones.filter(zone => zone.kind !== 'unknown').map(zone => zone.zoneId))]
  expect(zones.length).toBeGreaterThanOrEqual(2)
  useAppStore.setState({ surveyCollectedZones: { [zones[0]!]: true, [zones[1]!]: true, 'saved-missing-zone': true }, surveyOrganization: empty(),
    surveyZoneSelection: { zoneId: zones[0]!, selection: [{ tabId: 'original-tab', regionId: 'original-region' }], active: { tabId: 'original-tab', regionId: 'original-region' } } })
  await prepareRendererUpdate(); fixture.flush.mockClear()
  fixture.snapshot.mockClear(); for (const call of fixture.lifecycle) call.mockClear()
})
afterEach(async () => { await fixture?.stop(); if (fixture) await rm(fixture.directory, { recursive: true, force: true }); vi.restoreAllMocks(); useAppStore.setState(original, true) })

async function command(args: string[], code = 0) {
  let output: { stdout: string; stderr: string }, actual = 0
  try { output = await exec(process.execPath, [cli, ...args], { env: fixture.env, timeout: 10_000 }) }
  catch (error: any) { if (typeof error.code !== 'number') throw error; output = error; actual = error.code }
  expect(actual, output.stderr).toBe(code)
  return output
}
async function list(organization?: AgentMuxSurveyOrganization, expected = useAppStore.getState().surveyOrganization, code = 0) {
  const input = join(fixture.directory, 'survey-list.json')
  if (organization) await writeFile(input, JSON.stringify({ organization, expected }))
  const output = await command(['space', 'survey-list', ...(organization ? ['--input', input] : []), '--operation-id', 'original-survey-list-operation'], code)
  const receipt = objectCliReceipt(JSON.parse(output.stdout)); expect(receipt.ok).toBe(true)
  return receipt.result
}
function grouped(): AgentMuxSurveyOrganization {
  return { ungrouped: [zones[1]!], groups: [{ groupId: 'list-group-one', name: 'Original research', collapsed: true, zoneIds: ['saved-missing-zone', zones[0]!] }] }
}

it('[survey-list] compiled CLI uses the shared Store owner, publishes every collapsed member and persists the exact organization', async () => {
  const before = protectedFacts(), selected = useAppStore.getState().surveyZoneSelection, membership = useAppStore.getState().surveyCollectedZones
  fixture.flush.mockClear()
  expect(await list()).toMatchObject({ scope: 'survey-list', outcome: 'read', storedOrganization: empty(), effectiveOrganization: { ungrouped: [zones[0], zones[1], 'saved-missing-zone'], groups: [] }, changed: false, save: null })
  expect(fixture.flush).not.toHaveBeenCalled()
  const next = grouped(), report = await list(next, empty())
  expect(report).toMatchObject({ outcome: 'changed', storedOrganization: next, effectiveOrganization: next, changed: true,
    save: { layoutApplied: false, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed' } })
  expect(useAppStore.getState().surveyOrganization).toEqual(next)
  expect(JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.surveyOrganization).toEqual(next)
  expect(restorePersistedUiState(config, JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state).surveyOrganization).toEqual(next)
  const discovery = objectCliReceipt(JSON.parse((await command(['space', 'ls', '--presentation'])).stdout)).result.catalog.survey
  expect(discovery.organization).toEqual(next)
  expect(discovery.items.map((item: { zoneId: string }) => item.zoneId)).toEqual([zones[1], 'saved-missing-zone', zones[0]])
  expect(discovery.items.find((item: { zoneId: string }) => item.zoneId === 'saved-missing-zone').issue).toBeTruthy()
  expect(useAppStore.getState().surveyZoneSelection).toBe(selected); expect(useAppStore.getState().surveyCollectedZones).toBe(membership)
  expect(protectedFacts()).toEqual(before); fixture.noLifecycle()
})

it('[survey-list] GUI and CLI share group naming, collapse, dissolution, cross-group and group ordering without moving content', async () => {
  const before = protectedFacts(), first = grouped()
  expect(await useAppStore.getState().setSurveyOrganization(first, empty())).toMatchObject({ outcome: 'changed' })
  expect((await list()).storedOrganization).toEqual(first)
  const second: AgentMuxSurveyOrganization = { ungrouped: [], groups: [
    { groupId: 'list-group-two', name: 'Second', collapsed: false, zoneIds: [zones[0]!] },
    { ...first.groups[0]!, name: 'Renamed original', collapsed: false, zoneIds: [zones[1]!, 'saved-missing-zone'] }
  ] }
  expect(await list(second, first)).toMatchObject({ storedOrganization: second })
  const dissolved = { ungrouped: [zones[0]!], groups: [second.groups[1]!] }
  expect(await list(dissolved, second)).toMatchObject({ storedOrganization: dissolved })
  // Omission dissolves only organization: explicit Survey membership remains complete.
  expect((await list(empty(), dissolved)).effectiveOrganization).toEqual({ ungrouped: [zones[0], zones[1], 'saved-missing-zone'], groups: [] })
  expect(protectedFacts()).toEqual(before); fixture.noLifecycle()
})

it('[survey-list] refuses stale and foreign writes locally while retaining original references and appending new members', async () => {
  const before = protectedFacts(), first = grouped()
  await list(first)
  expect(await list(empty(), empty(), 1)).toMatchObject({ outcome: 'refused', changed: false, save: null, issues: [{ code: 'SURVEY_LIST_CONFLICT' }] })
  expect(await list({ ungrouped: ['not-collected-zone'], groups: [] }, first, 1)).toMatchObject({ outcome: 'refused', issues: [{ code: 'SURVEY_LIST_MEMBER_UNCONFIRMED' }] })
  expect(useAppStore.getState().surveyOrganization).toEqual(first)
  useAppStore.setState(state => ({ surveyCollectedZones: { ...state.surveyCollectedZones, 'new-explicit-item': true } }))
  const effective = (await list()).effectiveOrganization
  expect(effective.ungrouped).toEqual([zones[1], 'new-explicit-item'])
  expect(effective.groups).toEqual(first.groups)
  expect(protectedFacts()).toEqual(before); fixture.noLifecycle()
})

it('[survey-list] reports unknown storage honestly and keeps the already applied organization without borrowing Core durability', async () => {
  vi.mocked(api.ui.requestStorageFlush).mockRejectedValue(new Error('Original client flush unconfirmed'))
  const result = await list(grouped(), empty(), 1)
  expect(result).toMatchObject({ outcome: 'partial', changed: true, storedOrganization: grouped(),
    save: { localStorageWritten: true, storageFlushRequested: false, diskDurability: 'unconfirmed' }, issues: [{ code: 'SURVEY_LIST_SAVE_UNCONFIRMED' }] })
  expect((await list()).storedOrganization).toEqual(grouped())
  const ports = { get: useAppStore.getState, set: (surveyOrganization: AgentMuxSurveyOrganization) => useAppStore.setState({ surveyOrganization }),
    save: async () => ({ layoutApplied: false, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'confirmed' as const, reason: null }) }
  expect((await executeSurveyList(ports, { schemaVersion: 5, requestId: 'separate-client-save', operation: 'space.survey-list', organization: empty(), expected: grouped() })).save?.diskDurability).toBe('unconfirmed')
  fixture.noLifecycle()
})

it('[survey-list] retained closed slots can still be renamed while only explicit members remain visible', async () => {
  const before = protectedFacts()
  await list(grouped())
  useAppStore.getState().setSurveyZoneCollected(zones[0]!, false)
  const next = { ...grouped(), groups: grouped().groups.map(group => ({ ...group, name: 'Renamed retained group', collapsed: false })) }
  expect(await list(next)).toMatchObject({ outcome: 'changed', storedOrganization: next,
    effectiveOrganization: { ungrouped: [zones[1]], groups: [{ ...next.groups[0], zoneIds: ['saved-missing-zone'] }] } })
  expect(useAppStore.getState().surveyCollectedZones[zones[0]!]).toBeUndefined()
  expect(useAppStore.getState().setSurveyZoneCollected(zones[0]!, true)).toBe(true)
  expect(await list()).toMatchObject({ storedOrganization: next, effectiveOrganization: next })
  const discovered = objectCliReceipt(JSON.parse((await command(['space', 'ls', '--presentation'])).stdout)).result.catalog.survey
  expect(discovered.items.map((item: { zoneId: string }) => item.zoneId)).toEqual([zones[1], 'saved-missing-zone', zones[0]])
  expect(protectedFacts()).toEqual(before)
  fixture.noLifecycle()
})

it('[survey-list] GUI rejects malformed organization and late save receipts remain bound to their original applied write', async () => {
  const selected = useAppStore.getState().surveyZoneSelection
  expect(await useAppStore.getState().setSurveyOrganization({ ungrouped: [], groups: [{ groupId: 'g', name: 'Bad', collapsed: 'yes', zoneIds: [] }] } as unknown as AgentMuxSurveyOrganization, empty())).toMatchObject({ outcome: 'refused', changed: false, save: null })
  expect(useAppStore.getState().surveyOrganization).toEqual(empty())
  let finish!: () => void
  const waiting = new Promise<void>(resolve => { finish = resolve })
  const saved = { layoutApplied: false, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed' as const, reason: null }
  const ports = { get: useAppStore.getState, set: (surveyOrganization: AgentMuxSurveyOrganization) => useAppStore.setState({ surveyOrganization }), save: async () => { await waiting; return saved } }
  const first = executeSurveyList(ports, { schemaVersion: 5, requestId: 'earlier-organization', operation: 'space.survey-list', organization: grouped(), expected: empty() })
  const later = { ...grouped(), groups: grouped().groups.map(group => ({ ...group, name: 'Later user name' })) }
  const second = await executeSurveyList({ ...ports, save: async () => saved }, { schemaVersion: 5, requestId: 'later-organization', operation: 'space.survey-list', organization: later, expected: grouped() })
  expect(second.storedOrganization).toEqual(later)
  finish(); expect((await first).storedOrganization).toEqual(grouped())
  expect(useAppStore.getState().surveyOrganization).toEqual(later)
  expect(useAppStore.getState().surveyZoneSelection).toBe(selected); fixture.noLifecycle()
})

it('[survey-list] actual Focus consumer refreshes the shared organization while collapsed groups preserve source identity and every member', async () => {
  const originalRead = vi.spyOn(presentationOwner, 'readSurveyPresentation')
  const catalog = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'focus-original-zone', operation: 'space.ls', target: {} })
  if (catalog.operation !== 'space.ls') throw new Error('Original catalog required')
  const zoneId = catalog.catalog.tabs.find(tab => tab.tabId === 'workface-original-tab')!.zoneId!
  const organization = { ungrouped: [], groups: [{ groupId: 'focus-original-group', name: 'Private browser group', collapsed: true, zoneIds: [zoneId] }] }
  useAppStore.setState({ mainSurface: 'agents', focusView: 'list', surveyCollectedZones: { [zoneId]: true }, surveyExplorationNames: { [zoneId]: 'Original saved source' }, surveyOrganization: organization })
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(createElement(GlobalFocusSurface, { workspaceOpen: false })))
    expect(container.querySelector('.focus-project-lanes__source')?.textContent).toContain('Survey')
    expect(container.querySelector('.focus-project-lanes__source')?.textContent).toContain('Original saved source')
    expect(originalRead.mock.calls.at(-1)![0].surveyOrganization).toBe(organization)
    expect(originalRead.mock.results.at(-1)!.value.items.map(item => item.zoneId)).toEqual([zoneId])
    const next = { ...organization, groups: [{ ...organization.groups[0]!, name: 'Renamed browser group', collapsed: false }] }
    await act(async () => { await useAppStore.getState().setSurveyOrganization(next, organization) })
    expect(originalRead.mock.calls.at(-1)![0].surveyOrganization).toEqual(next)
    expect(container.querySelector('.focus-project-lanes__source')?.textContent).toContain('Original saved source')
    expect(container.querySelector('.focus-project-lanes__source')?.textContent).not.toContain('Renamed browser group')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('[survey-list] actual CLI help and skill expose the exact read-write contract without contacting its business owner', async () => {
  const count = fixture.seen.length
  for (const args of [['space', 'survey-list', '--help'], ['space', '--help'], ['space', '--skill']]) {
    const output = await command(args)
    expect(output.stdout).toContain('space survey-list'); expect(output.stdout).toContain('organization')
    if (args.includes('survey-list') || args.includes('--skill')) expect(output.stdout).toContain('expected')
  }
  expect(fixture.seen).toHaveLength(count)
  const service = new AgentMuxRpcService({ coreClients: () => [] })
  try { await expect(service.call('space.survey-list', {})).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' }) } finally { await service.dispose() }
})

it('[survey-list] strict public requests and receipts preserve the original shape and reject malformed or duplicate identities', () => {
  const base = { schemaVersion: 5, requestId: 'strict-survey-list', operation: 'space.survey-list' }
  expect(parseSpaceControlRequest(base)).toEqual(base)
  for (const input of [{ expected: empty() }, { organization: empty() }, { organization: empty(), expected: empty(), focus: true },
    { organization: { ungrouped: [zones[0], zones[0]], groups: [] }, expected: empty() },
    { organization: { ungrouped: [], groups: [{ groupId: 'g', name: 'Group', collapsed: true, zoneIds: [zones[0]] }, { groupId: 'g', name: 'Duplicate', collapsed: false, zoneIds: [] }] }, expected: empty() },
    { organization: { ungrouped: [], groups: [{ groupId: 'g', name: 'Group', collapsed: 'yes', zoneIds: [] }] }, expected: empty() }]) expect(() => parseSpaceControlRequest({ ...base, ...input })).toThrow()
  const result = { scope: 'survey-list', storedOrganization: empty(), effectiveOrganization: grouped(), outcome: 'read', changed: false, save: null, issues: [] }
  expect(parseSpaceControlSuccessReceipt({ ...base, ok: true, result })).toMatchObject({ result })
  expect(() => parseSpaceControlSuccessReceipt({ ...base, ok: true, result: { ...result, scope: 'wrong-scope' } })).toThrow()
  expect(restoreSurveyOrganization({ ungrouped: ['saved-missing-zone', 'saved-missing-zone'], groups: [{ groupId: 'g', name: 'Saved', collapsed: true, zoneIds: [zones[0], 'saved-missing-zone'] }] })).toEqual({ ungrouped: ['saved-missing-zone'], groups: [{ groupId: 'g', name: 'Saved', collapsed: true, zoneIds: [zones[0]] }] })
  expect(surveyOrganizationZoneIds(effectiveSurveyOrganization(grouped(), useAppStore.getState().surveyCollectedZones))).toEqual([zones[1], 'saved-missing-zone', zones[0]])
})

it.runIf(Boolean(process.env.SURVEY_LIST_RESTART_PHASE))('[survey-list-restart] restores actual saved preference in a second process while retaining workfaces and Session identity', async () => {
  const path = process.env.SURVEY_LIST_RESTART_FILE!
  if (process.env.SURVEY_LIST_RESTART_PHASE === 'write') {
    await list(grouped()); await prepareRendererUpdate()
    const spatial = new AgentMuxSpatialStateStore(path + '.spatial.json')
    await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(useAppStore.getState(), []) })
    await writeFile(path, JSON.stringify({ pid: process.pid, record: localStorage.getItem('agentmux-workbench-v1'), protected: protectedFacts(), organization: grouped(), members: useAppStore.getState().surveyCollectedZones, selection: useAppStore.getState().surveyZoneSelection }))
  } else {
    const saved = JSON.parse(await readFile(path, 'utf8')); expect(saved.pid).not.toBe(process.pid)
    const clientRecord = JSON.parse(saved.record).state
    const restored = restorePersistedUiState(config, clientRecord)
    expect(restored.surveyOrganization).toEqual(saved.organization); expect(restored.surveyCollectedZones).toEqual(saved.members); expect(restored.surveyZoneSelection).toEqual(saved.selection)
    useAppStore.setState({ tabs: {}, layouts: {}, agentComposerDrafts: {} })
    const spatial = await new AgentMuxSpatialStateStore(path + '.spatial.json').readForLayout()
    expect(spatial).not.toBeNull()
    const workbench = restorePersistedWorkbench({ config, sessions: saved.protected.sessions, persisted: desktopWorkbenchFromSpatial(spatial!.graph), createTabGroupId: () => 'empty-restored-group' })
    useAppStore.setState({ ...restored, tabs: workbench.tabs, layouts: workbench.layouts, sessions: saved.protected.sessions, agentComposerDrafts: clientRecord.agentComposerDrafts })
    expect((await list()).storedOrganization).toEqual(saved.organization)
    expect(Object.keys(useAppStore.getState().tabs)).toEqual(Object.keys(saved.protected.tabs)); expect(useAppStore.getState().layouts).toEqual(saved.protected.layouts)
    for (const [id, original] of Object.entries(saved.protected.tabs) as [string, any][]) {
      expect(useAppStore.getState().tabs[id]!.regions).toEqual(original.regions)
      expect(useAppStore.getState().tabs[id]!.layout).toEqual(original.layout)
    }
    for (const session of saved.protected.sessions) expect(spatial!.graph.regions.some(region => region.agentSessionId === session.id && region.runId === session.control.run.runId)).toBe(true)
    expect(useAppStore.getState().sessions).toEqual(saved.protected.sessions); expect(useAppStore.getState().agentComposerDrafts).toEqual(saved.protected.drafts)
    fixture.noLifecycle()
  }
})
