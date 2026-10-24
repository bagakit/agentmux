import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { getSemanticIconCatalog, GRAPHITE_THEME, themeValue } from '@agentmux/client-ui/theme'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../../../packages/core/src/control.js'
import type { AgentMuxControlRequest, AgentMuxControlSettingsResourceRequest } from '../../../packages/core/src/control.js'
import { executeSettingsResourcesControl } from '../src/main/settings-resources-control.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('discovers the exact shared semantic catalog through the actual Main owner, public RPC and compiled CLI without changing configuration', async () => {
  const originalTheme = { ...themeValue(structuredClone(GRAPHITE_THEME)), icons: { 'object.mote': { kind: 'glyph' as const, glyph: 'mote-mark' as const }, 'avatar.badge-spark': { kind: 'paths' as const, paths: [{ d: 'M3 3H21V21H3Z' }] }, 'file.locked': { kind: 'glyph' as const, glyph: 'file-lock' as const }, 'object.agent': { kind: 'paths' as const, paths: [{ d: 'M4 4H20V20H4Z' }] } } }
  const f = await configOwnerFixture({ appearance: { terminalTheme: 'graphite', customThemes: { 'custom.retained-original': originalTheme } } }), bytes = await f.bytes(), catalog = getSemanticIconCatalog()
  expect(catalog.groups.length).toBeGreaterThan(0); expect(catalog.icons.length).toBeGreaterThan(0); expect(catalog.glyphs.length).toBeGreaterThan(0)
  const seen: AgentMuxControlRequest[] = []
  const directory = await mkdtemp(join(tmpdir(), 'settings-icon-catalog-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], execute: request => {
    seen.push(request)
    return executeSettingsResourcesControl(request as AgentMuxControlSettingsResourceRequest, f.owner)
  } })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const discovered = await rpc.call('settings.themes.ls', {})
  expect(discovered).toMatchObject({ resource: 'themes', iconCatalog: catalog, issues: [] })
  if (discovered.resource !== 'themes') throw new Error('Expected a theme catalog response.')
  expect(discovered.iconCatalog).toEqual(catalog)
  const expected = { 'object.mote': 'mote-companion', 'avatar.badge-spark': 'badge-token', 'action.fork-conversation': 'git-fork', 'object.relationships': 'topology-nodes', 'object.collaboration': 'message-history', 'action.move-to-draft': 'draft-return', 'navigation.space': 'layers', 'navigation.focus': 'focus', 'navigation.goals': 'goal-consensus', 'navigation.recall': 'book-open', 'object.agent-controlled-browser': 'browser-agent', 'conversation.history-window': 'clock-3', 'action.configure-reconnect': 'clock-3', 'action.upgrade-host': 'arrow-up', 'action.arrange-graph': 'graph-arrange', 'git.pull': 'download', 'git.push': 'upload', 'git.discard-changes': 'trash-2', 'action.collect-sources': 'notebook-text' }
  for (const [id, defaultGlyph] of Object.entries(expected)) expect(discovered.iconCatalog.icons.find(icon => icon.id === id), `public semantic discovery: ${id}`).toMatchObject({ id, defaultGlyph, label: expect.any(String), description: expect.any(String) })
  expect(discovered.iconCatalog.icons.find(icon => icon.id === 'object.agent-creation')).toMatchObject({ id: 'object.agent-creation', defaultGlyph: 'plus', label: 'Agent creation relation' })
  expect(discovered.iconCatalog.icons.find(icon => icon.id === 'conversation.tool-result')).toMatchObject({ id: 'conversation.tool-result', defaultGlyph: 'tool-return', label: 'Tool result' })
  expect(discovered.iconCatalog.glyphs).toEqual(expect.arrayContaining(['tool-return', 'mote-mark', 'mote-identity', 'mote-companion', 'badge-token']))
  const modules = { 'object.session-recovery': 'session-resume', 'object.capsule': 'capsule-page', 'object.user-input': 'user-input-field', 'object.agent-messaging': 'git-compare-arrows', 'object.amux-protocols': 'protocol-frame' }
  const moduleRows = discovered.iconCatalog.icons.filter(icon => Object.hasOwn(modules, icon.id))
  expect(moduleRows).toHaveLength(5)
  for (const [id, defaultGlyph] of Object.entries(modules)) expect(moduleRows.find(icon => icon.id === id), id).toMatchObject({ id, groupId: 'object', defaultGlyph, label: expect.any(String), description: expect.any(String) })
  expect(discovered.iconCatalog.glyphs).toEqual(expect.arrayContaining(['capsule-page', 'user-input-field', 'protocol-frame', 'session-resume', 'git-compare-arrows']))

  const cli = await runCompiledObjectCli(['settings', 'themes', 'ls'], objectCliEnvironment(directory))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, operation: 'settings.themes.ls', result: { iconCatalog: catalog } })
  expect(JSON.parse(cli.stdout).result.iconCatalog).toEqual(discovered.iconCatalog)
  expect(seen).toHaveLength(2)
  expect(seen.every(request => request.operation === 'settings.resource.list' && request.resource === 'themes')).toBe(true)
  expect(f.owner.current.appearance.customThemes?.['custom.retained-original']).toEqual(originalTheme)
  expect(await f.bytes()).toBe(bytes); expect(f.save).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled()
}, 30_000)

