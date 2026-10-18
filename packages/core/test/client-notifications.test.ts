import { describe, expect, it, vi } from 'vitest'
import { unavailableDiagnosticEvidence } from '@agentmux/diagnostic-evidence'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from '../src/control-codec.js'
import { assertControlResultTarget } from '../src/rpc-business-codec.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, agentMuxControlTimeoutMs } from '../src/control.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { parseDiagnosticEvidenceParams, parseDiagnosticEvidenceResult } from '../src/diagnostic-evidence-codec.js'
import { parseClientNotificationsObservation, type AgentMuxClientNotificationsEvidence, type AgentMuxClientNotificationsTarget } from '../src/client-notifications.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const notificationId = `sha256:${'1'.repeat(64)}`, version = `sha256:${'2'.repeat(64)}`, snapshot = `sha256:${'3'.repeat(64)}`
const target: AgentMuxClientNotificationsTarget = { domain: 'client.notifications', hostId: 'local', list: {} }
const evidence = (raw = false): AgentMuxClientNotificationsEvidence => ({
  kind: 'client-notifications', client: { instanceId: 'original-document' }, snapshot, total: 1, nextCursor: null,
  coverage: { state: 'available', unavailableSources: [] }, omissions: [], items: [{ notificationId, version, source: 'sessions',
    section: 'current', category: 'agents', level: 'indeterminate', unread: true, subject: { kind: 'agent', hostId: 'original-host', agentSessionId: 'original-session' },
    observedAt: null, occurrences: null, original: raw ? { title: 'Original private title', detail: 'Original private cause' } : null }],
})
const observation = (query = target, raw = false) => ({ schema: 'agentmux.client-notifications.v1' as const, target: query,
  availability: 'found' as const, data: evidence(raw), raw: { retention: 'retained' as const, returned: raw ? 'included' as const : 'withheld' as const, truncated: null }, issue: null })

