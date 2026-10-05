import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { GRAPHITE_THEME, themeValue } from '@agentmux/client-ui/theme'
import type { AgentMuxAppearanceObservation } from '@agentmux/core'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { themeObservation } from '../src/main/theme-observation.js'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const custom = () => ({ ...themeValue(structuredClone(GRAPHITE_THEME)), name: 'Original observed theme' })
async function installedTheme(f: Awaited<ReturnType<typeof configOwnerFixture>>) {
  await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, themeId: 'custom.original', customThemes: { 'custom.original': custom() } } }))
}
async function recolor(f: Awaited<ReturnType<typeof configOwnerFixture>>, color: string) {
  await f.owner.update(config => {
    const original = config.appearance.customThemes!['custom.original'] as ReturnType<typeof custom>
    return { ...config, appearance: { ...config.appearance, customThemes: { ...config.appearance.customThemes,
      'custom.original': { ...original, variants: { ...original.variants, dark: { ...original.variants.dark,
        colors: { ...original.variants.dark.colors, surface0: color } } } } } } }
  })
}
async function endpoint(f: Awaited<ReturnType<typeof configOwnerFixture>>) {
  const directory = await mkdtemp(join(tmpdir(), 'theme-watch-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], appearance: themeObservation(f.owner),
    execute: async () => { throw new Error('No control writes are needed for this observation.') } })
  cleanup.push(() => server.stop()); await server.start()
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanup.push(() => client.dispose())
  return { server, client, directory }
}
const until = async (ready: () => boolean) => { for (let i = 0; i < 100 && !ready(); i++) await new Promise(resolve => setTimeout(resolve, 5)); expect(ready()).toBe(true) }

describe('appearance stream borrows the committed Main config owner', () => {
  it('captures and subscribes in one owner queue, then emits only the latest pre-start snapshot', async () => {
    const f = await configOwnerFixture(), snapshots: AgentMuxAppearanceObservation[] = [], signal = new AbortController()
    await installedTheme(f)
    const reader = await themeObservation(f.owner).subscribe(value => { snapshots.push(value) }, () => {}, signal.signal)
    expect(reader.initial.values.themeId).toBe('custom.original')
    await recolor(f, '#182022'); await recolor(f, '#223036')
    expect(snapshots).toHaveLength(0)
    await reader.start()
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.revision).toBe(2)
    expect((snapshots[0]!.values.theme as ReturnType<typeof custom>).variants.dark.colors.surface0).toBe('#223036')
    expect(snapshots[0]!.sourceId).toBe(reader.initial.sourceId)
    reader.dispose(); await recolor(f, '#273033'); expect(snapshots).toHaveLength(1)
  })
  it('ignores unrelated config and unselected themes, and preserves explicit Terminal palette in relevant snapshots', async () => {
    const f = await configOwnerFixture(), snapshots: AgentMuxAppearanceObservation[] = [], signal = new AbortController()
    await installedTheme(f)
    const reader = await themeObservation(f.owner).subscribe(value => { snapshots.push(value) }, () => {}, signal.signal)
    await reader.start()
    await f.owner.update(config => ({ ...config, copyPathsAsAbsolute: true }))
    await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, customThemes: { ...config.appearance.customThemes, 'custom.other': custom() } } }))
    expect(snapshots).toHaveLength(0)
    await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, appAppearance: 'system', terminalTheme: 'catppuccin-mocha' } }))
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.values.appAppearance).toBe('system')
    expect(snapshots[0]!.values.terminalPalette).not.toEqual(reader.initial.values.terminalPalette)
    reader.dispose()
  })
  it('releases a cancelled opening and a stopped reader without stopping or changing the original owner', async () => {
    const f = await configOwnerFixture(), held = deferred<void>()
    const originalSave = f.save.getMockImplementation()!
    f.save.mockImplementationOnce(async next => { await held.promise; return originalSave(next) })
    const committing = f.owner.update(config => ({ ...config, copyPathsAsAbsolute: true }))
    const controller = new AbortController(), snapshot = vi.fn(), end = vi.fn()
    const pending = themeObservation(f.owner).subscribe(snapshot, end, controller.signal)
    controller.abort(); held.resolve(); await committing
    await expect(pending).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
    expect(snapshot).not.toHaveBeenCalled()
    await installedTheme(f)
    const activeController = new AbortController()
    const reader = await themeObservation(f.owner).subscribe(snapshot, end, activeController.signal)
    await reader.start(); activeController.abort(); await recolor(f, '#223036')
    expect(snapshot).not.toHaveBeenCalled()
    expect(f.owner.current.appearance.themeId).toBe('custom.original')
  })
  it('projects only the selected raw record and diagnoses a builtin shadow without reading unrelated themes', async () => {
    const f = await configOwnerFixture()
    const customThemes: Record<string, unknown> = { graphite: null }
    const unrelated = vi.fn(() => { throw new Error('Unrelated theme was scanned') })
    Object.defineProperty(customThemes, 'custom.unrelated', { enumerable: true, get: unrelated })
    // Getter lives only in the owner read fixture; durable JSON/data is never changed by observing.
    const { ConfigOwner } = await import('../src/main/config-owner.js')
    const owner = new ConfigOwner({ read: () => ({ ...f.owner.current, appearance: { ...f.owner.current.appearance, customThemes } }), save: f.save, publish: f.publish })
    const reader = await themeObservation(owner).subscribe(() => {}, () => {}, new AbortController().signal)
    expect(reader.initial.values.themeId).toBe('graphite'); expect(reader.initial.issues).toEqual([expect.objectContaining({ id: 'graphite' })])
    expect(unrelated).not.toHaveBeenCalled(); reader.dispose()
    expect((await f.disk()).appearance.customThemes).toBeUndefined()
  })
  it('coalesces slow-reader changes to one latest snapshot rather than accumulating theme history', async () => {
    const f = await configOwnerFixture(), delivered: AgentMuxAppearanceObservation[] = [], held = deferred<void>()
    await installedTheme(f)
    const reader = await themeObservation(f.owner).subscribe(async value => { delivered.push(value); if (delivered.length === 1) await held.promise }, () => {}, new AbortController().signal)
    await reader.start(); await recolor(f, '#111921'); await recolor(f, '#222b31'); await recolor(f, '#333d41')
    expect(delivered).toHaveLength(1); held.resolve(); await until(() => delivered.length === 2)
    expect(delivered.map(value => value.revision)).toEqual([1, 3])
    expect((delivered[1]!.values.theme as ReturnType<typeof custom>).variants.dark.colors.surface0).toBe('#333d41')
    reader.dispose()
  })
  it('releases the reader even when its end feedback rejects, without changing the committed owner', async () => {
    const f = await configOwnerFixture(), callback = vi.fn(() => { throw new Error('Consumer failed') }), end = vi.fn(async () => { throw new Error('End delivery failed') })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await installedTheme(f)
    const reader = await themeObservation(f.owner).subscribe(callback, end, new AbortController().signal)
    await reader.start(); await recolor(f, '#223036'); await until(() => end.mock.calls.length === 1)
    await recolor(f, '#333d41'); expect(callback).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledOnce(); expect((await f.disk()).appearance.themeId).toBe('custom.original')
    warning.mockRestore()
  })
  it('reports an observer delivery failure while keeping the committed configuration available', async () => {
    const f = await configOwnerFixture(), end = vi.fn()
    await installedTheme(f)
    const reader = await themeObservation(f.owner).subscribe(() => { throw new Error('Reader could not consume its frame') }, end, new AbortController().signal)
    await reader.start(); await recolor(f, '#223036'); await until(() => end.mock.calls.length === 1)
    expect(end.mock.calls[0]![0]).toBeInstanceOf(Error)
    expect((await f.disk()).appearance.themeId).toBe('custom.original')
  })
})

