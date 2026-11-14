import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it, vi } from 'vitest'
import { parseAgentMuxControlRequest, formatAmuxObjectLink, type AgentMuxControlFocusRequest, type AgentMuxControlRequest, type AgentMuxControlResult } from '@agentmux/core'
import { focusFacts } from '../../../packages/core/test/fixtures/desktop-focus-facts'
import { SpatialLinkIngress, receiveSpatialLinkArguments } from '../src/main/spatial-link-ingress'
import type { CapsuleOpenResult } from '@agentmux/core/capsule'
import type { HostLinkPorts } from '../src/main/spatial-link-ingress'
import type { NodeLocateResult } from '@agentmux/core/node-locator'

const space = (spaceId: string) => formatAmuxObjectLink({ kind: 'space', spaceId })
const zone = (zoneId: string) => formatAmuxObjectLink({ kind: 'zone', zoneId })
const settled = async () => { await new Promise(resolve => setImmediate(resolve)) }
const capsuleId = '4JkN7Q2vR8sW'
const capsule = () => formatAmuxObjectLink({ kind: 'capsule', capsuleId })
const capsuleResult = (operationId: string): CapsuleOpenResult => ({ capsuleId, operationId,
  endpoint: { status: 'available', url: 'http://127.0.0.1:43879/', instanceId: '3LkM7P2vR8sQ' },
  rendering: { status: 'available', browserId: 'original-browser', tabId: 'original-tab', regionId: 'original-region' } })
