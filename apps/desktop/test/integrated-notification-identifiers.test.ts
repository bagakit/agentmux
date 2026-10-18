import { expect, it } from 'vitest'
import { clientNotificationsPort, inspectNotifications } from '../src/main/notification-observation'
import { observeNotifications, registerNotificationReader } from '../src/renderer/src/lib/notification-observation'
import type { AgentMuxControlInspectNotificationsRequest } from '@agentmux/core/control'

it('reads the original notification projection with component request and document IDs without granting an action', async () => {
  const target = { domain: 'client.notifications' as const, hostId: 'local', list: {} }
  const requests: AgentMuxControlInspectNotificationsRequest[] = []
  const renderer = { kind: 'bundled', id: 'a'.repeat(64), identity: { shell: 'fixture-shell', ctxmux: 'fixture-ctxmux' } } as const
  const projection = { current: [], activity: [], unavailableSources: [] }
  const dispose = registerNotificationReader(() => projection)
  const port = clientNotificationsPort('local', async request => {
    requests.push(request)
    return await inspectNotifications(request, { renderer: () => renderer, generation: () => 1,
      execute: async original => ({ operation: 'inspect.notifications', observation: observeNotifications(original) }) })
  })
  try {
    const bounds = { signal: new AbortController().signal, includeRaw: false, maxBytes: 16_384 }
    const first = await port.read(target, bounds), next = await port.read(target, bounds)
    expect(first).toMatchObject({ availability: 'found', data: { kind: 'client-notifications', items: [], total: 0 },
      scope: 'point-observation', authorityStatus: 'unavailable', readAuthority: null })
    expect(requests).toHaveLength(2)
    for (const request of requests) expect(request.requestId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/u)
    expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId)
    expect(first.data!.client.instanceId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/u)
    expect(next.data!.client.instanceId).toBe(first.data!.client.instanceId)
    expect(next.data!.snapshot).toBe(first.data!.snapshot)
    expect(projection).toEqual({ current: [], activity: [], unavailableSources: [] })
    dispose()
    expect(await port.read(target, bounds)).toMatchObject({ availability: 'unavailable', data: null })
  } finally { dispose() }
})
