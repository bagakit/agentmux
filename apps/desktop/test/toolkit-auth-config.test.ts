const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { INITIAL_TOOLKIT_PACKAGES } from '../resources/toolkit/initial-packages'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store'
import { bootstrapToolkitPackages } from '../src/main/toolkit-package-bootstrap'
import { captureToolkitPackage } from '../src/main/toolkit-package'
import type { ToolkitPackageConfiguration } from '@agentmux/core/control'

const env = vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs'), os = process.getBuiltinModule('node:os'), path = process.getBuiltinModule('node:path')
  return { home: fs.mkdtempSync(path.join(os.tmpdir(), 'amx-auth-home-')), userData: '', appRoot: '' }
})
vi.mock('electron', () => ({ app: { getPath: (kind: string) => kind === 'home' ? env.home : env.userData,
  getAppPath: () => env.appRoot } }))
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
afterAll(async () => { await rm(env.home, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-auth-config-')); roots.push(root)
  env.userData = root; env.appRoot = resolve('apps/desktop')
  const path = join(root, 'config.json'), packagePath = join(root, 'toolkit', 'packages', 'auth')
  return { root, path, packagePath, store: new ConfigStore(path) }
}
const packageTool = (config: Awaited<ReturnType<ConfigStore['get']>>) => config.toolkit!.tools![0]! as ToolkitPackageConfiguration

describe('ordinary Auth initial local package configuration', () => {
  it('writes one normal package only for a missing config and reopens its exact persisted source reference', async () => {
    const { path, packagePath, store } = await fixture(), config = await store.get()
    expect(config.toolkit?.tools).toEqual([{ kind: 'package', id: INITIAL_TOOLKIT_PACKAGES[0]!.id,
      revision: expect.any(String), packagePath, workspacePath: env.home, enabled: true, statusBar: 'icon', args: ['codexL', '@active'] }])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(config)
    expect(await new ConfigStore(path).get()).toEqual(config)
    expect(DEFAULT_CONFIG.toolkit).toBeUndefined()
    expect((await readdir(packagePath)).sort()).toEqual(['README.md', 'manifest.json', 'query.mjs'])
    const captured = await captureToolkitPackage(packageTool(config))
    expect(captured.definition).toMatchObject({ id: 'auth', name: 'Auth', icon: 'key-round', args: ['codexL', '@active'],
      package: { path: packagePath, configRevision: packageTool(config).revision, entry: 'query.mjs' } })
    expect(await readFile(join(packagePath, 'query.mjs'), 'utf8')).toBe(await readFile(resolve('apps/desktop/resources/toolkit/auth/query.mjs'), 'utf8'))
    expect(packageTool(config)).not.toHaveProperty('script')
  })
  it('never seeds an existing absent or empty tools list, including a previously deleted package', async () => {
    for (const toolkit of [undefined, { tools: [] }]) {
      const { path, packagePath, store } = await fixture()
      await writeFile(path, JSON.stringify({ ...structuredClone(DEFAULT_CONFIG), ...(toolkit ? { toolkit } : {}) }))
      const config = await store.get()
      expect(config.toolkit?.tools ?? []).toEqual([])
      await expect(readdir(packagePath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await new ConfigStore(path).get()).toEqual(config)
    }
    const { path, packagePath, store } = await fixture(), config = await store.get()
    await store.save({ ...config, toolkit: { ...config.toolkit, tools: [] } })
    expect((await new ConfigStore(path).get()).toolkit?.tools).toEqual([])
    expect(await readFile(join(packagePath, 'manifest.json'), 'utf8')).toContain('agentmux.toolkit.package.v1')
  })
  it('preserves edited package source/preferences, original inline identity and all 128 user records', async () => {
    const { path, packagePath, store } = await fixture(), config = await store.get()
    const original = await captureToolkitPackage(packageTool(config))
    const changedManifest = { schema: 'agentmux.toolkit.package.v1', name: 'My unrelated report', icon: 'terminal', entry: 'query.mjs', actions: [] }
    await writeFile(join(packagePath, 'manifest.json'), JSON.stringify(changedManifest))
    await writeFile(join(packagePath, 'query.mjs'), "console.log('authored source')")
    const edited = { ...packageTool(config), enabled: false, statusBar: 'label' as const, args: ['my-own-query'] }
    const inline = { id: 'original-inline', revision: 'original-inline-revision', name: 'Original', icon: 'terminal',
      enabled: true, statusBar: 'icon' as const, workspacePath: env.home, script: "console.log('retained original')", args: [] }
    const tools = [edited, inline, ...Array.from({ length: 126 }, (_, i) => ({ ...edited, id: `saved-${i}`, revision: `revision-${i}` }))]
    await store.save({ ...config, toolkit: { tools } })
    const reopened = await new ConfigStore(path).get()
    expect(reopened.toolkit?.tools).toEqual(tools)
    const captured = await captureToolkitPackage(packageTool(reopened))
    expect(captured.definition.name).toBe(changedManifest.name)
    expect(captured.definition.script).toBe("console.log('authored source')")
    expect(captured.definition.package!.contentSHA256).not.toBe(original.definition.package!.contentSHA256)
    expect(await readFile(join(packagePath, 'manifest.json'), 'utf8')).toBe(JSON.stringify(changedManifest))
  })
  it('does not seed a retired config while retaining its authored workspace', async () => {
    const { path, packagePath, store } = await fixture()
    await writeFile(path, JSON.stringify({ ...structuredClone(DEFAULT_CONFIG), version: DEFAULT_CONFIG.version - 1,
      workspaces: [{ id: 'kept', name: 'Kept', hostId: 'local', path: _hygiene_fixturePath("kept"), kind: 'folder' }] }))
    const config = await store.get()
    expect(config.toolkit?.tools ?? []).toEqual([])
    expect(config.workspaces.find(w => w.id === 'kept')?.path).toBe(_hygiene_fixturePath("kept"))
    await expect(readdir(packagePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('keeps the entire existing source directory even when the configuration is first created', async () => {
    const { packagePath, store } = await fixture()
    await mkdir(packagePath, { recursive: true })
    const manifest = JSON.stringify({ schema: 'agentmux.toolkit.package.v1', name: 'User preserved', icon: 'terminal', entry: 'query.mjs' })
    await writeFile(join(packagePath, 'manifest.json'), manifest)
    await writeFile(join(packagePath, 'query.mjs'), "console.log('user preserved')")
    const config = await store.get()
    expect(await readFile(join(packagePath, 'manifest.json'), 'utf8')).toBe(manifest)
    expect(await readFile(join(packagePath, 'query.mjs'), 'utf8')).toBe("console.log('user preserved')")
    expect((await readdir(packagePath)).sort()).toEqual(['manifest.json', 'query.mjs'])
    expect((await captureToolkitPackage(packageTool(config))).definition.name).toBe('User preserved')
  })
  it('reports partial deployment while saving ordinary references and preserving unrelated configuration', async () => {
    const { root, path, packagePath, store } = await fixture()
    env.appRoot = join(root, 'missing-application-resources')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config = await store.get()
    expect(config.hosts).toEqual(DEFAULT_CONFIG.hosts)
    expect(config.executors).toEqual(DEFAULT_CONFIG.executors)
    expect(packageTool(config)).toMatchObject({ kind: 'package', packagePath })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(config)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Package deployment is incomplete'))
    await expect(captureToolkitPackage(packageTool(config))).rejects.toMatchObject({ code: 'TOOLKIT_PACKAGE_UNAVAILABLE' })
    const preserve = join(root, 'preserve'), issues = vi.fn()
    await mkdir(join(preserve, 'auth'), { recursive: true }); await writeFile(join(preserve, 'auth', 'user-marker'), 'kept')
    await bootstrapToolkitPackages({ resourceRoot: join(root, 'missing-assets'), packageRoot: preserve,
      workspacePath: env.home, packages: INITIAL_TOOLKIT_PACKAGES, reportIssue: issues })
    expect(await readFile(join(preserve, 'auth', 'user-marker'), 'utf8')).toBe('kept')
    expect(issues).not.toHaveBeenCalled()
  })
})