function ports() {
  const requests: AgentMuxControlFocusRequest[] = [], signals: AbortSignal[] = []
  const execute = vi.fn(async (request: AgentMuxControlRequest, signal: AbortSignal): Promise<AgentMuxControlResult> => {
    if (request.operation !== 'focus') throw new Error('Expected an exact focus request.')
    expect(parseAgentMuxControlRequest(request)).toEqual(request)
    requests.push(request); signals.push(signal)
    return { ...focusFacts(request), navigation: { ...focusFacts(request).navigation,
      ...(request.expectedAgentSessionId === undefined ? {} : { expectedAgentSessionId: request.expectedAgentSessionId }),
      ...(request.expectedAgentHostId === undefined ? {} : { expectedAgentHostId: request.expectedAgentHostId }) }, presentation: { provenance: 'observed' as const, state: 'main-visible' as const,
      tabId: null, regionId: null, blockers: [] } }
  })
  return { requests, signals, execute, report: vi.fn() }
}
describe('the single native spatial link ingress', () => {
  it('opens the exact cold Capsule once through its original owner without a parallel generic focus', async () => {
    const ingress = new SpatialLinkIngress(), p = ports()
    const open = vi.fn(async (id: string, operationId: string) => {
      expect(id).toBe(capsuleId)
      expect(operationId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
      return capsuleResult(operationId)
    })
    ingress.receive(capsule()); expect(open).not.toHaveBeenCalled()
    ingress.ready(p.execute, p.report, open); await settled()
    expect(open).toHaveBeenCalledTimes(1); expect(p.execute).not.toHaveBeenCalled(); expect(p.report).not.toHaveBeenCalled()
    ingress.unavailable(); ingress.ready(p.execute, p.report, open); await settled()
    expect(open).toHaveBeenCalledTimes(1)
  })
  it('reports the original Capsule operation when its actual rendering receipt is unavailable without reopening', async () => {
    const ingress = new SpatialLinkIngress(), p = ports()
    let originalOperation = ''
    const open = vi.fn(async (_id: string, operationId: string): Promise<CapsuleOpenResult> => {
      originalOperation = operationId
      return { ...capsuleResult(operationId), rendering: { status: 'unavailable', reason: 'The native document is unconfirmed.' } }
    })
    ingress.ready(p.execute, p.report, open); const opening = ingress.receive(capsule()); await settled()
    expect(p.report).toHaveBeenCalledTimes(1)
    expect(p.report.mock.calls[0]![0]).toContain(originalOperation)
    expect(p.report.mock.calls[0]![0]).toContain('native document is unconfirmed')
    await expect(opening).resolves.toBe(p.report.mock.calls[0]![0])
    expect(p.execute).not.toHaveBeenCalled()
    ingress.ready(p.execute, p.report, open); await settled(); expect(open).toHaveBeenCalledTimes(1)
  })
  it.each(['capsuleId', 'operationId'] as const)('rejects another Capsule owner %s without certifying the requested object', async field => {
    const ingress = new SpatialLinkIngress(), p = ports()
    const open = vi.fn(async (_id: string, operationId: string) => ({ ...capsuleResult(operationId), [field]: '6JkP7Q2vR8sX' }))
    ingress.ready(p.execute, p.report, open); ingress.receive(capsule()); await settled()
    expect(open).toHaveBeenCalledTimes(1); expect(p.execute).not.toHaveBeenCalled()
    expect(p.report).toHaveBeenCalledTimes(1)
    expect(p.report.mock.calls[0]![0]).toContain('another object or operation')
  })
  it('ignores a late Capsule receipt after a newer object link without replaying either original operation', async () => {
    const ingress = new SpatialLinkIngress(), p = ports()
    let finish!: (value: CapsuleOpenResult) => void, originalOperation = '', originalSignal!: AbortSignal
    const open = vi.fn(async (_id: string, operationId: string, signal: AbortSignal) => {
      originalOperation = operationId; originalSignal = signal
      return await new Promise<CapsuleOpenResult>(resolve => { finish = resolve })
    })
    ingress.ready(p.execute, p.report, open); ingress.receive(capsule()); ingress.receive(zone('newer')); await settled()
    expect(originalSignal.aborted).toBe(true)
    finish({ ...capsuleResult(originalOperation), rendering: { status: 'unavailable', reason: 'Old response.' } }); await settled()
    expect(p.requests.map(request => request.target)).toEqual([{ kind: 'space', zoneId: 'newer' }])
    expect(open).toHaveBeenCalledTimes(1); expect(p.report).not.toHaveBeenCalled()
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
    ingress.receive(zone('valid-but-old')); ingress.receive('amux://run/unconfirmed-route')
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
    ingress.ready(p.execute, p.report); const opening = ingress.receive(space('original')); await settled()
    expect(p.execute).toHaveBeenCalledTimes(1)
    expect(p.report.mock.calls[0]![0]).toContain('Navigation: applied; presentation: unknown')
    expect(p.report.mock.calls[0]![0]).toContain('healthy Agents are kept')
    await expect(opening).resolves.toBe(p.report.mock.calls[0]![0])
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
  expect(p.report.mock.calls[0]![0]).toContain('retry the exact object link')
  finish(focusFacts(original)); await settled()
  ingress.ready(p.execute, p.report); await settled()
  expect(p.execute).toHaveBeenCalledTimes(1); expect(p.report).toHaveBeenCalledTimes(1)
})


function agentCatalog(locations: number) {
  return { spaces: [], zones: [], tabs: [], bindings: [],
    regions: [{ regionId: 'R', tabId: 'T', kind: 'agent' as const, agentSessionId: 'original SID', runId: 'original-run', execution: { hostId: 'local', cwd: _hygiene_fixturePath("original") } }],
    locations: Array.from({ length: locations }, (_, index) => ({ regionId: 'R', tabId: 'T', groupId: 'G' + index,
      workspaceId: 'execution-workspace', displayWorkspaceId: 'display-workspace', spaceId: null, zoneId: null })) }
}

function located(hostId = 'remote-b', runtimeId = 'original-runtime', hostIds = [hostId]): NodeLocateResult {
  return { status: 'unique', issues: [], matches: [{ hostId, hostIds, publication: {
    node: { runtimeId, ownerInstanceId: 'owner-instance', alias: 'studio' }, policyRevision: 'original-revision',
    resourcesShared: false, roots: [], landing: null } }] }
}
function hostPorts(result = located()): HostLinkPorts {
  return { locate: vi.fn(async () => result), openCapsule: vi.fn(async input => capsuleResult(input.operationId)) }
}

it('opens the resolved Host resource page through exact Settings navigation, preserving input', async () => {
  const ingress = new SpatialLinkIngress(), p = ports(), host = hostPorts()
  p.execute.mockImplementation(async request => {
    if (request.operation !== 'focus' || request.target.kind !== 'settings') throw Error('Expected original Settings navigation')
    expect(parseAgentMuxControlRequest(request)).toEqual(request)
    expect(request.target).toEqual({ kind: 'settings', sectionId: 'hosts', hostId: 'remote-b' })
    expect(request.inputPolicy).toBe('preserve')
    const facts = focusFacts(request)
    return { ...facts, overlays: { ...facts.overlays, settings: true, settingsPage: {
      sectionIds: ['hosts'], sectionId: 'hosts', visible: true, hostId: 'remote-b' } } }
  })
  ingress.ready(p.execute, p.report, undefined, host)
  await expect(ingress.receive('amux://host/studio?runtime=original-runtime')).resolves.toBeNull()
  expect(host.locate).toHaveBeenCalledWith({ alias: 'studio', expectedRuntimeId: 'original-runtime' }, expect.any(AbortSignal))
  expect(p.execute).toHaveBeenCalledTimes(1); expect(host.openCapsule).not.toHaveBeenCalled()
})

it('filters same-SID display candidates by confirmed original Runtime carriers and retains a Host condition', async () => {
  const ingress = new SpatialLinkIngress(), p = ports(), host = hostPorts()
  p.execute.mockImplementationOnce(async () => {
    const catalog = agentCatalog(1), original = catalog.regions[0]!, location = catalog.locations[0]!
    return { operation: 'space.ls', catalog: { ...catalog,
      regions: [original, { ...original, regionId: 'remote-region', execution: { hostId: 'remote-b', cwd: '/work' } }],
      locations: [location, { ...location, regionId: 'remote-region' }] } }
  })
  ingress.ready(p.execute, p.report, undefined, host)
  await expect(ingress.receive('amux://host/studio/agent/original%20SID?runtime=original-runtime')).resolves.toBeNull()
  expect(p.requests).toHaveLength(1)
  expect(p.requests[0]).toMatchObject({ target: { regionId: 'remote-region' }, expectedAgentSessionId: 'original SID', expectedAgentHostId: 'remote-b' })
  expect(host.openCapsule).not.toHaveBeenCalled()
})

it.each(['local', 'remote-b'])('opens the original %s Capsule without replacing its storage namespace', async hostId => {
  const ingress = new SpatialLinkIngress(), p = ports(), host = hostPorts(located(hostId, 'original-runtime', hostId === 'local' ? ['ssh-self', 'local'] : [hostId]))
  const local = vi.fn(async (_id: string, operationId: string) => capsuleResult(operationId))
  ingress.ready(p.execute, p.report, local, host)
  await expect(ingress.receive(`amux://host/studio/capsule/${capsuleId}?runtime=original-runtime`)).resolves.toBeNull()
  expect(local).toHaveBeenCalledTimes(hostId === 'local' ? 1 : 0)
  expect(host.openCapsule).toHaveBeenCalledTimes(hostId === 'local' ? 0 : 1)
  if (hostId !== 'local') expect(host.openCapsule).toHaveBeenCalledWith({ hostId, expectedRuntimeId: 'original-runtime', capsuleId, operationId: expect.any(String),
    objectLink: `amux://host/studio/capsule/${capsuleId}?runtime=original-runtime` }, expect.any(AbortSignal))
  expect(p.execute).not.toHaveBeenCalled()
})

it.each(['ambiguous', 'unconfirmed', 'missing', 'wrong-runtime'] as const)('keeps original work for %s Node location without a fallback or new object', async status => {
  const ingress = new SpatialLinkIngress(), p = ports(), result = located()
  if (status === 'ambiguous') { result.status = status; result.matches.push(located('remote-c', 'another-runtime').matches[0]!) }
  else if (status === 'unconfirmed') { result.status = status; result.issues.push({ hostId: 'remote-c', code: 'NODE_UNAVAILABLE', message: 'Original observation unavailable' }); result.matches = [] }
  else if (status === 'missing') { result.status = status; result.matches = [] }
  else result.matches[0]!.publication.node.runtimeId = 'wrong-runtime'
  const host = hostPorts(result), local = vi.fn()
  ingress.ready(p.execute, p.report, local, host)
  expect(await ingress.receive(`amux://host/studio/capsule/${capsuleId}${status === 'ambiguous' ? '' : '?runtime=original-runtime'}`)).toContain('workface is kept')
  expect(p.execute).not.toHaveBeenCalled(); expect(host.openCapsule).not.toHaveBeenCalled(); expect(local).not.toHaveBeenCalled()
})

it('cancels only an old Node lookup when a later native URL arrives', async () => {
  const ingress = new SpatialLinkIngress(), p = ports(), host = hostPorts()
  let finish!: (result: NodeLocateResult) => void
  host.locate = vi.fn(async () => await new Promise(resolve => { finish = resolve }))
  ingress.ready(p.execute, p.report, undefined, host)
  const first = ingress.receive('amux://host/studio'); const second = ingress.receive(zone('newer'))
  expect(await first).toContain('superseded')
  finish(located()); await expect(second).resolves.toBeNull(); await settled()
  expect(p.requests.map(request => request.target)).toEqual([{ kind: 'space', zoneId: 'newer' }])
  expect(host.openCapsule).not.toHaveBeenCalled()
})

it.each(['cold', 'warm'])('opens a %s Agent link at its one exact position with an original SID condition', async mode => {
  const ingress = new SpatialLinkIngress(), p = ports()
  p.execute.mockImplementationOnce(async request => {
    expect(request.operation).toBe('space.ls')
    return { operation: 'space.ls', catalog: agentCatalog(1) }
  })
  if (mode === 'warm') ingress.ready(p.execute, p.report)
  ingress.receive('amux://agent/original%20SID')
  if (mode === 'cold') { expect(p.execute).not.toHaveBeenCalled(); ingress.ready(p.execute, p.report) }
  await settled()
  expect(p.requests).toHaveLength(1)
  expect(p.requests[0]).toMatchObject({ operation: 'focus', inputPolicy: 'preserve', expectedAgentSessionId: 'original SID',
    target: { kind: 'space', regionId: 'R', tabId: 'T', displayWorkspaceId: 'display-workspace', groupId: 'G0' } })
  expect(p.execute).toHaveBeenCalledTimes(2)
  expect(p.report).not.toHaveBeenCalled()
})

it.each([0, 2])('keeps the current workface for %i Agent display candidates without guessing or replacing a Session', async count => {
  const ingress = new SpatialLinkIngress(), p = ports()
  p.execute.mockImplementationOnce(async () => ({ operation: 'space.ls', catalog: agentCatalog(count) }))
  ingress.ready(p.execute, p.report); ingress.receive('amux://agent/original%20SID'); await settled()
  expect(p.execute).toHaveBeenCalledTimes(1)
  expect(p.requests).toEqual([])
  expect(p.report).toHaveBeenCalledTimes(1)
  expect(p.report.mock.calls[0]![0]).toContain(`${count} confirmed display candidates`)
  expect(p.report.mock.calls[0]![0]).toContain("amux agent inspect --session='original SID'")
  expect(p.report.mock.calls[0]![0]).toContain('existence and health are not determined')
  if (count === 2) {
    expect(p.report.mock.calls[0]![0]).toContain('G0')
    expect(p.report.mock.calls[0]![0]).toContain('G1')
  }
})

it.each([{ kind: 'region' as const, regionId: 'exact/region' }, { kind: 'tab' as const, tabId: 'exact/tab' }])('opens an exact $kind link without converting it to an Agent identity', async target => {
  const ingress = new SpatialLinkIngress(), p = ports(); ingress.ready(p.execute, p.report)
  ingress.receive(formatAmuxObjectLink(target)); await settled()
  const { kind, ...selector } = target
  expect(p.requests.map(request => request.target)).toEqual([{ kind: 'space', ...selector }])
  expect(p.requests[0]!.expectedAgentSessionId).toBeUndefined()
  expect(p.execute).toHaveBeenCalledTimes(1)
})

it('does not focus an old Agent location when a newer intent arrives during discovery', async () => {
  const ingress = new SpatialLinkIngress(), p = ports()
  let finish!: (result: AgentMuxControlResult) => void
  let discoverySignal!: AbortSignal
  p.execute.mockImplementationOnce(async (_request, signal) => {
    discoverySignal = signal
    return await new Promise(resolve => { finish = resolve })
  })
  ingress.ready(p.execute, p.report); ingress.receive('amux://agent/original%20SID')
  ingress.receive(zone('newer')); await settled()
  expect(discoverySignal.aborted).toBe(true)
  finish({ operation: 'space.ls', catalog: agentCatalog(1) }); await settled()
  expect(p.requests.map(request => request.target)).toEqual([{ kind: 'space', zoneId: 'newer' }])
  expect(p.execute).toHaveBeenCalledTimes(2)
  expect(p.report).not.toHaveBeenCalled()
})

describe('each original opening completes independently', () => {
  it('resolves a malformed cold request with its own diagnostic while Main reporting waits for readiness', async () => {
    const ingress = new SpatialLinkIngress(), p = ports()
    const issue = await ingress.receive('amux://agent/not-exact?query=1')
    expect(issue).toContain('Your current workface is kept')
    expect(p.report).not.toHaveBeenCalled(); expect(p.execute).not.toHaveBeenCalled()
    ingress.ready(p.execute, p.report)
    expect(p.report).toHaveBeenCalledExactlyOnceWith(issue)
  })

  it('settles a superseded cold request once and executes only the still-pending exact request', async () => {
    const ingress = new SpatialLinkIngress(), p = ports(), firstDone = vi.fn(), nextDone = vi.fn()
    const first = ingress.receive(zone('first')).then(firstDone)
    const next = ingress.receive(zone('next')).then(nextDone)
    await settled()
    expect(firstDone).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('superseded'))
    await first
    expect(nextDone).not.toHaveBeenCalled(); expect(p.execute).not.toHaveBeenCalled()
    ingress.unavailable(); expect(nextDone).not.toHaveBeenCalled()
    ingress.ready(p.execute, p.report); await next
    expect(nextDone).toHaveBeenCalledExactlyOnceWith(null)
    expect(p.requests.map(request => request.target)).toEqual([{ kind: 'space', zoneId: 'next' }])
    ingress.ready(p.execute, p.report); await settled()
    expect(p.execute).toHaveBeenCalledTimes(1); expect(p.report).not.toHaveBeenCalled()
  })

  it('settles supersession immediately without waiting for the old owner and ignores its later rejection', async () => {
    const ingress = new SpatialLinkIngress(), p = ports(), firstDone = vi.fn()
    let fail!: (error: Error) => void
    p.execute.mockImplementationOnce(async (_request, signal) => {
      p.signals.push(signal)
      return await new Promise<AgentMuxControlResult>((_resolve, reject) => { fail = reject })
    })
    ingress.ready(p.execute, p.report)
    const first = ingress.receive(zone('first')).then(firstDone)
    const next = ingress.receive(zone('next'))
    await settled()
    expect(firstDone).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('superseded'))
    await first; await expect(next).resolves.toBeNull()
    expect(p.signals[0]!.aborted).toBe(true)
    fail(new Error('Late old-owner failure')); await settled()
    expect(firstDone).toHaveBeenCalledTimes(1); expect(p.report).not.toHaveBeenCalled()
  })

  it('settles an interrupted execution once and never replays it after the renderer returns', async () => {
    const ingress = new SpatialLinkIngress(), p = ports(), done = vi.fn()
    let fail!: (error: Error) => void
    p.execute.mockImplementationOnce(async (_request, signal) => {
      p.signals.push(signal)
      return await new Promise<AgentMuxControlResult>((_resolve, reject) => { fail = reject })
    })
    ingress.ready(p.execute, p.report)
    const opening = ingress.receive(zone('original')).then(done)
    ingress.unavailable(); await opening
    expect(done).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('interrupted before confirmation'))
    expect(p.signals[0]!.aborted).toBe(true)
    ingress.ready(p.execute, p.report)
    expect(p.report).toHaveBeenCalledExactlyOnceWith(done.mock.calls[0]![0])
    fail(new Error('Late interrupted failure')); await settled()
    expect(done).toHaveBeenCalledTimes(1); expect(p.execute).toHaveBeenCalledTimes(1)
    await expect(ingress.receive(zone('explicit-retry'))).resolves.toBeNull()
    expect(p.requests.map(request => request.target)).toEqual([{ kind: 'space', zoneId: 'explicit-retry' }])
  })

  it('keeps a reporting failure separate from the original diagnostic and does not reject fire-and-forget consumers', async () => {
    const ingress = new SpatialLinkIngress(), p = ports(), unavailableReport = vi.fn(() => { throw new Error('Renderer reporting unavailable') })
    ingress.ready(p.execute, unavailableReport)
    const issue = await ingress.receive('amux://agent/broken?query=1')
    expect(issue).toContain('Your current workface is kept')
    ingress.ready(p.execute, p.report)
    expect(p.report).toHaveBeenCalledExactlyOnceWith(issue)
    p.execute.mockRejectedValueOnce(new Error('Original focus owner unavailable'))
    void ingress.receive(zone('fire-and-forget'))
    await settled()
    expect(p.report).toHaveBeenLastCalledWith(expect.stringContaining('Original focus owner unavailable'))
    await expect(ingress.receive(zone('healthy-retry'))).resolves.toBeNull()
  })
})

