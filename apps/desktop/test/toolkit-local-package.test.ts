import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppConfig } from '../src/shared/contracts'
import type { ToolkitPackageConfiguration, ToolkitRunInput, ToolkitSnapshot } from '@agentmux/core/control'
import { parseToolkitSnapshot } from '@agentmux/core/control'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store'
import { ConfigOwner } from '../src/main/config-owner'
import { CustomToolkitOwner } from '../src/main/toolkit-custom-owner'
import { captureToolkitPackage, writeToolkitPackageSnapshot, removeToolkitPackageSnapshot } from '../src/main/toolkit-package'
import { executeToolkitConfig, prepareToolkitConfig } from '../src/main/toolkit-config'
import type { ToolkitRunPort } from '../src/main/toolkit-run-port'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true }) })
async function localPackage() {
  const root = await mkdtemp(join(tmpdir(), 'amx-local-package-')); roots.push(root)
  const source = join(root, 'source'); await mkdir(source)
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ schema: 'agentmux.toolkit.package.v1', name: 'Local report', icon: 'terminal', entry: 'report.mjs', actions: [{ id: 'refresh', label: 'Refresh', entry: 'action.mjs', args: ['ACTION_ONLY'] }] }))
  await writeFile(join(source, 'report.mjs'), "import { value } from './helper.mjs'; console.log(value)")
  await writeFile(join(source, 'helper.mjs'), "export const value = 'CAPTURED_A'")
  await writeFile(join(source, 'action.mjs'), "console.log(process.argv.slice(2))")
  const record: ToolkitPackageConfiguration = { kind: 'package', id: 'local', revision: 'config-a', packagePath: source, enabled: true, statusBar: 'icon', args: ['QUERY_ONLY'], workspacePath: root }
  return { root, source, record }
}
function script(value: ToolkitSnapshot) {
  if (value.kind !== 'script') throw Error('Expected available script')
  return value
}
async function ownerFixture() {
  const f = await localPackage(), receipts = new Map<string, unknown>()
  let config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), toolkit: { tools: [f.record] } }, custom!: CustomToolkitOwner
  let running = true, listener: ((event: any) => void) | undefined
  const run = () => ({ runId: 'local-run', kind: 'terminal', state: running ? 'running' : 'exited', exitCode: running ? undefined : 0, latestOutputBytes: 0 })
  const attached = () => ({ run: run(), replay: [], gap: null }) as any
  const port: ToolkitRunPort = { create: vi.fn(async (_request, event) => { listener = event; return run() as any }),
    attach: vi.fn(async (_ref, _byte, event) => { if (event) listener = event; return attached() }), replay: vi.fn(async () => attached()),
    release: vi.fn(async () => {}), remove: vi.fn(async () => {}), stop: vi.fn(async () => { running = false; listener?.({ type: 'process-state', run: { runId: 'local-run' }, state: 'exited', exitCode: 0 }) }) }
  const storage = { read: async (id: string) => receipts.get(id) ?? null, save: async (id: string, value: unknown) => { receipts.set(id, structuredClone(value)) } }
  const configOwner = new ConfigOwner({ read: () => config, prepare: (before, next) => prepareToolkitConfig(before, next, id => custom.guardDelete(id)), save: async next => next, publish: saved => { config = saved; custom.configurationChanged() } })
  const make = () => new CustomToolkitOwner({ config: configOwner, receipts: storage, runner: process.execPath, env: {}, snapshotRoot: join(f.root, 'snapshots'), openRunPort: async () => port })
  custom = make()
  const input = async (): Promise<ToolkitRunInput> => { const s = script(await custom.get('local')); return { invocationId: randomUUID(), expectedRevision: s.definition.revision, expectedLatestExecutionId: s.latestConfirmed?.executionId ?? null } }
  return { ...f, custom, configOwner, receipts, port, input, make }
}
describe('local package configuration and admission', () => {
  it('saves only a package reference through ConfigOwner/ConfigStore and preserves original inline records', async () => {
    const f = await localPackage(), store = new ConfigStore(join(f.root, 'config.json'))
    const inline = { id: 'inline', revision: 'inline-a', name: 'Authored', icon: 'terminal', enabled: true, statusBar: 'icon' as const, workspacePath: f.root, script: "console.log('retained')", args: [] }
    let config = await store.save({ ...await store.get(), toolkit: { tools: [inline] } })
    const owner = new ConfigOwner({ read: () => config, save: next => store.save(next), publish: next => { config = next } })
    const { id, revision, workspacePath, ...fields } = f.record
    const adding = executeToolkitConfig({ operation: 'toolkit.add', toolId: id, value: fields }, owner)
    await expect(adding).resolves.toMatchObject({ operation: 'toolkit.add', definition: { kind: 'package' } })
    const result = await adding
    expect(result.operation).toBe('toolkit.add'); expect(config.toolkit!.tools![0]).toEqual(inline)
    expect(config.toolkit!.tools![1]).toMatchObject({ kind: 'package', packagePath: f.source, workspacePath: tmpdir() })
    expect(JSON.parse(await readFile(join(f.root, 'config.json'), 'utf8')).toolkit.tools[1]).not.toHaveProperty('script')
    expect(await new ConfigStore(join(f.root, 'config.json')).get()).toEqual(config)
    const before = await readFile(join(f.root, 'config.json'), 'utf8')
    await expect(executeToolkitConfig({ operation: 'toolkit.update', toolId: id, changes: { enabled: false }, expected: { enabled: false } }, owner)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(await readFile(join(f.root, 'config.json'), 'utf8')).toBe(before)
  })
  it('captures helpers and independent action argv, changing a helper changes effective revision with the same config', async () => {
    const f = await localPackage(), first = await captureToolkitPackage(f.record)
    await writeFile(join(f.source, 'helper.mjs'), "export const value = 'LIVE_B'")
    const next = await captureToolkitPackage(f.record)
    expect(first.definition.revision).not.toBe(next.definition.revision)
    expect(first.definition.package!.configRevision).toBe(next.definition.package!.configRevision)
    expect(first.definition.actions![0]!.args).toEqual(['ACTION_ONLY'])
    const copy = await writeToolkitPackageSnapshot(join(f.root, 'copies'), 'one', first)
    expect(await readFile(join(copy, 'helper.mjs'), 'utf8')).toContain('CAPTURED_A')
    expect(await readFile(join(copy, 'report.mjs'), 'utf8')).toContain("'./helper.mjs'")
  })
  it('launches the captured file tree, never the edited live directory, and keeps reads/watch inert', async () => {
    const f = await ownerFixture(), i = await f.input(), seen = vi.fn()
    const lease = await f.custom.subscribe('local', seen, vi.fn(), new AbortController().signal)
    expect(f.port.create).not.toHaveBeenCalled()
    const running = script(await f.custom.run('local', i, new AbortController().signal))
    await writeFile(join(f.source, 'helper.mjs'), "export const value = 'EDITED_B'")
    const request = vi.mocked(f.port.create).mock.calls[0]![0]
    expect(request.args).not.toContain('--eval')
    expect(request.args!.slice(1)).toEqual(['QUERY_ONLY'])
    expect(request.args![0]).toBe(join(f.root, 'snapshots', running.admission!.executionId, 'files', 'report.mjs'))
    expect(await readFile(join(request.args![0]!, '..', 'helper.mjs'), 'utf8')).toContain('CAPTURED_A')
    lease.dispose(); await f.custom.stop('local', running.admission!.executionId)
  })
  it('rejects stale expected revision and stale result action after source changes without admitting another Run', async () => {
    const f = await ownerFixture(), i = await f.input()
    await writeFile(join(f.source, 'helper.mjs'), "export const value = 'NEW'")
    await expect(f.custom.run('local', i, new AbortController().signal)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(f.port.create).not.toHaveBeenCalled()
    const currentInput = await f.input(), s = script(await f.custom.run('local', currentInput, new AbortController().signal))
    const stopped = script(await f.custom.stop('local', s.admission!.executionId))
    await writeFile(join(f.source, 'action.mjs'), "console.log('CHANGED_ACTION')")
    await expect(f.custom.action('local', 'refresh', { invocationId: randomUUID(), expectedRevision: stopped.definition.revision, sourceExecutionId: stopped.latestConfirmed!.executionId, expectedAdmissionExecutionId: null }, new AbortController().signal)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(f.port.create).toHaveBeenCalledTimes(1)
  })
  it('retains exact execution and restores its receipt without the source directory; stop still targets the original Run', async () => {
    const f = await ownerFixture(), running = script(await f.custom.run('local', await f.input(), new AbortController().signal))
    await rename(f.source, f.source + '-moved')
    const unavailable = await f.custom.get('local')
    expect(unavailable).toMatchObject({ kind: 'package-unavailable', configuration: f.record, retained: { admission: { executionId: running.admission!.executionId, run: { runId: 'local-run' } } } })
    expect(parseToolkitSnapshot(unavailable)).toEqual(unavailable)
    const restored = f.make(), after = await restored.get('local')
    expect(after).toMatchObject({ kind: 'package-unavailable', retained: { admission: { run: { runId: 'local-run' } } } })
    const stopping = restored.stop('local', running.admission!.executionId)
    await expect(stopping).resolves.toMatchObject({ kind: 'package-unavailable', retained: { admission: null } })
    const stopped = await stopping
    expect(stopped).toMatchObject({ kind: 'package-unavailable', retained: { admission: null, latestConfirmed: { state: 'stopped', executionId: running.admission!.executionId } } })
    expect(f.port.stop).toHaveBeenCalledWith({ runId: 'local-run' })
    expect(f.port.create).toHaveBeenCalledTimes(1)
  })
  it('never interprets a retained protocol ID as a cleanup path or deletes an unowned directory', async () => {
    const f = await localPackage(), root = join(f.root, 'copies'), unrelated = join(f.root, 'unrelated')
    await mkdir(root); await mkdir(unrelated); await writeFile(join(unrelated, 'KEEP'), 'retained')
    await expect(removeToolkitPackageSnapshot(root, '../unrelated')).rejects.toMatchObject({ code: 'TOOLKIT_PACKAGE_UNAVAILABLE' })
    expect(await readFile(join(unrelated, 'KEEP'), 'utf8')).toBe('retained')
    const unowned = join(root, 'unowned'); await mkdir(unowned); await writeFile(join(unowned, 'KEEP'), 'retained')
    await expect(removeToolkitPackageSnapshot(root, 'unowned')).rejects.toThrow()
    expect(await readFile(join(unowned, 'KEEP'), 'utf8')).toBe('retained')
    const capture = await captureToolkitPackage(f.record), files = await writeToolkitPackageSnapshot(root, 'owned', capture)
    await removeToolkitPackageSnapshot(root, 'owned', capture.definition.package!.contentSHA256)
    await expect(readFile(join(files, 'helper.mjs'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects missing sources with the same typed public error for an explicit pinned run', async () => {
    const f = await ownerFixture(), input = await f.input()
    await rename(f.source, f.source + '-missing')
    await expect(f.custom.run('local', input, new AbortController().signal)).rejects.toMatchObject({ code: 'TOOLKIT_PACKAGE_UNAVAILABLE' })
    expect(f.port.create).not.toHaveBeenCalled()
  })
  it('refuses unsupported symlinks and oversized package files without affecting unrelated configuration', async () => {
    const f = await localPackage(); await symlink(join(f.source, 'helper.mjs'), join(f.source, 'link.mjs'))
    await expect(captureToolkitPackage(f.record)).rejects.toMatchObject({ code: 'TOOLKIT_PACKAGE_UNAVAILABLE' })
    await rm(join(f.source, 'link.mjs')); await writeFile(join(f.source, 'large'), Buffer.alloc(1024 * 1024))
    await expect(captureToolkitPackage(f.record)).rejects.toMatchObject({ code: 'TOOLKIT_PACKAGE_UNAVAILABLE' })
  })
})
