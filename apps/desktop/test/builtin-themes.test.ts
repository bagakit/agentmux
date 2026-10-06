import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgentMuxControlServer, AGENTMUX_CONTROL_SCHEMA_VERSION } from '../../../packages/core/src/control-host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { getThemeCatalog, mountThemeRuntime, updateThemeSelection, readResolvedTheme, parseThemeFile, serializeThemeFile, themeDocumentSchema } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '../../../packages/client-ui/src/theme/icon-sprite.js'
import { executeSettingsResourcesControl } from '../src/main/settings-resources-control.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
it.each(['fallout4'])('selects readonly %s through the compiled public CLI, reloads it and applies both variants and original semantic drawings to the shared root', async id => {
  const f = await configOwnerFixture(), directory = await mkdtemp(join(tmpdir(), 'builtin-theme-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], execute: request =>
    request.operation.startsWith('settings.resource.') ? executeSettingsResourcesControl(request as never, f.owner) : executeSettingsControl(request as never, f.owner) })
  cleanup.push(() => server.stop()); await server.start()
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const result = await runCompiledObjectCli(['settings', 'set', 'appearance.themeId', id], objectCliEnvironment(directory))
  expect(result.code, result.stderr).toBe(0); expect((await f.disk()).appearance.themeId).toBe(id)
  const selected = getThemeCatalog().items.find(item => item.id === id)!
  expect(selected).toBeDefined(); expect(selected.readonly).toBe(true)
  const doc = { id, ...selected.value }; expect(themeDocumentSchema.safeParse(doc).success).toBe(true)
  expect(parseThemeFile(serializeThemeFile(doc))).toEqual(doc)
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ media: query, matches: false, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }))
  cleanup.push(mountThemeRuntime())
  for (const mode of ['dark', 'light'] as const) {
    updateThemeSelection({ ...(await f.disk()).appearance, appAppearance: mode })
    expect(readResolvedTheme().id).toBe(id); expect(document.documentElement.dataset.appearance).toBe(mode)
    expect(document.documentElement.style.getPropertyValue('--surface-0')).toBe(doc.variants[mode].colors.surface0)
    expect(document.documentElement.style.getPropertyValue('--font-sans')).not.toBe('')
    const symbol = document.getElementById(semanticIconHref('action.search').slice(1))!
    expect(symbol.querySelector('path')?.getAttribute('d')).toBe((doc.icons['action.search'] as { paths: { d: string }[] }).paths[0].d)
    const running = document.getElementById(semanticIconHref('status.running').slice(1))!.innerHTML
    expect(document.getElementById(semanticIconHref('status.working').slice(1))!.innerHTML).not.toBe(running)
  }
  const before = await f.bytes()
  await expect(executeSettingsResourcesControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'builtin-edit', operation: 'settings.resource.update', resource: 'themes', id, changes: { name: 'Changed' }, expected: selected.value }, f.owner)).rejects.toMatchObject({ code: 'SETTING_IDENTITY_IMMUTABLE' })
  expect(await f.bytes()).toBe(before); expect(f.owner.current.appearance.terminalTheme).toBe('graphite')
})