it('uses a discovered meaning and drawing in the original theme CRUD and returns the saved override, preserving other meanings', async () => {
  const f = await configOwnerFixture()
  const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'discovered-icon-edit' }
  const listing = await executeSettingsResourcesControl({ ...envelope, operation: 'settings.resource.list', resource: 'themes' }, f.owner)
  if (listing.operation !== 'settings.resource.list' || listing.resource !== 'themes') throw new Error('Expected actual theme discovery.')
  const meaning = listing.iconCatalog.icons.find(icon => listing.iconCatalog.icons.some(other => other.id !== icon.id && other.defaultGlyph === icon.defaultGlyph))!
  const sibling = listing.iconCatalog.icons.find(icon => icon.id !== meaning.id && icon.defaultGlyph === meaning.defaultGlyph)!
  const glyph = listing.iconCatalog.glyphs.find(id => id !== meaning.defaultGlyph)!
  expect(meaning).toBeDefined(); expect(sibling).toBeDefined(); expect(glyph).toBeDefined()
  const value = { ...themeValue(structuredClone(GRAPHITE_THEME)), icons: { [meaning.id]: { kind: 'glyph', glyph } } }
  await executeSettingsResourcesControl({ ...envelope, operation: 'settings.resource.add', resource: 'themes', id: 'custom.discovered-icons', value }, f.owner)
  const saved = f.owner.current.appearance.customThemes!['custom.discovered-icons'] as typeof value
  expect(saved.icons[meaning.id]).toEqual({ kind: 'glyph', glyph })
  expect(saved.icons[sibling.id]).toBeUndefined()
  expect((await f.disk()).appearance.customThemes!['custom.discovered-icons']).toEqual(value)
  expect(getSemanticIconCatalog()).toEqual(listing.iconCatalog)
})

it('generates actual CLI help and skill discovery with the theme icon catalog contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'settings-icon-help-')); cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const env = objectCliEnvironment(directory)
  const help = await runCompiledObjectCli(['settings', 'themes', 'ls', '--help'], env)
  expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain('semantic icon catalog')
  const skill = await runCompiledObjectCli(['settings', '--skill'], env)
  expect(skill.code, skill.stderr).toBe(0); expect(skill.stdout).toContain('Read amux settings --help')
  const resources = await runCompiledObjectCli(['settings', '--help'], env)
  expect(resources.code, resources.stderr).toBe(0); expect(resources.stdout).toContain('iconCatalog: groups with labels/descriptions')
})
