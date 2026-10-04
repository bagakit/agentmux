import { it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'vite'
const exec = promisify(execFile)
import { tmpdir } from 'node:os'
import { BrowserTaskAssets, BrowserTaskAssetFileStore, type BrowserTaskAssetHost } from '../src/main/browser-task-assets'
import { executeBrowserTaskControl } from '../src/main/browser-task-control'
import type { BrowserDemonstrationDraft } from '../src/shared/browser-demonstration'

const recording = (browserId: string): BrowserDemonstrationDraft => ({
  id: `recording-${browserId}`, browserId, navigationId: `nav-${browserId}`, url: 'https://fixture.invalid/ordinary', revision: 1,
  status: 'stopped', startedAt: 1, updatedAt: 2,
  steps: [{ id: `navigate-${browserId}`, sequence: 1, navigationId: `nav-${browserId}`, recordedAt: 2, source: 'native-human', method: 'gotoUrl',
    url: 'https://fixture.invalid/ordinary', args: ['https://fixture.invalid/ordinary'] }]
})
async function saved(owner: BrowserTaskAssets, browser: string) {
  const initial = await owner.importRecording(recording(browser))
  const edited = await owner.edit(initial.id, initial.revision, { ...initial.draft, steps: initial.draft.steps.map(step => ({ ...step, reviewed: true })) })
  return owner.saveVersion(edited.id, edited.revision)
}
function pageHost() {
  const calls: string[] = []
  const host: BrowserTaskAssetHost = {
    onRunPrepared() {}, control: () => 'agent', yieldControl() {},
    async runScript(browserId, script) {
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor
      const value = await new AsyncFunction('pageInfo', 'gotoUrl', script)(async () => ({ url: 'about:blank' }), async (url: string) => { calls.push(url) })
      return { result: value, logs: [], outcome: { kind: 'completed' }, runOperation: {
        id: `actual-script-${calls.length}`, browserId, phase: 'completed', operator: { id: 'private-person', name: 'Private Person' },
        startedAt: 1, summary: 'Actual generated navigation program', url: 'https://fixture.invalid/ordinary', steps: []
      } }
    }
  }
  return { host, calls }
}
it('retains completed runs while admitting an unrelated Browser after a real process reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-root-review-task-'))
  try {
    const path = join(directory, 'original-assets.json'), owner = new BrowserTaskAssets(new BrowserTaskAssetFileStore(path))
    const first = await saved(owner, 'private-browser-a'), second = await saved(owner, 'private-browser-b'), page = pageHost()
    for (let index = 0; index < 64; index++) expect((await owner.run({ browserId: first.browserId, assetId: first.id, version: 1, parameters: {} }, page.host)).status).toBe('completed')
    const reopened = new BrowserTaskAssets(new BrowserTaskAssetFileStore(path)), state = await reopened.state()
    expect(state.runs).toHaveLength(64); expect(state.runs.every(run => run.status === 'completed')).toBe(true)
    expect(reopened.isBrowserExecuting(second.browserId)).toBe(false)
    const result = await executeBrowserTaskControl({ operation: 'browser.task.run', browserId: second.browserId, assetId: second.id, version: 1, parameters: {} }, { getTaskAssets: id => reopened.state(id), getOperation: async () => null, runControlledTaskAsset: input => reopened.run(input, page.host), runControlledTaskBatch: async () => { throw new Error('unused') }, stopTaskAsset: (id, run) => reopened.stop(id, run), stopTaskBatch: async () => null }, true)
    expect(result).toMatchObject({ operation: 'browser.task.run', run: { status: 'completed', browserId: second.browserId } })
    expect(page.calls).toHaveLength(65)
    expect((await reopened.state()).runs.slice(0, 64)).toEqual(state.runs)
    const bundle = join(directory, 'reopen.mjs')
    const entry = join(directory, 'reopen.ts')
    await writeFile(entry, `import { BrowserTaskAssetFileStore, BrowserTaskAssets } from ${JSON.stringify(resolve('apps/desktop/src/main/browser-task-assets.ts'))}; const state = await new BrowserTaskAssets(new BrowserTaskAssetFileStore(process.argv[2])).state(); console.log(JSON.stringify(state));`)
    await symlink(resolve('apps/desktop/node_modules'), join(directory, 'node_modules'), 'dir')
    await build({ configFile: false, logLevel: 'silent', build: { emptyOutDir: false, outDir: directory, lib: { entry, formats: ['es'], fileName: () => 'reopen.mjs' }, rollupOptions: { external: (id) => id.startsWith('node:') || id === '@agentmux/core' } } })
    const child = await exec(process.execPath, [bundle, path], { env: { ...process.env, NODE_PATH: resolve('node_modules') }, maxBuffer: 4 * 1024 * 1024 })
    expect(JSON.parse(child.stdout).runs).toHaveLength(65)

  } finally { await rm(directory, { recursive: true, force: true }) }
})
it('retains sixteen versions and saves the seventeenth after FileStore reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-root-review-version-'))
  try {
    const path = join(directory, 'original-assets.json'), owner = new BrowserTaskAssets(new BrowserTaskAssetFileStore(path))
    let asset = await saved(owner, 'private-browser')
    for (let index = 1; index < 16; index++) asset = await owner.saveVersion(asset.id, asset.revision)
    const reopened = new BrowserTaskAssets(new BrowserTaskAssetFileStore(path))
    expect((await reopened.state()).runs).toHaveLength(0)
    const next = await reopened.saveVersion(asset.id, asset.revision)
    expect(next.versions).toHaveLength(17)
    expect(next.versions.slice(0,16)).toEqual(asset.versions)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('preserves more than 32 assets and batches and a legal document above one MiB', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-task-retention-'))
  try {
    const path = join(directory, 'original-assets.json'), store = new BrowserTaskAssetFileStore(path)
    let owner = new BrowserTaskAssets(store), first = await saved(owner, 'large-browser')
    const longUrl = 'https://fixture.invalid/' + 'p'.repeat(1800)
    first = await owner.edit(first.id, first.revision, { ...first.draft, steps: Array.from({ length: 128 }, (_, index) => ({ id: 'nav-' + index, kind: 'navigate', url: longUrl, reviewed: true })) })
    for (let index = 0; index < 5; index++) first = await owner.saveVersion(first.id, first.revision)
    const original = await store.load()
    expect((await readFile(path)).length).toBeGreaterThan(1_048_576)
    owner = new BrowserTaskAssets(new BrowserTaskAssetFileStore(path))
    expect((await owner.state()).assets[0]).toEqual(original!.assets[0])
    let simple = await saved(owner, 'simple-browser')
    for (let index = 0; index < 32; index++) await saved(owner, 'browser-' + index)
    const page = pageHost()
    for (let index = 0; index < 33; index++) {
      const batch = await owner.runBatch({ browserId: simple.browserId, assetId: simple.id, version: 1, items: [{ id: 'item', parameters: {} }], parameters: {} }, { runTask: (input, budget) => owner.run(input, page.host, budget) })
      expect(batch.status).toBe('completed')
    }
    const state = await owner.state(), reopened = await new BrowserTaskAssets(new BrowserTaskAssetFileStore(path)).state()
    expect(state.assets).toHaveLength(34); expect(state.batches).toHaveLength(33)
    expect(reopened).toEqual(state); expect(reopened.assets[0]).toEqual(original!.assets[0])
    expect(page.calls).toHaveLength(33)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
