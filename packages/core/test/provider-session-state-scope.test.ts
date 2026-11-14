import { afterEach, expect, it } from 'vitest'
import { activityCertaintyClient } from './fixtures/activity-certainty-client.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })

async function mainIdle() {
  const h = await activityCertaintyClient('scope-original', 'claude'); closes.push(h.close)
  const payload = { session_id: 'native-main', sourceId: 'source-original', turnId: 'main-original' }
  await h.hook('turn.start', 'main-start-original', { ...payload, sequence: 1 })
  await h.hook('turn.complete', 'main-end-original', { ...payload, sequence: 2, reason: 'answer', isAborted: false, backgroundWork: 'none' })
  expect((await h.client.statusAgent('scope-original')).observation.mainSession?.semantic).toBe('idle')
  return h
}

it('an original source failure cannot retain a current main idle claim', async () => {
  const h = await mainIdle()
  await h.hook('AgentMuxActivityUnavailable', 'source-failed-original', {
    sourceId: 'source-original', sequence: 3, reason: 'source-identity-unavailable'
  })
  const status = await h.client.statusAgent('scope-original')
  expect(status.observation.semantic).toBe('unknown')
  expect(status.observation.mainSession?.semantic).toBe('unknown')
  expect(status.session.currentActivity?.state).toBe('unknown')
})

it('a new native main epoch cannot inherit the preceding main idle claim', async () => {
  const h = await mainIdle()
  await h.hook('SessionStart', 'main-epoch-changed', { session_id: 'native-main', source: 'startup' })
  const status = await h.client.statusAgent('scope-original')
  expect(status.observation.semantic).toBe('unknown')
  expect(status.observation.mainSession?.semantic).toBe('unknown')
})