it('routes Mote and original thread URIs through the same exact typed logical focus without guessing an Agent', async () => {
  const ingress = new SpatialLinkIngress(), p = ports()
  const id = JSON.stringify(['resource-host', 'original-mote-identity'])
  ingress.ready(p.execute, p.report)
  await expect(ingress.receive(formatAmuxObjectLink({ kind: 'mote', spaceId: id }))).resolves.toBeNull()
  await expect(ingress.receive(formatAmuxObjectLink({ kind: 'mote', spaceId: id, eventId: 'original/event?scope' }))).resolves.toBeNull()
  expect(p.requests.map(request => request.target)).toEqual([{ kind: 'mote', spaceId: id }, { kind: 'mote', spaceId: id, eventId: 'original/event?scope' }])
  expect(p.requests.every(request => request.inputPolicy === 'preserve')).toBe(true)
  expect(p.execute).toHaveBeenCalledTimes(2)
})
it('retains unknown Mote navigation and original event without another location discovery or replacement', async () => {
  const ingress = new SpatialLinkIngress(), p = ports()
  p.execute.mockImplementationOnce(async request => {
    if (request.operation !== 'focus') throw new Error('Expected focus')
    const value = focusFacts(request)
    return { ...value, navigation: { ...value.navigation, state: 'unconfirmed' }, issues: [{ step: 'presentation', code: 'MOTE_PRESENTATION_UNCONFIRMED', message: 'The original event is unavailable.', recovery: 'Read that same original event.' }] }
  })
  ingress.ready(p.execute, p.report)
  const uri = formatAmuxObjectLink({ kind: 'mote', spaceId: 'exact-mote', eventId: 'original-event' })
  expect(await ingress.receive(uri)).toContain('MOTE_PRESENTATION_UNCONFIRMED')
  expect(p.execute).toHaveBeenCalledTimes(1)
  expect(p.execute.mock.calls[0]![0]).toMatchObject({ target: { kind: 'mote', spaceId: 'exact-mote', eventId: 'original-event' } })
  ingress.ready(p.execute, p.report); await settled(); expect(p.execute).toHaveBeenCalledTimes(1)
})
