import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it, vi } from 'vitest'
import { parseAgentMuxControlRequest, formatAmuxSpatialLink, type AgentMuxControlFocusRequest, type AgentMuxControlRequest, type AgentMuxControlResult } from '@agentmux/core'
import { focusFacts } from '../../../packages/core/test/fixtures/desktop-focus-facts'
import { SpatialLinkIngress, receiveSpatialLinkArguments } from '../src/main/spatial-link-ingress'
import { assertSenderTrusted, senderTrust } from '../src/main/ipc-sender-trust'

const space = (spaceId: string) => formatAmuxSpatialLink({ kind: 'space', spaceId })
const zone = (zoneId: string) => formatAmuxSpatialLink({ kind: 'zone', zoneId })
const settled = async () => { await new Promise(resolve => setImmediate(resolve)) }
function ports() {
  const requests: AgentMuxControlFocusRequest[] = [], signals: AbortSignal[] = []
  const execute = vi.fn(async (request: AgentMuxControlRequest, signal: AbortSignal): Promise<AgentMuxControlResult> => {
    if (request.operation !== 'focus') throw new Error('Expected an exact focus request.')
    expect(parseAgentMuxControlRequest(request)).toEqual(request)
    requests.push(request); signals.push(signal)
    return { ...focusFacts(request), presentation: { provenance: 'observed' as const, state: 'main-visible' as const,
      tabId: null, regionId: null, blockers: [] } }
  })
  return { requests, signals, execute, report: vi.fn() }
}
describe('the single native spatial link ingress', () => {
  it('keeps readiness behind the original trusted sender owner', () => {
    const original = { frame: 'original' }
    expect(() => assertSenderTrusted(senderTrust('ui:spatialLinksReady', original, original))).not.toThrow()
    expect(() => assertSenderTrusted(senderTrust('ui:spatialLinksReady', { ...original }, original))).toThrow('Untrusted spatial link readiness sender')
  })
  it('waits for actual renderer initialization, dispatches the latest cold URL once through typed focus, and preserves input', async () => {
    const ingress = new SpatialLinkIngress(), p = ports()
    receiveSpatialLinkArguments(ingress, [_hygiene_fixturePath("electron"), '--inspect=0', zone('older'), _hygiene_fixturePath("some/file"), space(JSON.stringify(["host", _hygiene_fixturePath("工作")]))])
    expect(p.execute).not.toHaveBeenCalled()
    ingress.ready(p.execute, p.report); await settled()
    expect(p.requests.map(request => request.target)).toEqual([{ kind: 'space', spaceId: JSON.stringify(["host", _hygiene_fixturePath("工作")]) }])
    expect(p.requests[0]!.inputPolicy).toBe('preserve')
    ingress.ready(p.execute, p.report); await settled(); expect(p.execute).toHaveBeenCalledTimes(1)
  })
  it('opens each warm exact Zone without retaining its former parent Category', async () => {
    const ingress = new SpatialLinkIngress(), p = ports(); ingress.ready(p.execute, p.report)
    ingress.receive(zone('original-zone')); await settled()
    receiveSpatialLinkArguments(ingress, [_hygiene_fixturePath("electron"), zone('original-zone')]); await settled()
    expect(p.requests.map(request => request.target)).toEqual([{ kind: 'space', zoneId: 'original-zone' }, { kind: 'space', zoneId: 'original-zone' }])
    expect(p.requests[0]!.requestId).not.toBe(p.requests[1]!.requestId)
  })
  it('rejects a malformed or unsupported URI and reports recovery without executing it or losing the current workface', async () => {
    const ingress = new SpatialLinkIngress(), p = ports()
    ingress.receive(zone('valid-but-old')); ingress.receive('amux://agent/unconfirmed-route')
    ingress.ready(p.execute, p.report); await settled()
    expect(p.execute).not.toHaveBeenCalled(); expect(p.report).toHaveBeenCalledTimes(1)
    expect(p.report.mock.calls[0]![0]).toContain('current workface is kept')
    ingress.receive('amux://zone/Z?command=kill'); await settled(); expect(p.execute).not.toHaveBeenCalled()
  })
  it('aborts an earlier in-flight intent, ignores its late errors and never replays a consumed request after renderer reload', async () => {
    const ingress = new SpatialLinkIngress(), p = ports()
    let fail!: (reason: Error) => void
    p.execute.mockImplementationOnce(async (request, signal) => {
      if (request.operation !== 'focus') throw new Error('Expected focus')
      p.requests.push(request); p.signals.push(signal)
      return await new Promise((_resolve, reject) => { fail = reject })
    })
    ingress.ready(p.execute, p.report); ingress.receive(zone('old')); ingress.receive(zone('new')); await settled()
    expect(p.signals[0]!.aborted).toBe(true); fail(new Error('stale error')); await settled(); expect(p.report).not.toHaveBeenCalled()
    ingress.unavailable(); ingress.ready(p.execute, p.report); await settled(); expect(p.execute).toHaveBeenCalledTimes(2)
    ingress.unavailable(); ingress.receive(space('pending-after-reload')); expect(p.execute).toHaveBeenCalledTimes(2)
    ingress.ready(p.execute, p.report); await settled(); expect(p.requests.at(-1)!.target).toEqual({ kind: 'space', spaceId: 'pending-after-reload' })
  })
  it('retains the original resolver candidates and reports unknown navigation without guessing a Space', async () => {
    const ingress = new SpatialLinkIngress(), p = ports()
    p.execute.mockImplementationOnce(async request => {
      if (request.operation !== 'focus') throw new Error('Expected focus')
      const result = focusFacts(request)
      return { ...result, navigation: { ...result.navigation, state: 'rejected' }, issues: [{ step: 'navigation', code: 'SPACE_LOCATION_REQUIRED',
        message: 'Choose the exact Space reference.', recovery: 'Inspect and retry with an exact Space.', candidates: [{ spaceId: 'work', zoneId: 'Z' }, { spaceId: 'ideas', zoneId: 'Z' }] }] }
    })
    ingress.ready(p.execute, p.report); ingress.receive(zone('Z')); await settled()
    expect(p.report).toHaveBeenCalledTimes(1)
    expect(p.report.mock.calls[0]![0]).toContain('SPACE_LOCATION_REQUIRED')
    expect(p.report.mock.calls[0]![0]).toContain('"spaceId":"work"'); expect(p.report.mock.calls[0]![0]).toContain('"spaceId":"ideas"')
    expect(p.execute).toHaveBeenCalledTimes(1)
  })
  it('keeps applied selection available while reporting an unconfirmed presentation', async () => {
    const ingress = new SpatialLinkIngress(), p = ports()
    p.execute.mockImplementationOnce(async request => {
      if (request.operation !== 'focus') throw new Error('Expected focus')
      return focusFacts(request)
    })
    ingress.ready(p.execute, p.report); ingress.receive(space('original')); await settled()
    expect(p.execute).toHaveBeenCalledTimes(1)
    expect(p.report.mock.calls[0]![0]).toContain('Navigation: applied; presentation: unknown')
    expect(p.report.mock.calls[0]![0]).toContain('healthy Agents are kept')
  })
})

it('reports an interrupted original link once on readiness without replaying the consumed intent', async () => {
  const ingress = new SpatialLinkIngress(), p = ports()
  let finish!: (result: AgentMuxControlResult) => void
  let original!: AgentMuxControlFocusRequest
  p.execute.mockImplementationOnce(async (request, signal) => {
    if (request.operation !== 'focus') throw new Error('Expected focus')
    original = request; p.signals.push(signal)
    return await new Promise(resolve => { finish = resolve })
  })
  ingress.ready(p.execute, p.report); ingress.receive(zone('interrupted-original'))
  ingress.unavailable(); expect(p.signals[0]!.aborted).toBe(true)
  ingress.ready(p.execute, p.report); await settled()
  expect(p.report).toHaveBeenCalledTimes(1); expect(p.report.mock.calls[0]![0]).toContain('interrupted before confirmation')
  expect(p.report.mock.calls[0]![0]).toContain('retry the exact Space or Zone link')
  finish(focusFacts(original)); await settled()
  ingress.ready(p.execute, p.report); await settled()
  expect(p.execute).toHaveBeenCalledTimes(1); expect(p.report).toHaveBeenCalledTimes(1)
})
