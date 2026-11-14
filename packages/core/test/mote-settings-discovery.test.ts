import { afterEach, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { createMotePreferencesPlacementFixture } from './helpers/mote-preferences-placement.js'
import { parseMotePreferencesReadInput, parseMotePreferencesReadResult, type MoteQuickPreferencesReadResult, type MoteQuickPreferencesSaveParams } from '../src/mote/preferences.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture() { const f = await createMotePreferencesPlacementFixture(); closes.push(f.close); return f }
async function fullRead(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.read()
  expect(result.choices).not.toBeNull()
  if (!result.choices?.executors || !result.choices.conversations || !result.choices.destinations) throw new Error('The default read must include all original discovery choices')
  return { ...result, choices: { ...result.choices, executors: result.choices.executors, conversations: result.choices.conversations, destinations: result.choices.destinations } }
}
function originalRole(actual: MoteQuickPreferencesReadResult, f: Awaited<ReturnType<typeof fixture>>) {
  expect(actual.defaults?.conversation).toEqual(f.defaults.conversation)
  expect(actual.defaults?.conversationRevision).toBe(f.defaults.conversationRevision)
  expect(actual.defaults?.conversationTransition).toEqual(f.marker)
}

it('catalog discovery failure retains original file defaults and independent Executor choices through the public SDK', async () => {
  const f = await fixture(), before = await fullRead(f)
  vi.spyOn(f.discovery, 'catalog').mockRejectedValue(new Error('Original display catalog unavailable'))
  const read = await fullRead(f)
  expect(read.status).toBe('ready'); expect(read.source).toEqual(before.source); expect(read.defaults).toEqual(before.defaults)
  expect(read.choices.executors.map(value => value.id)).toEqual(['original', 'next'])
  expect(read.choices.destinations).toEqual([]); expect(read.choices.issues).toEqual({ locations: 'Error: Original display catalog unavailable' })
  expect(read.issue).toBeNull(); expect(f.writes).toEqual([]); expect(f.transitions).toEqual([])
})

it('Executor discovery failure retains independently confirmed display choices through the public SDK', async () => {
  const f = await fixture(); await f.confirmDisplay(); const before = await fullRead(f)
  vi.spyOn(f.discovery, 'executors').mockRejectedValue(new Error('Original Executor inventory unavailable'))
  const read = await fullRead(f)
  expect(read.status).toBe('ready'); expect(read.defaults).toEqual(before.defaults)
  expect(read.choices.destinations).toEqual(before.choices.destinations); expect(read.choices.destinations.length).toBeGreaterThan(0)
  expect(read.choices.conversations).toEqual(before.choices.conversations)
  expect(read.choices.executors).toEqual([]); expect(read.choices.issues).toEqual({ executors: 'Error: Original Executor inventory unavailable' })
  expect(read.issue).toBeNull(); expect(f.writes).toEqual([])
})

it('both failed discovery sources cannot prevent an original presence and rollover save through the real CLI', async () => {
  const f = await fixture(), request: MoteQuickPreferencesSaveParams = await f.input('discovery-free-sdk-save')
  request.values = { ...request.values, conversationRollover: { kind: 'idle', idleMs: 300000 } }
  const catalog = vi.spyOn(f.discovery, 'catalog').mockRejectedValue(new Error('Catalog down'))
  const executors = vi.spyOn(f.discovery, 'executors').mockRejectedValue(new Error('Executors down'))
  const sdk = await f.rpc.call('space.mote.preferences.save', request)
  expect(sdk.status).toBe('saved')
  expect(catalog).not.toHaveBeenCalled(); expect(executors).not.toHaveBeenCalled()
  if (sdk.kind !== 'quick' || !sdk.source) throw new Error('The original Quick writer must retain its confirmed source')
  const cliRequest = { ...request, operationId: 'discovery-free-cli-save', baseline: sdk.source, values: { ...request.values, presence: { enabled: true, intervalMs: 7200000 } } }
  const cli = await f.cli(cliRequest)
  expect(cli.code, cli.stderr || cli.stdout).toBe(0); expect(cli.envelope.result.status).toBe('saved')
  expect(catalog).not.toHaveBeenCalled(); expect(executors).not.toHaveBeenCalled()
  const next = await fullRead(f); originalRole(next, f)
  expect(next.defaults?.presence?.intervalMs).toBe(7200000)
  expect(next.defaults?.conversationRollover).toEqual({ kind: 'idle', idleMs: 300000 })
  expect(next.choices.issues).toEqual({ locations: 'Error: Catalog down', executors: 'Error: Executors down' })
  expect(next.maintenance?.schedule).toEqual(f.paused); expect(next.maintenance?.status).toBe('paused')
  expect(await readFile(f.motePath, 'utf8')).toContain(f.notes)
  expect(f.transitions).toEqual([]); expect(f.writes).toEqual([]); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  await f.witness('discovery-cli-save', { request, sdk, cliRequest, cli, next, inputWrites: f.writes, transitions: f.transitions })
})

it('an original baseline save never calls or waits for unresolved unrelated discovery sources', async () => {
  const f = await fixture(), request = await f.input('discovery-free-pending-save')
  const catalog = vi.spyOn(f.discovery, 'catalog').mockImplementation(() => new Promise(() => {}))
  const executors = vi.spyOn(f.discovery, 'executors').mockImplementation(() => new Promise(() => {}))
  const saved = await f.rpc.call('space.mote.preferences.save', request)
  expect(saved.status).toBe('saved')
  if (saved.kind !== 'quick') throw new Error('The original Quick writer result is required')
  expect(saved.source?.defaults.presence?.intervalMs).toBe(3600000)
  expect(catalog).not.toHaveBeenCalled(); expect(executors).not.toHaveBeenCalled()
  expect(saved.source?.defaults.conversation).toEqual(f.defaults.conversation)
  expect(f.transitions).toEqual([]); expect(f.writes).toEqual([])
})

it('a changed Executor still requires its original source and the real CLI refuses without writing', async () => {
  const f = await fixture(), request = await f.input('required-executor-source'), before = await readFile(f.motePath, 'utf8')
  request.values = { ...request.values, executorId: 'next' }
  const catalog = vi.spyOn(f.discovery, 'catalog').mockRejectedValue(new Error('Unrelated catalog down'))
  const executors = vi.spyOn(f.discovery, 'executors').mockRejectedValue(new Error('Required Executor inventory down'))
  const sdk = await f.rpc.call('space.mote.preferences.save', request)
  expect(sdk.status).toBe('refused-before-write'); expect(sdk.message).toContain('Required Executor inventory down')
  expect(catalog).not.toHaveBeenCalled(); expect(executors).toHaveBeenCalledTimes(1)
  executors.mockClear()
  const cli = await f.cli({ ...request, operationId: 'required-executor-source-cli' })
  expect(cli.code, cli.stderr || cli.stdout).toBe(0)
  expect(cli.envelope, cli.stderr || cli.stdout).not.toBeNull()
  expect(cli.envelope.result.status).toBe('refused-before-write')
  expect(cli.envelope.result.message).toContain('Required Executor inventory down')
  expect(catalog).not.toHaveBeenCalled(); expect(executors).toHaveBeenCalledTimes(1)
  expect(await readFile(f.motePath, 'utf8')).toBe(before); expect(f.changed).toEqual([])
  expect(f.transitions).toEqual([]); expect(f.writes).toEqual([])
  await f.witness('discovery-cli-refused', { request, sdk, cli, originalBytesPreserved: true, inputWrites: f.writes })
})

it('a changed Main still requires exact original location discovery and preserves the existing role on failure', async () => {
  const f = await fixture(); await f.confirmDisplay(); const read = await fullRead(f), member = read.choices.conversations.find(value => value.reference.sessionId === 'member')!
  expect(member).toBeDefined()
  const request: MoteQuickPreferencesSaveParams = await f.input('required-main-source')
  request.values = { ...request.values, conversation: member.reference }
  const { displayWorkspaceId, groupId, tabId, regionId } = member.reference
  request.destination = { kind: 'occurrence', displayWorkspaceId, groupId, tabId, regionId }
  const before = await readFile(f.motePath, 'utf8')
  const catalog = vi.spyOn(f.discovery, 'catalog').mockRejectedValue(new Error('Required Main location source down'))
  const executors = vi.spyOn(f.discovery, 'executors').mockRejectedValue(new Error('Unrelated Executor source down'))
  const saved = await f.rpc.call('space.mote.preferences.save', request)
  expect(saved.status).toBe('refused-before-write'); expect(saved.message).toContain('Required Main location source down')
  expect(catalog).toHaveBeenCalledTimes(1); expect(executors).not.toHaveBeenCalled()
  expect(await readFile(f.motePath, 'utf8')).toBe(before); expect(f.transitions).toEqual([]); expect(f.writes).toEqual([])
})

it('an external file CAS conflict still refuses before writing even while optional sources are unavailable', async () => {
  const f = await fixture(), request = await f.input('original-file-conflict')
  const external = (await readFile(f.motePath, 'utf8')) + '\nAn external later note.\n'; await writeFile(f.motePath, external)
  const catalog = vi.spyOn(f.discovery, 'catalog').mockRejectedValue(new Error('Optional catalog down'))
  const executors = vi.spyOn(f.discovery, 'executors').mockRejectedValue(new Error('Optional Executors down'))
  const saved = await f.rpc.call('space.mote.preferences.save', request)
  expect(saved.status).toBe('refused-before-write'); expect(saved.message).toContain('MOTE.md changed')
  expect(await readFile(f.motePath, 'utf8')).toBe(external)
  expect(catalog).not.toHaveBeenCalled(); expect(executors).not.toHaveBeenCalled(); expect(f.changed).toEqual([])
})

it('a null catalog is scoped unknown rather than a falsely confirmed empty display list', async () => {
  const f = await fixture(), before = await fullRead(f); expect(before.choices.destinations).toEqual([]); expect(before.choices.issues).toBeUndefined()
  vi.spyOn(f.discovery, 'catalog').mockResolvedValue(null as never)
  const read = await fullRead(f)
  expect(read.status).toBe('ready'); expect(read.defaults).toEqual(before.defaults)
  expect(read.choices.issues?.locations).toEqual(expect.stringContaining('discovery is unavailable'))
  expect(read.choices.executors.map(value => value.id)).toEqual(['original', 'next'])
})

it('an unknown original resource refuses the read and never starts optional discovery', async () => {
  const f = await fixture(), catalog = vi.spyOn(f.discovery, 'catalog'), executors = vi.spyOn(f.discovery, 'executors')
  const result = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: { ...f.target, expectedResource: { ...f.target.expectedResource, workspacePath: f.root + '/another-resource' } } })
  expect(result.status).toBe('unconfirmed'); expect(result.issue).toBeTruthy()
  expect(catalog).not.toHaveBeenCalled(); expect(executors).not.toHaveBeenCalled(); expect(f.writes).toEqual([])
})

