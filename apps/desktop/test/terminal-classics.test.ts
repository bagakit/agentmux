import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { themeObservation } from '../src/main/theme-observation.js'
import { terminalPaletteForAppearance } from '../src/main/terminal-theme.js'
import { TERMINAL_THEME_CATALOG, terminalTheme } from '../src/renderer/src/lib/terminal-theme.js'
import { ConfigStore } from '../src/main/config-store.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
// Independent primary-source transcription, not derived from the product catalog.
const references = [
  ['dracula', '#282a36', '#f8f8f2', '#44475a', '21222c ff5555 50fa7b f1fa8c bd93f9 ff79c6 8be9fd f8f8f2 6272a4 ff6e6e 69ff94 ffffa5 d6acff ff92df a4ffff ffffff'],
  ['nord', '#2e3440', '#d8dee9', '#4c566a', '3b4252 bf616a a3be8c ebcb8b 81a1c1 b48ead 88c0d0 e5e9f0 4c566a bf616a a3be8c ebcb8b 81a1c1 b48ead 8fbcbb eceff4'],
  ['gruvbox-dark', '#282828', '#ebdbb2', '#504945', '282828 cc241d 98971a d79921 458588 b16286 689d6a a89984 928374 fb4934 b8bb26 fabd2f 83a598 d3869b 8ec07c ebdbb2'],
  ['solarized-dark', '#002b36', '#839496', '#073642', '073642 dc322f 859900 b58900 268bd2 d33682 2aa198 eee8d5 002b36 cb4b16 586e75 657b83 839496 6c71c4 93a1a1 fdf6e3'],
  ['solarized-light', '#fdf6e3', '#657b83', '#eee8d5', 'eee8d5 dc322f 859900 b58900 268bd2 d33682 2aa198 073642 fdf6e3 cb4b16 93a1a1 839496 657b83 6c71c4 586e75 002b36']
] as const
const ansiRoles = ['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'] as const
it('discovers every classic, writes through compiled public CLI, reloads its original owner and delivers exact colors to native and mobile consumers', async () => {
  const f = await configOwnerFixture()
  const directory = await mkdtemp(join(tmpdir(), 'classic-terminal-')); directories.push(directory)
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], execute: input => executeSettingsControl(input as Parameters<typeof executeSettingsControl>[0], f.owner) })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const before = await f.store.get()
  try {
    const discovery = await rpc.call('settings.inspect', { target: 'appearance.terminalTheme' })
    for (const [id, background, foreground, selectionBackground, ansi] of references) {
      expect(discovery.entries[0]!.enum).toContain(id)
      expect(TERMINAL_THEME_CATALOG.find(item => item.id === id)?.label).toBeTruthy()
      const result = await runCompiledObjectCli(['settings', 'set', 'appearance.terminalTheme', id], objectCliEnvironment(directory), '')
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { entry: { value: id } } })
      const reloaded = await new ConfigStore(f.store.filePath).get()
      expect(reloaded.appearance.terminalTheme).toBe(id)
      expect(reloaded.appearance.appAppearance).toBe(before.appearance.appAppearance)
      expect(reloaded.workspaces).toEqual(before.workspaces)
      const native = terminalTheme(id)
      expect(native).toMatchObject({ background, foreground, selectionBackground, selectionForeground: foreground, cursorAccent: background })
      expect(ansiRoles.map(role => native[role])).toEqual(ansi.split(' ').map(value => '#' + value))
      expect(native.extendedAnsi).toHaveLength(240)
      for (const appAppearance of ['dark','light','system'] as const) {
        expect(terminalPaletteForAppearance({ ...reloaded.appearance, appAppearance }, false)).toEqual(native)
        expect(terminalPaletteForAppearance({ ...reloaded.appearance, appAppearance }, true)).toEqual(native)
      }
      const observation = await themeObservation(f.owner).subscribe(async () => {}, async () => {}, new AbortController().signal)
      expect(observation.initial.values.terminalTheme).toBe(id)
      expect(observation.initial.values.terminalPalette).toEqual(native)
      observation.dispose()
    }
    await rpc.call('settings.set', { key: 'appearance.terminalTheme', value: 'graphite' })
    expect(terminalPaletteForAppearance(f.owner.current.appearance, false).background).toBe('#000000')
  } finally { rpc.dispose(); await server.stop() }
})