describe('real public service and compiled amux consume live appearance', () => {
  it('returns a typed opening and updates over actual Unix RPC, then cancels only that reader', async () => {
    const f = await configOwnerFixture(); await installedTheme(f)
    const { client } = await endpoint(f), snapshots: AgentMuxAppearanceObservation[] = []
    let initial: AgentMuxAppearanceObservation | undefined, opening: { observation: AgentMuxAppearanceObservation } | undefined
    const controller = new AbortController()
    const reader = await client.subscribe('settings.appearance.watch', {}, { signal: controller.signal,
      onInitial: value => { opening = value; initial = value.observation }, onEvent: event => { if (event.type === 'snapshot') snapshots.push(event.data) } })
    expect(initial?.values.themeId).toBe('custom.original')
    await recolor(f, '#223036'); await until(() => snapshots.length === 1)
    expect(opening!.observation).toBe(initial); expect(opening!.observation.revision).toBe(0)
    expect(snapshots[0]!.revision).toBeGreaterThan(initial!.revision)
    snapshots[0]!.revision = 999; snapshots[0]!.sourceId = 'consumer-annotation'
    await recolor(f, '#273033'); await until(() => snapshots.length === 2)
    expect(snapshots[1]!.sourceId).not.toBe('consumer-annotation')
    controller.abort(); await reader.dispose(); await recolor(f, '#333d41')
    expect(snapshots).toHaveLength(2)
    expect(f.owner.current.appearance.themeId).toBe('custom.original')
  })
  it('streams a current theme and real later update through compiled CLI, preserving the owner on SIGINT', async () => {
    const f = await configOwnerFixture(); await installedTheme(f)
    const { directory } = await endpoint(f)
    const cli = fileURLToPath(new URL('../../../packages/core/bin/amux', import.meta.url))
    const child = spawn(process.execPath, [cli, 'settings', 'appearance', 'watch'], { env: objectCliEnvironment(directory), stdio: ['ignore', 'pipe', 'pipe'] })
    cleanup.push(() => { if (child.exitCode === null) child.kill('SIGKILL') })
    let buffer = '', stderr = ''
    const frames: any[] = []
    child.stdout.setEncoding('utf8').on('data', chunk => { buffer += chunk; let index: number
      while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line) frames.push(JSON.parse(line)) } })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    await until(() => frames.length > 0)
    expect(frames[0]).toMatchObject({ result: { method: 'settings.appearance.watch', initial: { observation: { values: { themeId: 'custom.original' } } } } })
    await recolor(f, '#223036'); await until(() => frames.some(frame => frame.method === 'system.subscription.event'))
    const update = frames.find(frame => frame.method === 'system.subscription.event')
    expect(update.params.event.data.values.theme.variants.dark.colors.surface0).toBe('#223036')
    const closed = new Promise<number | null>(resolve => child.once('close', resolve)); child.kill('SIGINT'); await closed
    expect(stderr).toBe('')
    expect((await f.disk()).appearance.themeId).toBe('custom.original')
  }, 15_000)
})