it('the public read codec rejects an unknown discovery issue key', async () => {
  const f = await fixture(), read = await fullRead(f)
  expect(() => parseMotePreferencesReadResult({ ...read, choices: { ...read.choices, issues: { foreign: 'No matching owner' } } }, { kind: 'quick', target: f.target })).toThrow()
})

it('the public read codec rejects empty or whitespace-only scoped failure reasons', async () => {
  const f = await fixture(), read = await fullRead(f)
  for (const value of ['', '  ']) for (const key of ['executors', 'locations']) {
    expect(() => parseMotePreferencesReadResult({ ...read, choices: { ...read.choices, issues: { [key]: value } } }, { kind: 'quick', target: f.target })).toThrow('failure reason')
  }
})


it('source-only public SDK and real CLI reads never call unresolved candidate sources', async () => {
  const f = await fixture(), original = await fullRead(f)
  const catalog = vi.spyOn(f.discovery, 'catalog').mockImplementation(() => new Promise(() => {}))
  const executors = vi.spyOn(f.discovery, 'executors').mockImplementation(() => new Promise(() => {}))
  const input = { kind: 'quick' as const, target: f.target, includeChoices: false }
  const read = await f.rpc.call('space.mote.preferences.read', input)
  expect(read.status).toBe('ready')
  if (read.kind !== 'quick') throw new Error('The original Quick read result is required')
  expect(read.choices).toBeNull(); expect(read.defaults).toEqual(original.defaults)
  expect(read.source).toEqual(original.source); expect(read.maintenance?.schedule).toEqual(f.paused)
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + join(f.root, 'preferences.sock'), 'space', 'mote', 'preferences', 'read', '--input', '-'],
    objectCliEnvironment(f.root, { AGENTMUX_RESUMED_INBOX_CLI_LOADED: process.env.MOTE_SETTINGS_CLI_LOADED }), JSON.stringify(input), 30000,
    new URL('./fixtures/a2a-resumed-inbox/source-loader.mjs', import.meta.url))
  expect(cli.code, cli.stderr || cli.stdout).toBe(0)
  const envelope = JSON.parse(cli.stdout); expect(envelope.result.status).toBe('ready'); expect(envelope.result.choices).toBeNull()
  expect(envelope.result.defaults).toEqual(original.defaults); expect(envelope.result.source).toEqual(original.source)
  expect(catalog).not.toHaveBeenCalled(); expect(executors).not.toHaveBeenCalled(); expect(f.writes).toEqual([])
  await f.witness('source-only-cli-read', { featureTask: 'T-003', input, cli: { ...cli, envelope }, read })
})

