import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { GRAPHITE_THEME, BUILTIN_THEMES, themeValue, getThemeCatalog, semanticIconIdSchema, THEME_FILE_MAX_BYTES, themeValueSchema } from '@agentmux/client-ui/theme'
import { AgentMuxControlServer, AGENTMUX_CONTROL_SCHEMA_VERSION, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import type { AgentMuxControlSettingsResourceRequest as Request, AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core'
import { executeSettingsResourcesControl } from '../src/main/settings-resources-control.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { ConfigStore } from '../src/main/config-store.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'theme-resource' }
type Input<T> = T extends unknown ? Omit<T, 'schemaVersion' | 'requestId'> : never
const request = (input: Input<Request>): Request => ({ ...envelope, ...input }) as Request
const original = () => ({ ...themeValue(structuredClone(GRAPHITE_THEME)), name: 'Authored theme',
  icons: { 'action.copy': { kind: 'paths' as const, paths: [{ d: 'M 4 4 L 20 4 L 20 20 Z' }] } } })
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function loadedBadRecords() {
  const f = await configOwnerFixture()
  const config = await f.disk()
  config.appearance = { ...config.appearance, appAppearance: 'light', terminalTheme: 'catppuccin-mocha',
    themeId: 'custom.good', customThemes: { 'custom.good': original(), 'custom.bad': { version: 999 }, 'custom.scalar': null, graphite: { version: 999 }, '': { version: 999 } } }
  await writeFile(f.store.filePath, JSON.stringify(config))
  let current = await new ConfigStore(f.store.filePath).get()
  const publish = vi.fn(saved => { current = saved })
  const owner = new ConfigOwner({ read: () => current, save: next => f.store.save(next), publish })
  return { ...f, owner, publish }
}

describe('theme resources share the durable Main owner and theme schema', () => {
  it('discovers immutable built-ins and dynamic selectable custom IDs, then persists the full value', async () => {
    const f = await configOwnerFixture(), value = original()
    const builtins = await executeSettingsResourcesControl(request({ operation: 'settings.resource.list', resource: 'themes' }), f.owner)
    expect(builtins).toMatchObject({ operation: 'settings.resource.list', items: expect.arrayContaining([expect.objectContaining({ id: 'graphite', readonly: true })]), issues: [] })
    await executeSettingsResourcesControl(request({ operation: 'settings.resource.add', resource: 'themes', id: 'custom.proof', value }), f.owner)
    const found = await executeSettingsResourcesControl(request({ operation: 'settings.resource.get', resource: 'themes', id: 'custom.proof' }), f.owner)
    expect(found).toMatchObject({ item: { id: 'custom.proof', value, readonly: false } })
    const entry = await executeSettingsControl({ ...envelope, operation: 'settings.get', target: 'appearance.themeId' }, f.owner)
    expect(entry).toMatchObject({ entries: [{ value: 'graphite', default: 'graphite', enum: expect.arrayContaining(['graphite', 'custom.proof']) }] })
    await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'appearance.themeId', value: 'custom.proof' }, f.owner)
    const reread = await new ConfigStore(f.store.filePath).get()
    expect(reread.appearance.themeId).toBe('custom.proof')
    expect(reread.appearance.customThemes!['custom.proof']).toEqual(value)
    await expect(executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'appearance.themeId', value: 'custom.missing' }, f.owner)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  })

  it('rejects built-in writes, duplicates, identity fields, bad assets and missing expectations without preparing or publishing', async () => {
    const f = await configOwnerFixture(), value = original()
    for (const input of [
      { operation: 'settings.resource.add', resource: 'themes', id: 'graphite', value },
      { operation: 'settings.resource.update', resource: 'themes', id: 'graphite', changes: { name: 'Override' }, expected: themeValue(GRAPHITE_THEME) },
      { operation: 'settings.resource.remove', resource: 'themes', id: 'graphite', expected: themeValue(GRAPHITE_THEME) }
    ] as Input<Request>[]) await expect(executeSettingsResourcesControl(request(input), f.owner)).rejects.toMatchObject({ code: 'SETTING_IDENTITY_IMMUTABLE' })
    await executeSettingsResourcesControl(request({ operation: 'settings.resource.add', resource: 'themes', id: 'custom.proof', value }), f.owner)
    const bytes = await f.bytes(), preparations = (f.runtime.prepare as ReturnType<typeof vi.fn>).mock.calls.length
    for (const input of [
      { operation: 'settings.resource.add', resource: 'themes', id: 'custom.proof', value },
      { operation: 'settings.resource.update', resource: 'themes', id: 'custom.proof', changes: { name: 'Changed' } },
      { operation: 'settings.resource.remove', resource: 'themes', id: 'custom.proof' },
      { operation: 'settings.resource.update', resource: 'themes', id: 'custom.proof', changes: { id: 'custom.other' }, expected: value },
      { operation: 'settings.resource.add', resource: 'themes', id: 'custom.active-svg', value: { ...value, icons: { 'action.copy': { kind: 'paths', paths: [{ d: 'M 0 0', onclick: 'script' }] } } } }
    ] as Input<Request>[]) await expect(executeSettingsResourcesControl(request(input), f.owner)).rejects.toBeInstanceOf(Error)
    expect(await f.bytes()).toBe(bytes)
    expect((f.runtime.prepare as ReturnType<typeof vi.fn>).mock.calls.length).toBe(preparations)
  })

  it('requires the complete original theme, preserves stale drafts and performs active deletion atomically', async () => {
    const f = await configOwnerFixture(), value = original()
    await executeSettingsResourcesControl(request({ operation: 'settings.resource.add', resource: 'themes', id: 'custom.proof', value }), f.owner)
    await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, themeId: 'custom.proof', appAppearance: 'light', terminalTheme: 'catppuccin-mocha' } }))
    await executeSettingsResourcesControl(request({ operation: 'settings.resource.update', resource: 'themes', id: 'custom.proof', changes: { name: 'Updated' }, expected: value }), f.owner)
    const updated = { ...value, name: 'Updated' }, bytes = await f.bytes()
    await expect(executeSettingsResourcesControl(request({ operation: 'settings.resource.update', resource: 'themes', id: 'custom.proof', changes: { description: 'Stale' }, expected: value }), f.owner)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    await expect(executeSettingsResourcesControl(request({ operation: 'settings.resource.remove', resource: 'themes', id: 'custom.proof', expected: value }), f.owner)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(await f.bytes()).toBe(bytes)
    f.publish.mockClear()
    await executeSettingsResourcesControl(request({ operation: 'settings.resource.remove', resource: 'themes', id: 'custom.proof', expected: updated }), f.owner)
    expect(f.publish).toHaveBeenCalledTimes(1)
    expect(f.owner.current.appearance).toMatchObject({ themeId: 'graphite', appAppearance: 'light', terminalTheme: 'catppuccin-mocha', customThemes: {} })
    expect((await new ConfigStore(f.store.filePath).get()).appearance).toEqual(f.owner.current.appearance)
  })

  it('retains bad raw records across reload and unrelated edits, exposes diagnostics and permits exact raw deletion', async () => {
    const f = await loadedBadRecords()
    expect(f.owner.current.appearance.customThemes!['custom.bad']).toEqual({ version: 999 })
    expect(f.owner.current.appearance.customThemes!['custom.scalar']).toBeNull()
    const listing = await executeSettingsResourcesControl(request({ operation: 'settings.resource.list', resource: 'themes' }), f.owner)
    expect(listing).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 'graphite' }), expect.objectContaining({ id: 'custom.good' })]), issues: [{ id: 'custom.bad' }, { id: 'custom.scalar' }, { id: 'graphite' }, { id: '' }] })
    await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'appearance.editorFontSize', value: '16' }, f.owner)
    expect((await f.disk()).appearance.customThemes).toEqual(f.owner.current.appearance.customThemes)
    await expect(executeSettingsResourcesControl(request({ operation: 'settings.resource.get', resource: 'themes', id: 'custom.bad' }), f.owner)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE', message: expect.stringContaining('retained') })
    await expect(executeSettingsResourcesControl(request({ operation: 'settings.resource.remove', resource: 'themes', id: 'custom.scalar', expected: {} }), f.owner)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    await executeSettingsResourcesControl(request({ operation: 'settings.resource.remove', resource: 'themes', id: 'custom.scalar', expected: null }), f.owner)
    await executeSettingsResourcesControl(request({ operation: 'settings.resource.remove', resource: 'themes', id: 'custom.bad', expected: { version: 999 } }), f.owner)
    await executeSettingsResourcesControl(request({ operation: 'settings.resource.remove', resource: 'themes', id: 'graphite', expected: { version: 999 } }), f.owner)
    expect(getThemeCatalog(f.owner.current.appearance.customThemes).items[0]!.id).toBe('graphite')
    await executeSettingsResourcesControl(request({ operation: 'settings.resource.remove', resource: 'themes', id: '', expected: { version: 999 } }), f.owner)
    expect(f.owner.current.appearance.themeId).toBe('custom.good')
    expect(Object.keys(f.owner.current.appearance.customThemes!)).toEqual(['custom.good'])
  })

  it('preserves unsupported literal record keys instead of silently omitting authored bytes', async () => {
    const f = await configOwnerFixture(), config = await f.disk()
    config.appearance.customThemes = JSON.parse('{"__proto__":null,"":{"version":999}}')
    await writeFile(f.store.filePath, JSON.stringify(config))
    const loaded = await new ConfigStore(f.store.filePath).get()
    expect(Object.hasOwn(loaded.appearance.customThemes!, '__proto__')).toBe(true)
    expect(loaded.appearance.customThemes).toEqual(config.appearance.customThemes)
    expect(getThemeCatalog(loaded.appearance.customThemes).issues.map(issue => issue.id)).toEqual(['__proto__', ''])
  })

  it('guards GUI ConfigOwner and direct ConfigStore writes while allowing unchanged unsupported data', async () => {
    const f = await loadedBadRecords(), before = structuredClone(f.owner.current), bytes = await f.bytes()
    const bad = { ...before, appearance: { ...before.appearance, customThemes: { ...before.appearance.customThemes, 'custom.new': { version: 999 } } } }
    await expect(f.owner.edit(before, bad)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
    await expect(f.store.save(bad)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
    expect(await f.bytes()).toBe(bytes)
    expect(f.publish).not.toHaveBeenCalled()
    await f.owner.edit(before, { ...before, appearance: { ...before.appearance, terminalFontSize: 15 } })
    expect(f.owner.current.appearance.customThemes).toEqual(before.appearance.customThemes)
  })

  it('rejects an invalid authored theme before any Runtime preparation', async () => {
    const f = await configOwnerFixture(), before = structuredClone(f.owner.current)
    await expect(f.owner.edit(before, { ...before, appearance: { ...before.appearance, customThemes: { 'custom.bad': null } } })).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
    expect(f.runtime.prepare).not.toHaveBeenCalled()
    expect(f.publish).not.toHaveBeenCalled()
  })

  it('rejects stale GUI edits to one whole literal theme identity while merging another theme', async () => {
    const f = await configOwnerFixture(), value = original(), first = 'custom.foo.with.dots', other = 'custom.bar'
    for (const id of [first, other]) await executeSettingsResourcesControl(request({ operation: 'settings.resource.add', resource: 'themes', id, value }), f.owner)
    const before = structuredClone(f.owner.current)
    await executeSettingsResourcesControl(request({ operation: 'settings.resource.update', resource: 'themes', id: first,
      changes: { name: 'External name' }, expected: value }), f.owner)
    const bytes = await f.bytes(), publications = f.publish.mock.calls.length
    const stale = { ...before, appearance: { ...before.appearance, customThemes: { ...before.appearance.customThemes,
      [first]: { ...value, description: 'Local description', variants: { ...value.variants,
        dark: { ...value.variants.dark, colors: { ...value.variants.dark.colors, surface0: '#192021' } } }, icons: {} } } } }
    await expect(f.owner.edit(before, stale)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT', field: `appearance.customThemes[${JSON.stringify(first)}]` })
    expect(await f.bytes()).toBe(bytes)
    expect(f.publish.mock.calls.length).toBe(publications)
    await f.owner.edit(before, { ...before, appearance: { ...before.appearance, customThemes: { ...before.appearance.customThemes,
      [other]: { ...value, description: 'Independent theme edit' } } } })
    expect((await f.disk()).appearance.customThemes![first]).toEqual({ ...value, name: 'External name' })
    expect((await f.disk()).appearance.customThemes![other]).toEqual({ ...value, description: 'Independent theme edit' })
    expect(Object.keys(f.owner.current.appearance.customThemes!)).toEqual([first, other])
  })

  it('rejects a theme whose compact JSON fits but actual exported file exceeds its import boundary', async () => {
    const f = await configOwnerFixture(), id = 'custom.file-boundary'
    let value = original()
    for (let padding = 0; padding <= 2000; padding += 5) {
      value = { ...original(), icons: Object.fromEntries(semanticIconIdSchema.options.map(name => [name,
        { kind: 'paths', paths: Array.from({ length: 32 }, () => ({ d: `M0 0 L24 24${' '.repeat(padding)}` })) }])) } as ReturnType<typeof original>
      if (Buffer.byteLength(JSON.stringify({ id, ...value }, null, 2) + '\n') > THEME_FILE_MAX_BYTES) break
    }
    expect(themeValueSchema.safeParse(value).success).toBe(true)
    expect(Buffer.byteLength(JSON.stringify({ id, ...value }))).toBeLessThan(THEME_FILE_MAX_BYTES)
    expect(Buffer.byteLength(JSON.stringify({ id, ...value }, null, 2) + '\n')).toBeGreaterThan(THEME_FILE_MAX_BYTES)
    const bytes = await f.bytes()
    await expect(executeSettingsResourcesControl(request({ operation: 'settings.resource.add', resource: 'themes', id, value }), f.owner)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE', message: expect.stringContaining('2 MiB') })
    expect(await f.bytes()).toBe(bytes)
    expect(f.runtime.prepare).not.toHaveBeenCalled()
    expect(f.publish).not.toHaveBeenCalled()
  })

  it('leaves the record and selected theme unchanged when durable saving fails', async () => {
    const f = await configOwnerFixture(), value = original()
    await executeSettingsResourcesControl(request({ operation: 'settings.resource.add', resource: 'themes', id: 'custom.proof', value }), f.owner)
    await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'appearance.themeId', value: 'custom.proof' }, f.owner)
    const bytes = await f.bytes()
    f.save.mockRejectedValueOnce(new Error('private disk failure'))
    await expect(executeSettingsResourcesControl(request({ operation: 'settings.resource.remove', resource: 'themes', id: 'custom.proof', expected: value }), f.owner)).rejects.toThrow('private disk failure')
    expect(await f.bytes()).toBe(bytes)
    expect(f.owner.current.appearance.themeId).toBe('custom.proof')
    expect(f.owner.current.appearance.customThemes!['custom.proof']).toEqual(value)
  })
})

