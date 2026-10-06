import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { GRAPHITE_THEME, resolveTheme, themeValue } from '@agentmux/client-ui/theme'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { observeTerminalBrightness, terminalPaletteForAppearance, terminalPaletteChanged } from '../src/main/terminal-theme.js'
import { terminalTheme } from '../src/renderer/src/lib/terminal-theme.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
it('discovers and persists Workspace pairing through the real public settings service and compiled CLI, preserving explicit palettes', async () => {
  const f = await configOwnerFixture()
  const directory = await mkdtemp(join(tmpdir(), 'workspace-terminal-')); directories.push(directory)
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], execute: input => executeSettingsControl(input as Parameters<typeof executeSettingsControl>[0], f.owner) })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    const discovery = await rpc.call('settings.inspect', { target: 'appearance.terminalTheme' })
    expect(discovery).toMatchObject({ entries: [{ enum: ['graphite', 'catppuccin-mocha', 'workspace'], value: 'graphite' }] })
    const output = await runCompiledObjectCli(['settings', 'set', 'appearance.terminalTheme', 'workspace'], objectCliEnvironment(directory), '')
    expect(output.code, output.stderr).toBe(0)
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: true, result: { entry: { value: 'workspace' } } })
    expect((await f.disk()).appearance.terminalTheme).toBe('workspace')
    await rpc.call('settings.set', { key: 'appearance.terminalTheme', value: 'graphite' })
    await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, appAppearance: 'light' } }))
    expect((await f.disk()).appearance.terminalTheme).toBe('graphite')
    expect(terminalPaletteForAppearance(f.owner.current.appearance, false).background).toBe('#000000')
  } finally { rpc.dispose(); await server.stop() }
})
it('uses only the selected theme and host brightness for Main OSC colors, while renderer semantic ANSI follows its own Root', async () => {
  const f = await configOwnerFixture()
  const value = themeValue(structuredClone(GRAPHITE_THEME))
  value.variants.dark.colors.surface0 = '#102936'; value.variants.light.colors.surface0 = '#fff7e8'
  value.variants.light.colors.danger = '#a42f30'
  const customThemes = { 'custom.selected': value }
  Object.defineProperty(customThemes, 'custom.unrelated', { enumerable: true, get: () => { throw Error('Read unrelated theme') } })
  const appearance = { ...f.owner.current.appearance, themeId: 'custom.selected', appAppearance: 'system' as const, terminalTheme: 'workspace' as const, customThemes }
  expect(terminalPaletteForAppearance(appearance, true).background).toBe('#102936')
  const hostLight = terminalPaletteForAppearance(appearance, false)
  expect(hostLight.background).toBe('#fff7e8'); expect(hostLight.red).toBe('#a42f30')
  const rootLight = resolveTheme({ themeId: appearance.themeId, customThemes: { 'custom.selected': value }, appAppearance: 'light' })
  expect(terminalTheme('workspace', rootLight)).toEqual(hostLight)
  expect(hostLight.extendedAnsi).toHaveLength(240)
  expect(terminalPaletteChanged(appearance, { ...appearance, terminalFontSize: 16 })).toBe(false)
  expect(terminalPaletteChanged({ ...appearance, appAppearance: 'dark' }, appearance)).toBe(true)
})


it('catches up the current native brightness after asynchronous startup and releases only its observer', async () => {
  const f = await configOwnerFixture()
  const appearance = { ...f.owner.current.appearance, terminalTheme: 'workspace' as const, appAppearance: 'system' as const }
  const native = Object.assign(new EventEmitter(), { shouldUseDarkColors: true })
  let current = terminalPaletteForAppearance(appearance, native.shouldUseDarkColors)
  expect(current.background).toBe('#111419')
  // OS change occurs while Main's original startup is awaiting its control owner.
  await Promise.resolve()
  native.shouldUseDarkColors = false; native.emit('updated')
  const update = vi.fn(() => { current = terminalPaletteForAppearance(appearance, native.shouldUseDarkColors) })
  const release = observeTerminalBrightness(native, update)
  expect(current.background).toBe('#ffffff')
  native.shouldUseDarkColors = true; native.emit('updated')
  expect(current.background).toBe('#111419')
  release(); native.shouldUseDarkColors = false; native.emit('updated')
  expect(current.background).toBe('#111419'); expect(native.listenerCount('updated')).toBe(0)
})