it('the public read codec rejects source and candidate projections inconsistent with the original request', async () => {
  const f = await fixture(), read = await fullRead(f), full = { kind: 'quick' as const, target: f.target }
  const source = { ...full, includeChoices: false }
  expect(() => parseMotePreferencesReadResult(read, source)).toThrow('projection')
  expect(() => parseMotePreferencesReadResult({ ...read, choices: null }, full)).toThrow('projection')
  expect(parseMotePreferencesReadResult({ ...read, choices: null }, source).choices).toBeNull()
})

it('Executor-only public reads finish independently while the original location source stays unresolved', async () => {
  const f = await fixture(), before = await fullRead(f)
  const catalog = vi.spyOn(f.discovery, 'catalog').mockImplementation(() => new Promise(() => {}))
  const executors = vi.spyOn(f.discovery, 'executors')
  const input = { kind: 'quick' as const, target: f.target, includeChoices: 'executors' as const }
  const read = await f.rpc.call('space.mote.preferences.read', input)
  if (read.kind !== 'quick') throw new Error('The original Quick read result is required')
  expect(read.status).toBe('ready'); expect(read.defaults).toEqual(before.defaults); expect(read.source).toEqual(before.source)
  expect(read.choices).toEqual({ executors: before.choices.executors, conversations: null, destinations: null })
  expect(catalog).not.toHaveBeenCalled(); expect(executors).toHaveBeenCalledTimes(1)
  await f.witness('single-source-executors', { featureTask: 'T-003', input, read })
})