describe('actual public RPC and compiled amux consume the same Main theme owner', () => {
  it('publishes retained-record diagnostics and deletes raw null through the actual compiled CLI', async () => {
    const f = await loadedBadRecords(), directory = await mkdtemp(join(tmpdir(), 'theme-raw-cli-'))
    directories.push(directory)
    const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [],
      execute: input => executeSettingsResourcesControl(input as Request, f.owner) })
    await server.start()
    try {
      const env = objectCliEnvironment(directory)
      const listing = await runCompiledObjectCli(['settings', 'themes', 'ls'], env)
      expect(listing.code, listing.stderr).toBe(0)
      expect(JSON.parse(listing.stdout).result).toMatchObject({ issues: [{ id: 'custom.bad' }, { id: 'custom.scalar' }, { id: 'graphite' }, { id: '' }] })
      const removal = await runCompiledObjectCli(['settings', 'themes', 'delete', 'custom.scalar', '--input', '-'], env, JSON.stringify({ expected: null }))
      expect(removal.code, removal.stderr).toBe(0)
      expect(Object.hasOwn((await f.disk()).appearance.customThemes!, 'custom.scalar')).toBe(false)
      const emptyRemoval = await runCompiledObjectCli(['settings', 'themes', 'delete', '', '--input', '-'], env, JSON.stringify({ expected: { version: 999 } }))
      expect(emptyRemoval.code, emptyRemoval.stderr).toBe(0)
      expect(Object.hasOwn((await f.disk()).appearance.customThemes!, '')).toBe(false)
      expect(f.owner.current.appearance.themeId).toBe('custom.good')
    } finally { await server.stop() }
  }, 30_000)

  it('discovers, creates, reads, selects, updates and deletes through the production public service and CLI', async () => {
    const f = await configOwnerFixture(), value = original(), directory = await mkdtemp(join(tmpdir(), 'theme-cli-'))
    directories.push(directory)
    const seen: AgentMuxControlRequest[] = []
    const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [],
      execute: async (input): Promise<AgentMuxControlResult> => {
        seen.push(input)
        if (input.operation === 'settings.get' || input.operation === 'settings.set') return executeSettingsControl(input, f.owner)
        if (input.operation.startsWith('settings.resource.')) return executeSettingsResourcesControl(input as Request, f.owner)
        throw new Error(`Unexpected ${input.operation}`)
      } })
    await server.start()
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    const env = objectCliEnvironment(directory)
    const cli = async (args: string[], input?: unknown) => {
      const output = await runCompiledObjectCli(args, env, input === undefined ? '' : JSON.stringify(input))
      expect(output.code, output.stderr || output.stdout).toBe(0)
      const receipt = JSON.parse(output.stdout)
      expect(receipt.ok).toBe(true)
      return receipt.result
    }
    try {
      const discovered = await rpc.call('settings.themes.ls', {})
      expect(discovered).toMatchObject({ resource: 'themes', items: expect.arrayContaining([expect.objectContaining({ id: 'graphite', readonly: true })]), issues: [] })
      expect(await cli(['settings', 'themes', 'create', 'custom.cli', '--input', '-'], value)).toMatchObject({ item: { id: 'custom.cli', readonly: false, value } })
      expect(await rpc.call('settings.themes.inspect', { id: 'custom.cli' })).toMatchObject({ item: { value } })
      expect(await cli(['settings', 'inspect', 'appearance.themeId'])).toMatchObject({ entries: [{ enum: expect.arrayContaining(['graphite', 'custom.cli']) }] })
      expect(await cli(['settings', 'set', 'appearance.themeId', 'custom.cli'])).toMatchObject({ entry: { value: 'custom.cli' } })
      const updated = { ...value, name: 'CLI update' }
      expect(await cli(['settings', 'themes', 'update', 'custom.cli', '--input', '-'], { changes: { name: updated.name }, expected: value })).toMatchObject({ item: { value: updated } })
      expect((await new ConfigStore(f.store.filePath).get()).appearance.customThemes!['custom.cli']).toEqual(updated)
      const failed = await runCompiledObjectCli(['settings', 'themes', 'update', 'custom.cli', '--input', '-'], env, JSON.stringify({ changes: { name: 'Stale' }, expected: value }))
      expect(failed.code).not.toBe(0)
      expect(JSON.parse(failed.stderr).error.code).toBe('CONFIG_CONFLICT')
      expect(await cli(['settings', 'themes', 'delete', 'custom.cli', '--input', '-'], { expected: updated })).toMatchObject({ removed: true })
      expect(f.owner.current.appearance.themeId).toBe('graphite')
      expect(seen.filter(input => input.operation.startsWith('settings.resource.')).length).toBeGreaterThan(5)
      expect(getThemeCatalog((await f.disk()).appearance.customThemes).items.map(item => item.id)).toEqual(BUILTIN_THEMES.map(theme => theme.id))
    } finally { await rpc.dispose(); await server.stop() }
  }, 30_000)
})
