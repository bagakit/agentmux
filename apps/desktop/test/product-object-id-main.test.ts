import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceAuthority } from '../../host/src/device-authority.js'
import { BrowserDemonstrationFileStore, BrowserDemonstrationRecorder } from '../src/main/browser-demonstration-recorder.js'
import { BrowserTaskAssetFileStore, BrowserTaskAssets, runBrowserTaskAsset, type BrowserTaskAssetHost } from '../src/main/browser-task-assets.js'
import { runBrowserTaskBatch } from '../src/main/browser-task-batch.js'
import type { BrowserScriptRunReport } from '../src/shared/contracts.js'

const roots: string[] = []
const ID = /^[1-9A-HJ-NP-Za-km-z]{12}$/
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function root() { const value = await mkdtemp(join(tmpdir(), 'amux-product-identity-')); roots.push(value); return value }

it('retains Host and Device identity and original credential binding across reopen, including previously stored UUIDs', async () => {
  const directory = await root(), path = join(directory, 'devices.json'), key = Buffer.alloc(32, 7).toString('base64')
  const owner = await DeviceAuthority.open(path), device = await owner.authorizeKey(key)
  expect(owner.hostId).toMatch(ID); expect(device.deviceId).toMatch(ID)
  const stored = await readFile(path, 'utf8'), reopened = await DeviceAuthority.open(path)
  expect(reopened.hostId).toBe(owner.hostId)
  expect((await reopened.authorizeKey(key)).deviceId).toBe(device.deviceId)
  expect(await readFile(path, 'utf8')).toBe(stored)
  const oldHost = '11111111-1111-4111-8111-111111111111', oldDevice = '22222222-2222-4222-8222-222222222222'
  await writeFile(path, JSON.stringify({ schema: 'agentmux.device-authority.v1', hostId: oldHost,
    devices: [{ deviceId: oldDevice, name: 'Original device', createdAt: 1, credentialHash: createHash('sha256').update(key).digest('hex') }] }))
  const legacyBytes = await readFile(path, 'utf8'), legacy = await DeviceAuthority.open(path)
  expect(legacy.hostId).toBe(oldHost); expect((await legacy.authorizeKey(key)).deviceId).toBe(oldDevice)
  expect(legacy.operationSource({ kind: 'device', id: `${oldHost}:${oldDevice}` })).toEqual({ hostId: oldHost, deviceId: oldDevice, name: 'Original device' })
  expect(await readFile(path, 'utf8')).toBe(legacyBytes)
})

it('allocates fixed IDs along the original recording → task → run/batch chain and reopens exact persisted results', async () => {
  const directory = await root(), recordings = join(directory, 'recordings.json'), tasks = join(directory, 'tasks.json')
  const recorder = new BrowserDemonstrationRecorder(new BrowserDemonstrationFileStore(recordings))
  const browserId = 'original-browser', navigationId = 'original-navigation', url = 'https://fixture.invalid/form'
  const draft = await recorder.start({ browserId, navigationId, url })
  recorder.noteNativeInput({ browserId, navigationId, type: 'mouseUp' })
  await recorder.recordBrowserDemonstration({ browserId, navigationId, kind: 'click', isTrusted: true,
    target: { role: 'button', name: 'Continue', ordinal: 1, count: 1 } })
  const recording = (await recorder.stop(browserId))!
  expect(draft.id).toMatch(ID); expect(recording.steps).toHaveLength(1); expect(recording.steps[0]!.id).toMatch(ID)
  const restored = await new BrowserDemonstrationRecorder(new BrowserDemonstrationFileStore(recordings)).get(browserId)
  expect(restored).toEqual(recording)
  const assets = new BrowserTaskAssets(new BrowserTaskAssetFileStore(tasks))
  const imported = await assets.importRecording(recording)
  const edited = await assets.edit(imported.id, imported.revision, { ...imported.draft, steps: imported.draft.steps.map(step => ({ ...step, reviewed: true })) })
  const asset = await assets.saveVersion(edited.id, edited.revision)
  expect(asset.id).toMatch(ID)
  let actions = 0, operations = 0
  const prepared: string[] = []
  const host: BrowserTaskAssetHost = {
    onRunPrepared: id => { prepared.push(id) }, control: () => 'agent', yieldControl: () => {},
    runScript: async (id, script): Promise<BrowserScriptRunReport> => {
      expect(id).toBe(browserId)
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      const result = await new AsyncFunction('pageInfo', 'snapshot', 'click', script)(
        async () => ({ url }), async () => ({ observation: { scope: { kind: 'page', document: null }, truncated: false, omittedFrames: [] }, missingFrames: [],
          nodes: [{ ref: '@e1', role: 'button', name: 'Continue' }] }), async (ref: string) => { expect(ref).toBe('@e1'); actions++ })
      return { result, logs: [], outcome: { kind: 'completed' }, runOperation: { id: `operation-${++operations}`, browserId, phase: 'completed', operator: { id: 'user', name: 'User' }, startedAt: 1, summary: 'Original page action', url, steps: [] } }
    }
  }
  const run = await runBrowserTaskAsset(assets, { assetId: asset.id, version: 1, browserId, parameters: {} }, host)
  expect(run.id).toMatch(ID); expect(run.status).toBe('completed')
  const batch = await runBrowserTaskBatch(assets, { assetId: asset.id, version: 1, browserId, parameters: {}, items: [{ id: 'original-item', parameters: {} }] },
    { runTask: (input, budget) => runBrowserTaskAsset(assets, input, host, budget) })
  expect(batch.id).toMatch(ID); expect(batch.status).toBe('completed'); expect(batch.items[0]!.runId).toMatch(ID)
  expect(actions).toBe(2); expect(operations).toBe(2); expect(prepared).toEqual([run.id, batch.items[0]!.runId])
  expect(new Set([draft.id, recording.steps[0]!.id, asset.id, run.id, batch.id, batch.items[0]!.runId]).size).toBe(6)
  const restarted = await new BrowserTaskAssets(new BrowserTaskAssetFileStore(tasks)).state(browserId)
  expect(restarted.assets).toEqual([asset]); expect(restarted.runs.map(item => item.id)).toEqual([run.id, batch.items[0]!.runId]); expect(restarted.batches).toEqual([batch])
})
