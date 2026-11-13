import { describe, expect, it } from 'vitest'
import { BrowserTaskAssets, type BrowserTaskAssetStore } from '../src/main/browser-task-assets'
import type { BrowserTaskAssetDocument, BrowserTaskStep } from '../src/shared/browser-task-assets'

const url = 'https://generic.invalid/form', browserId = 'testing-browser'
const target = (name: string) => ({ role: 'button', name, ordinal: 1, count: 1 })
class MemoryStore implements BrowserTaskAssetStore {
  document: BrowserTaskAssetDocument | null = null
  async load() { return structuredClone(this.document) }
  async save(value: BrowserTaskAssetDocument) { this.document = structuredClone(value) }
}
function assets() {
  let sequence = 0, now = 10
  return new BrowserTaskAssets(new MemoryStore(), { id: () => `testing-${++sequence}`, now: () => now++ })
}
async function draft(owner: BrowserTaskAssets, steps: BrowserTaskStep[]) {
  const imported = await owner.importRecording({ id: 'real-recording', browserId, navigationId: 'nav', url, revision: 1, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
  return owner.edit(imported.id, imported.revision, { ...imported.draft, steps })
}
async function version(steps: BrowserTaskStep[]) {
  const owner = assets(), edited = await draft(owner, steps)
  return owner.saveVersion(edited.id, edited.revision)
}

describe('testing steps are parsed and validated with the existing forward path rules', () => {
  it('keeps every declared testing step and its failure handling through edit and version save', async () => {
    const steps: BrowserTaskStep[] = [
      { id: 'wait', kind: 'wait', url, reviewed: true, wait: { kind: 'element-present', target: { role: 'button', name: 'Ready' } }, timeoutMs: 2_000 },
      { id: 'assert', kind: 'assert', url, reviewed: true, assert: { kind: 'text-present', text: 'Saved' }, retry: 2, onFail: { goto: 'scroll' } },
      { id: 'press', kind: 'press', url, reviewed: true, target: target('Search'), key: 'Enter', onFail: 'continue' },
      { id: 'hover', kind: 'hover', url, reviewed: true, target: target('Menu'), onFail: 'stop' },
      { id: 'scroll', kind: 'scroll', url, reviewed: true, target: target('Footer') }
    ]
    const saved = await version(steps)
    expect(saved.versions[0]!.steps).toEqual(steps)
  })

  it('rejects a failure jump to an earlier or missing step when a version is saved', async () => {
    for (const goto of ['first', 'missing']) {
      const owner = assets()
      const edited = await draft(owner, [
        { id: 'first', kind: 'click', url, reviewed: true, target: target('One') },
        { id: 'second', kind: 'assert', url, reviewed: true, assert: { kind: 'url-is', url }, onFail: { goto } }
      ])
      await expect(owner.saveVersion(edited.id, edited.revision)).rejects.toThrow(/later step|back edges/)
    }
  })

  it.each([-1, 4, 1.5])('rejects retry %s outside 0-3', async retry => {
    await expect(draft(assets(), [{ id: 'one', kind: 'click', url, reviewed: true, target: target('One'), retry }])).rejects.toThrow(/retry must be 0-3/)
  })

  it.each<[string, Partial<BrowserTaskStep>, RegExp]>([
    ['wait without timeout', { kind: 'wait', wait: { kind: 'url-is', url } }, /wait step declares its condition and timeout/],
    ['wait over the per-call budget', { kind: 'wait', wait: { kind: 'url-is', url }, timeoutMs: 25_001 }, /Wait timeout must be 1-25000/],
    ['assert without its fact', { kind: 'assert' }, /assert step declares its expected page fact/],
    ['assert with empty text', { kind: 'assert', assert: { kind: 'text-present', text: ' ' } }, /Invalid assertion/],
    ['press without a key', { kind: 'press', target: target('Search') }, /press step declares its key/],
    ['key on a click', { kind: 'click', target: target('One'), key: 'Enter' }, /press step declares its key/],
    ['retry on a checkpoint', { kind: 'checkpoint', retry: 1 }, /failure handling belongs to page steps/],
    ['unknown failure handling', { kind: 'click', target: target('One'), onFail: 'skip' as never }, /stop, continue or goto/]
  ])('rejects %s', async (_name, step, reason) => {
    await expect(draft(assets(), [{ id: 'one', url, reviewed: true, ...step } as BrowserTaskStep])).rejects.toThrow(reason)
  })

  it('keeps fill parameter rules unchanged next to the new steps', async () => {
    await expect(draft(assets(), [{ id: 'fill', kind: 'fill', url, reviewed: true, target: target('Name'), parameterKey: 'undeclared' }])).rejects.toThrow(/parameter is not defined/)
  })
})
