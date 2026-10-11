// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { useAppStore } from '../src/renderer/src/store'

it('keeps a misrouted trace at the Main owner and preserves the original Store and draft', async () => {
  useAppStore.setState({ agentComposerDrafts: { 'original-region': 'Keep original draft.' } })
  const original = useAppStore.getState()
  await expect(original.executeControl({ schemaVersion: 5, requestId: 'private-trace-route', operation: 'metrics.trace.capture',
    target: { windowId: 1, webContentsId: 2, generation: 3, pid: 4, creationTime: 1000 }, durationMs: 1000 })).rejects.toMatchObject({
    code: 'CONTROL_FAILED', message: 'Metrics queries belong to the Main observation owner.'
  })
  expect(useAppStore.getState()).toBe(original)
  expect(original.agentComposerDrafts['original-region']).toBe('Keep original draft.')
})
