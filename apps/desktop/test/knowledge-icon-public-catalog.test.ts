import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { GRAPHITE_THEME, themeValue, getSemanticIconCatalog } from '@agentmux/client-ui/theme'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import type { AgentMuxControlRequest, AgentMuxControlSettingsResourceRequest } from '../../../packages/core/src/control.js'
import { executeSettingsResourcesControl } from '../src/main/settings-resources-control.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release() })
it('the actual Main ConfigOwner, strict RPC and compiled settings themes ls discover knowledge and independent graph reading roles without changing saved user assets', async () => {
  const original = themeValue({ ...structuredClone(GRAPHITE_THEME), id: 'custom.original-knowledge', name: 'Original user choices', icons: {
    'object.goal': { kind: 'glyph', glyph: 'target' }, 'navigation.survey': { kind: 'glyph', glyph: 'compass' }, 'object.note': { kind: 'glyph', glyph: 'book-open' }, 'object.survey': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] },
    'object.notebook': { kind: 'glyph', glyph: 'folder' }, 'file.text': { kind: 'paths', paths: [{ d: 'M3 5H21V19H3Z' }] },
    'action.show-full-note': { kind: 'glyph', glyph: 'book-open' }, 'action.show-related-blocks': { kind: 'paths', paths: [{ d: 'M4 7H20M4 17H16' }] }
  } })
  const f = await configOwnerFixture({ appearance: { terminalTheme: 'graphite', customThemes: { 'custom.original-knowledge': original } } }), bytes = await f.bytes(), shared = getSemanticIconCatalog()
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-icon-public-')); cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const seen: AgentMuxControlRequest[] = []
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], execute: request => { seen.push(request); return executeSettingsResourcesControl(request as AgentMuxControlSettingsResourceRequest, f.owner) } })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const publicResult = await rpc.call('settings.themes.ls', {})
  expect(publicResult.resource).toBe('themes'); if (publicResult.resource !== 'themes') throw Error('Expected original theme catalog')
  expect(publicResult.iconCatalog).toEqual(shared); expect(publicResult.iconCatalog.icons.length).toBeGreaterThan(0); expect(publicResult.iconCatalog.groups.length).toBeGreaterThan(0)
  const cli = await runCompiledObjectCli(['settings', 'themes', 'ls'], objectCliEnvironment(directory)); expect(cli.code, cli.stderr).toBe(0); expect(cli.stderr).toBe('')
  const carrier = JSON.parse(cli.stdout); expect(carrier).toMatchObject({ ok: true, operation: 'settings.themes.ls' }); const actual = carrier.result
  expect(actual.iconCatalog).toEqual(publicResult.iconCatalog)
  const meanings = { 'navigation.goals': 'goal-consensus', 'object.goal': 'goal-consensus', 'navigation.survey': 'survey-explore', 'object.survey': 'survey-explore', 'object.note': 'note-page',
    'object.notebook': 'notebook-text', 'file.text': 'file-text', 'action.show-full-note': 'note-page', 'action.show-related-blocks': 'note-related-blocks' }
  const rows = actual.iconCatalog.icons.filter((entry: { id: string }) => Object.hasOwn(meanings, entry.id)); expect(rows).toHaveLength(9)
  for (const [id, defaultGlyph] of Object.entries(meanings)) { const entry = rows.find((row: { id: string }) => row.id === id); expect(entry, id).toMatchObject({ id, defaultGlyph, label: expect.any(String), description: expect.any(String) }); expect(entry.label.trim().length).toBeGreaterThan(0); expect(entry.description.trim().length).toBeGreaterThan(0); expect(actual.iconCatalog.groups.some((group: { id: string }) => group.id === entry.groupId)).toBe(true) }
  for (const [id, label] of Object.entries({ 'action.show-full-note': 'Show the complete saved Note', 'action.show-related-blocks': 'Show related original blocks' })) {
    expect(rows.find((row: { id: string }) => row.id === id)).toMatchObject({ id, label, groupId: 'action', description: `${label}. Commands on controls, menus and work surfaces.` })
  }
  for (const glyph of ['goal-consensus', 'survey-explore', 'note-page', 'note-related-blocks', 'notebook-text', 'file-text', 'target', 'compass', 'book-open', 'folder']) expect(actual.iconCatalog.glyphs).toContain(glyph)
  expect(actual.items.find((item: { id: string }) => item.id === 'custom.original-knowledge')?.value).toEqual(original)
  expect(seen).toHaveLength(2); expect(seen.every(request => request.operation === 'settings.resource.list' && request.resource === 'themes')).toBe(true)
  expect(f.owner.current.appearance.customThemes?.['custom.original-knowledge']).toEqual(original); expect(await f.bytes()).toBe(bytes); expect(f.save).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled()
}, 30000)
