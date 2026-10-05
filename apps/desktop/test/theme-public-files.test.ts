import { afterEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { GRAPHITE_THEME, themeValue, serializeThemeFile, parseThemeFile } from '@agentmux/client-ui/theme'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../../../packages/core/src/control.js'
import type { AgentMuxControlSettingsResourceRequest as Request } from '@agentmux/core'
import { executeSettingsResourcesControl } from '../src/main/settings-resources-control.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { parseAgentMuxControlReceipt } from '../../../packages/core/src/control-codec.js'
import { writeCliResourceDocument } from '../../../packages/core/src/cli-resource-document.js'
import { exportThemeFile, writeThemeFile } from '../src/main/theme-file-export.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const f = await configOwnerFixture(), directory = await mkdtemp(join(tmpdir(), 'public-theme-files-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], execute: request => executeSettingsResourcesControl(request as Request, f.owner) })
  cleanup.push(() => server.stop()); await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const cli = (args: string[]) => runCompiledObjectCli(['settings', 'themes', ...args], objectCliEnvironment(directory))
  return { ...f, directory, rpc, cli }
}
function authored() {
  const document = structuredClone(GRAPHITE_THEME); document.id = 'custom.exchange'; document.name = 'Two-variant file'
  document.variants.dark.colors.surface0 = '#173c28'; document.variants.light.colors.surface0 = '#f3eadb'
  document.icons['action.copy'] = { kind: 'paths', paths: [{ d: 'M3 3 L21 3 L21 21 L3 21 Z' }] }
  return document
}

it('uploads an actual native GUI-exported file via compiled CLI and downloads the original owner document for the same GUI parser', async () => {
  const f = await fixture(), original = authored(), gui = join(f.directory, 'gui-theme.json'), output = join(f.directory, 'cli-theme.json')
  await exportThemeFile(original, { chooseFile: async () => gui, writeFile: writeThemeFile })
  const created = await f.cli(['create', original.id, '--input', gui]); expect(created.code, created.stdout).toBe(0)
  expect(f.owner.current.appearance.customThemes![original.id]).toEqual(themeValue(original))
  const inspected = await f.rpc.call('settings.themes.inspect', { id: original.id })
  expect(inspected.item.document).toEqual(original); expect(inspected.item.value).toEqual(themeValue(original))
  const downloaded = await f.cli(['inspect', original.id, '--output', output]); expect(downloaded.code, downloaded.stdout).toBe(0)
  const text = await readFile(output, 'utf8'); expect(text).toBe(serializeThemeFile(original)); expect(parseThemeFile(text)).toEqual(original)
  await f.rpc.call('settings.themes.delete', { id: original.id, input: { expected: themeValue(original) } })
  const reimported = await f.cli(['create', original.id, '--input', output]); expect(reimported.code, reimported.stdout).toBe(0)
  expect((await f.disk()).appearance.customThemes![original.id]).toEqual(themeValue(original))
  expect(f.owner.current.appearance.terminalTheme).toBe('graphite')
})
it('keeps exact document ID, complete-value repair and expected CAS with original document data', async () => {
  const f = await fixture(), original = authored()
  await f.rpc.call('settings.themes.create', { id: original.id, value: original as never })
  const wrong = await f.cli(['create', 'custom.other', '--input', await input(f.directory, original)])
  expect(wrong.code).not.toBe(0); expect(f.owner.current.appearance.customThemes!['custom.other']).toBeUndefined()
  await expect(executeSettingsResourcesControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'identity-oracle', operation: 'settings.resource.add', resource: 'themes', id: 'custom.other', value: original } as Request, f.owner)).rejects.toMatchObject({ code: 'SETTING_IDENTITY_IMMUTABLE' })
  const next = { ...original, name: 'Edited complete file' }
  await expect(f.rpc.call('settings.themes.update', { id: original.id, input: { changes: next as never, expected: original as never } })).resolves.toBeDefined()
  await expect(f.rpc.call('settings.themes.update', { id: original.id, input: { changes: { name: 'Stale' }, expected: original as never } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
  expect((await f.disk()).appearance.customThemes![original.id]).toEqual(themeValue(next))
})
it('rejects invalid or active file documents and preserves the directory', async () => {
  const f = await fixture(), before = await f.bytes()
  for (const document of [{ ...authored(), version: 99 }, { ...authored(), icons: { 'action.copy': { kind: 'paths', paths: [{ d: 'M3 3 L20 20', onload: 'script' }] } } }]) {
    const result = await f.cli(['create', 'custom.exchange', '--input', await input(f.directory, document)])
    expect(result.code).not.toBe(0); expect(await f.bytes()).toBe(before)
  }
})
it('never replaces an existing export file or symlink, and a failed output retains both existing data and saved theme', async () => {
  const f = await fixture(), original = authored()
  await f.rpc.call('settings.themes.create', { id: original.id, value: original as never })
  const target = join(f.directory, 'existing.json'); await writeFile(target, 'existing user data')
  const link = join(f.directory, 'link.json'); await symlink(target, link)
  for (const path of [target, link, join(f.directory, 'absent', 'file.json')]) {
    const result = await f.cli(['inspect', original.id, '--output', path]); expect(result.code).not.toBe(0)
    expect(await readFile(target, 'utf8')).toBe('existing user data'); expect((await f.disk()).appearance.customThemes![original.id]).toEqual(themeValue(original))
  }
})
async function input(directory: string, value: unknown) { const path = join(directory, 'input.json'); await writeFile(path, JSON.stringify(value)); return path }

it('rejects a generic owner document with another ID before creating any output', async () => {
  const f = await fixture(), destination = join(f.directory, 'wrong-owner.json')
  await expect(writeCliResourceDocument(destination, { item: { id: 'custom.exchange', document: { ...authored(), id: 'custom.other' } } })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects mismatched file identity at the generic receipt boundary before exposing a public document', () => {
  expect(parseAgentMuxControlReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'valid-document', ok: true, operation: 'settings.resource.get', result: { resource: 'themes', item: { id: 'custom.exchange', value: themeValue(authored()), document: authored() } } })).toMatchObject({ ok: true })
  expect(() => parseAgentMuxControlReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'document-receipt', ok: true, operation: 'settings.resource.get', result: { resource: 'themes', item: { id: 'custom.exchange', value: themeValue(authored()), document: { ...authored(), id: 'custom.other' } } } })).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
})
