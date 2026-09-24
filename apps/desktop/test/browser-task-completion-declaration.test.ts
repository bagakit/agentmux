import { describe, expect, it } from 'vitest'
import { BrowserTaskAssets, type BrowserTaskAssetStore } from '../src/main/browser-task-assets'
import type { BrowserTaskAssetDocument, BrowserTaskContent } from '../src/shared/browser-task-assets'
import type { BrowserDemonstrationDraft } from '../src/shared/browser-demonstration'

const recording: BrowserDemonstrationDraft = { id: 'recording', browserId: 'browser', navigationId: 'navigation', url: 'https://generic.invalid/file', revision: 1,
  status: 'stopped', startedAt: 1, updatedAt: 1, steps: [{ id: 'producer', sequence: 1, navigationId: 'navigation', recordedAt: 1, source: 'native-human',
    method: 'click', url: 'https://generic.invalid/file', target: { role: 'button', name: 'Create file', ordinal: 1, count: 1 }, args: [] }] }

describe('immutable finite completion declaration', () => {
  it('rejects unknown fields and malformed conditions before saving, while retaining the original usable draft', async () => {
    let document: BrowserTaskAssetDocument | null = null, saves = 0
    const store: BrowserTaskAssetStore = { load: async () => structuredClone(document), save: async value => { saves++; document = structuredClone(value) } }
    const owner = new BrowserTaskAssets(store)
    const asset = await owner.importRecording(recording)
    const base = { kind: 'download-readable', stepId: 'producer', path: 'artifact.bin' }
    const invalid = [null, {}, { criteria: [] }, { criteria: [base], secret: 'must-not-save' },
      { criteria: [{ ...base, secret: 'must-not-save' }] }, { criteria: [{ ...base, stepId: 'missing' }] },
      { criteria: [{ kind: 'human-checkpoint', checkpointId: 'missing' }] }, { criteria: [{ kind: 'unknown' }] }]
    const beforeSaves = saves
    for (const completion of invalid) {
      await expect(owner.edit(asset.id, asset.revision, { ...asset.draft, completion } as BrowserTaskContent)).rejects.toThrow()
      expect(await owner.get(asset.id)).toEqual(asset)
      expect(saves).toBe(beforeSaves)
    }
    const edited = await owner.edit(asset.id, asset.revision, { ...asset.draft, completion: { criteria: [{ kind: 'download-readable', stepId: 'producer', path: 'artifact.bin' }] } })
    const saved = await owner.saveVersion(asset.id, edited.revision)
    expect(saved.versions).toHaveLength(1)
    expect(saved.versions[0]?.completion).toEqual({ criteria: [base] })
    expect(JSON.stringify(document)).not.toContain('must-not-save')
  })
})
