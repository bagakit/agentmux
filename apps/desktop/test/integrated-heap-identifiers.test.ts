import { expect, it } from 'vitest'
import { parseRendererHeapSnapshotInput, parseRendererHeapSnapshotInspectInput } from '../../../packages/core/src/renderer-heap-snapshot'

const target = { windowId: 1, webContentsId: 2, generation: 3, pid: 4, creationTime: 1000 }
it('preserves old capture references while rejecting path segments and unbounded or control-character input', () => {
  for (const captureId of ['111111111111', 'original-capture_1', '11111111-1111-4111-8111-111111111111', 'x'.repeat(128)]) {
    expect(parseRendererHeapSnapshotInput({ target, captureId })).toEqual({ target, captureId })
    expect(parseRendererHeapSnapshotInspectInput({ captureId })).toEqual({ captureId })
  }
  for (const captureId of ['', '.', '..', '../original', 'original/other', 'original\\other', 'x'.repeat(129),
    'original\n', 'original\r', 'original\0', 'original capture']) {
    expect(() => parseRendererHeapSnapshotInput({ target, captureId }), JSON.stringify(captureId)).toThrow()
    expect(() => parseRendererHeapSnapshotInspectInput({ captureId }), JSON.stringify(captureId)).toThrow()
  }
})