describe('client notifications public diagnostic boundary', () => {
  it('routes default, filtered and exact CLI queries through the existing diagnostic method', async () => {
    const args = ['system', 'diagnostics', 'inspect', '--domain', 'client.notifications', '--host-id', 'local']
    expect(await parseAgentMuxCliInvocation(args)).toMatchObject({ command: { method: 'system.diagnostics.inspect' }, params: { target, includeRaw: false } })
    expect((await parseAgentMuxCliInvocation([...args, '--section', 'activity', '--category', 'operations', '--unread', '--limit', '8', '--cursor', 'original_page'])).params)
      .toMatchObject({ target: { list: { section: 'activity', category: 'operations', unreadOnly: true, limit: 8, cursor: 'original_page' } } })
    expect((await parseAgentMuxCliInvocation([...args, '--notification-id', notificationId, '--include-raw'])).params)
      .toMatchObject({ target: { notificationId }, includeRaw: true })
    for (const extra of [['--recent'], ['--logid', 'original'], ['--notification-id', notificationId, '--unread'], ['--limit', '0'], ['--category', 'invented']])
      await expect(parseAgentMuxCliInvocation([...args, ...extra])).rejects.toThrow()
    await expect(parseAgentMuxCliInvocation(['system', 'diagnostics', 'inspect', '--domain', 'client.incident', '--host-id', 'local', '--recent', '--unread'])).rejects.toThrow()
  })
  it('keeps the internal client envelope separate from inspect.client and rejects wrong target and raw leakage', () => {
    const request = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'query', operation: 'inspect.notifications' as const, target, includeRaw: false, maxBytes: 8192 }
    expect(parseAgentMuxControlRequest(request)).toEqual(request)
    expect(agentMuxControlTimeoutMs(request.operation)).toBeGreaterThan(0)
    expect(parseAgentMuxControlReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'query', ok: true,
      operation: 'inspect.notifications', result: { observation: observation() } })).toMatchObject({ ok: true })
    expect(() => parseClientNotificationsObservation(observation(), { ...target, hostId: 'other' }, false)).toThrow()
    expect(() => assertControlResultTarget(request, { operation: 'inspect.notifications', observation: observation({ ...target, hostId: 'other' }) })).toThrow()
    expect(() => assertControlResultTarget(request, { operation: 'inspect.notifications', observation: observation(target, true) })).toThrow()
    expect(() => parseClientNotificationsObservation(observation(target, true), target, false)).toThrow()
    const extra = observation(); Object.assign(extra.data.items[0]!.subject, { path: new URL("private/source", new URL('/', import.meta.url)).pathname })
    expect(() => parseClientNotificationsObservation(extra, target, false)).toThrow()
    expect(() => parseAgentMuxControlRequest({ ...request, includeRaw: 'yes' })).toThrow()
  })
  it('does not accept a stale cursor or an absent reader as a successful empty inbox', () => {
    const expired = { schema: 'agentmux.client-notifications.v1', target: { ...target, list: { cursor: 'old' } }, availability: 'expired', data: null,
      raw: { retention: 'unknown', returned: 'unavailable', truncated: null }, issue: null }
    expect(parseClientNotificationsObservation(expired, expired.target, false).availability).toBe('expired')
    expect(() => parseClientNotificationsObservation({ ...expired, target }, target, false)).toThrow()
    expect(() => parseClientNotificationsObservation({ ...expired, availability: 'found' }, expired.target, false)).toThrow()
    const partial = observation(); partial.data.coverage = { state: 'partial', unavailableSources: ['runtime-endpoints'] }
    expect(parseClientNotificationsObservation(partial, target, false).data?.coverage.state).toBe('partial')
    expect(() => parseDiagnosticEvidenceParams({ target: { domain: 'client.notifications', hostId: 'local', list: {}, notificationId } })).toThrow()
  })
  it('discovers only actual readers, passes raw intent and retains the injected owner facts', async () => {
    const read = vi.fn(async (query: AgentMuxClientNotificationsTarget, bounds: { includeRaw: boolean }) => ({
      ...unavailableDiagnosticEvidence<AgentMuxClientNotificationsTarget, AgentMuxClientNotificationsEvidence>(query, 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE'),
      availability: 'found' as const, data: evidence(bounds.includeRaw), scope: 'point-observation' as const, completeness: 'complete' as const,
      raw: { retention: 'retained' as const, returned: bounds.includeRaw ? 'included' as const : 'withheld' as const, truncated: null }, issue: null,
    }))
    const service = new AgentMuxRpcService({ clientNotifications: { hostId: 'local', read } })
    try {
      const discovery = await service.call('system.diagnostics.inspect', {})
      expect(discovery.capabilities.filter(item => item.domain === 'client.notifications').map(item => item.target)).toEqual(['notification-list', 'notification-id'])
      expect(read).not.toHaveBeenCalled()
      const safe = await service.call('system.diagnostics.inspect', { target })
      expect(safe.reads[0]?.data).toEqual(evidence()); expect(JSON.stringify(safe)).not.toContain('Original private')
      expect(() => parseDiagnosticEvidenceResult(safe, { target })).not.toThrow()
      const raw = await service.call('system.diagnostics.inspect', { target, includeRaw: true })
      expect(raw.reads[0]?.data).toEqual(evidence(true)); expect(read).toHaveBeenCalledTimes(2)
      expect(() => parseDiagnosticEvidenceResult(raw, { target, includeRaw: true })).not.toThrow()
      expect(() => parseDiagnosticEvidenceResult(raw, { target })).toThrow()
      const wrong = structuredClone(raw); if (wrong.reads[0]?.data?.kind === 'client-notifications') wrong.reads[0].data.items[0]!.category = 'system'
      expect(() => parseDiagnosticEvidenceResult(wrong, { target: { ...target, list: { category: 'agents' } }, includeRaw: true })).toThrow()
    } finally { await service.dispose() }
    const absent = new AgentMuxRpcService({})
    try {
      expect((await absent.call('system.diagnostics.inspect', {})).capabilities.some(item => item.domain === 'client.notifications')).toBe(false)
      expect((await absent.call('system.diagnostics.inspect', { target })).reads[0]?.availability).toBe('unsupported')
    } finally { await absent.dispose() }
  })
  it('retains managed Host authorization and a healthy Agent when the notification source is forbidden', async () => {
    const original = await rpcOwnerFixture(), read = vi.fn()
    const service = new AgentMuxRpcService({ coreClients: original.coreClients, clientNotifications: { hostId: 'other', read } })
    try {
      const result = await service.call('system.diagnostics.inspect', { target: { ...target, hostId: 'other' } }, { caller: original.credentials })
      expect(result.reads[0]?.availability).toBe('forbidden'); expect(read).not.toHaveBeenCalled()
      expect(await service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'caller' } }, { caller: original.credentials })).toBeDefined()
      expect(original.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await service.dispose(); await original.close() }
  })
})
