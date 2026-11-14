import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { importTaskRecording } from './helpers/import-task-recording.js'
import { BrowserTaskAssets, type BrowserTaskAssetStore } from '../src/main/browser-task-assets.js'
import { executeBrowserTaskControl } from '../src/main/browser-task-control.js'
import type { BrowserTaskAssetDocument } from '../src/shared/browser-task-assets.js'
vi.mock('electron', () => ({ WebContentsView: class {}, app: { getPath: () => '' } }))
import { BrowserViewManager } from '../src/main/browser-view-manager.js'

it('reads original retained task progress without admitting a cold native Browser or Renderer', async () => {
  let saved: BrowserTaskAssetDocument | null = null, id = 0
  const store: BrowserTaskAssetStore = { load: async () => saved && structuredClone(saved), save: async value => { saved = structuredClone(value) } }
  const assets = new BrowserTaskAssets(store, { id: () => `cold-${++id}` })
  const browserId = 'cold-original-browser'
  const draft = await importTaskRecording(assets, { id: 'cold-original-recording', browserId, navigationId: 'recorded-document',
    url: 'https://cold.invalid/', revision: 1, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
  const edited = await assets.edit(draft.id, draft.revision, { ...draft.draft, steps: [{ id: 'checkpoint', kind: 'checkpoint', url: 'https://cold.invalid/', reviewed: true }] })
  const asset = await assets.saveVersion(edited.id, edited.revision)
  const run = await assets.run({ browserId, assetId: asset.id, version: 1, parameters: {} }, {
    onRunPrepared: () => {}, control: () => 'agent', yieldControl: () => {}, runScript: vi.fn()
  })
  const restored = new BrowserTaskAssets(store)
  const manager = Object.create(BrowserViewManager.prototype) as BrowserViewManager
  Object.assign(manager, { entries: new Map(), releasedEntries: new Map(), taskAssets: restored })
  const create = vi.spyOn(manager, 'create').mockImplementation(() => { throw new Error('Native admission must not occur for inspection') })
  const result = await executeBrowserTaskControl({ operation: 'browser.task.inspect', browserId, runId: run.id }, manager, false)
  expect(result).toMatchObject({ operation: 'browser.task.inspect', inspection: { rootRunId: run.id, currentRunId: run.id,
    runs: [{ id: run.id, status: 'waiting-human', nextStep: 1, pendingCheckpointId: 'checkpoint' }] } })
  expect(create).not.toHaveBeenCalled()
  const directory = await mkdtemp('/tmp/amux-task-inspect-')
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [],
    execute: request => executeBrowserTaskControl(request, manager, false) })
  try {
    await server.start()
    const response = await runCompiledObjectCli(['browser', 'task', 'inspect', '--browser', browserId, '--run', run.id], objectCliEnvironment(directory))
    expect(response.code, response.stderr).toBe(0)
    expect(JSON.parse(response.stdout).result.inspection).toMatchObject({ rootRunId: run.id, runs: [{ id: run.id, status: 'waiting-human' }] })
    expect(create).not.toHaveBeenCalled()
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }) }
  await expect(executeBrowserTaskControl({ operation: 'browser.task.inspect', browserId: 'other', runId: run.id }, manager, false)).rejects.toMatchObject({ code: 'BROWSER_TASK_RUN_NOT_FOUND' })
  expect((await restored.inspect(browserId))?.runs[0]?.id).toBe(run.id)
}, 30_000)
