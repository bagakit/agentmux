import { beforeEach, expect, it } from 'vitest'
import type { AgentMuxControlMetricsRequest } from '@agentmux/core/control'
import { useAppStore } from '../src/renderer/src/store'

const requests: AgentMuxControlMetricsRequest[] = [
  { schemaVersion: 5, requestId: 'renderer-metrics-get', operation: 'metrics.get' },
  { schemaVersion: 5, requestId: 'renderer-metrics-watch', operation: 'metrics.watch' },
  { schemaVersion: 5, requestId: 'renderer-profile-capture', operation: 'metrics.profile.capture',
    target: { windowId: 1, webContentsId: 2, generation: 3, pid: 4, creationTime: 1000 }, durationMs: 1000 }
]

beforeEach(() => {
  useAppStore.setState({ agentComposerDrafts: { 'original-region': 'Keep the original input.' } })
})

it.each(requests)('keeps $operation at its Main observation owner when misrouted to the Renderer', async request => {
  const original = useAppStore.getState()
  await expect(original.executeControl(request)).rejects.toMatchObject({
    code: 'CONTROL_FAILED', message: 'Metrics queries belong to the Main observation owner.'
  })
  expect(useAppStore.getState()).toBe(original)
  expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
  expect(useAppStore.getState().agentComposerDrafts['original-region']).toBe('Keep the original input.')
  expect(useAppStore.getState().sessions).toBe(original.sessions)
  expect(useAppStore.getState().tabs).toBe(original.tabs)
  expect(useAppStore.getState().layouts).toBe(original.layouts)
})
