// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { api } from '../src/renderer/src/lib/api'

it('preview relation reads report their unavailable original owner instead of fabricating empty history', async () => {
  const reference = { hostId: 'original-host', agentSessionId: 'original-session' }
  await expect(api.sessions.messageEvents(reference, { latest: true, limit: 1 })).rejects.toThrow('requires its connected Host')
  await expect(api.sessions.spawns(reference, { direction: 'creator' })).rejects.toThrow('require their connected Host')
})