it('location-only public reads finish independently while the original Executor source stays unresolved', async () => {
  const f = await fixture(); await f.confirmDisplay(); const before = await fullRead(f)
  const catalog = vi.spyOn(f.discovery, 'catalog')
  const executors = vi.spyOn(f.discovery, 'executors').mockImplementation(() => new Promise(() => {}))
  const input = { kind: 'quick' as const, target: f.target, includeChoices: 'locations' as const }
  const read = await f.rpc.call('space.mote.preferences.read', input)
  if (read.kind !== 'quick') throw new Error('The original Quick read result is required')
  expect(read.status).toBe('ready'); expect(read.defaults).toEqual(before.defaults); expect(read.source).toEqual(before.source)
  expect(read.choices).toEqual({ executors: null, conversations: before.choices.conversations, destinations: before.choices.destinations })
  expect(catalog).toHaveBeenCalledTimes(1); expect(executors).not.toHaveBeenCalled()
  await f.witness('single-source-locations', { featureTask: 'T-003', input, read })
})

it('the public read codec preserves exact single-source null projections and rejects unknown selectors', async () => {
  const f = await fixture(), read = await fullRead(f)
  const base = { kind: 'quick' as const, target: f.target }
  const executors = { ...base, includeChoices: 'executors' as const }, locations = { ...base, includeChoices: 'locations' as const }
  const executorResult = { ...read, choices: { executors: read.choices.executors, conversations: null, destinations: null } }
  const locationResult = { ...read, choices: { executors: null, conversations: read.choices.conversations, destinations: read.choices.destinations } }
  expect(parseMotePreferencesReadResult(executorResult, executors).choices).toEqual(executorResult.choices)
  expect(parseMotePreferencesReadResult(locationResult, locations).choices).toEqual(locationResult.choices)
  expect(() => parseMotePreferencesReadResult(read, executors)).toThrow()
  expect(() => parseMotePreferencesReadResult(read, locations)).toThrow()
  expect(() => parseMotePreferencesReadResult(executorResult, locations)).toThrow()
  expect(() => parseMotePreferencesReadInput({ ...base, includeChoices: 'unknown' })).toThrow()
  expect(() => parseMotePreferencesReadInput({ kind: 'connection', target: f.target, includeChoices: false })).toThrow()
})
