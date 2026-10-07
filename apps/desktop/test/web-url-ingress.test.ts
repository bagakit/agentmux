import { describe, expect, it, vi } from 'vitest'
import { WebUrlIngress, receiveDesktopUrlArguments, receiveDesktopUrl } from '../src/main/web-url-ingress'
import { SpatialLinkIngress } from '../src/main/spatial-link-ingress'
import type { SystemWebUrlRequest, SystemWebUrlResult } from '../src/shared/system-web-url'

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function opened(request: SystemWebUrlRequest): SystemWebUrlResult { return { operation: request.operation, requestId: request.requestId, state: 'opened', browserId: request.requestId, reference: { displayWorkspaceId: 'scratch', groupId: 'G', tabId: 'T', regionId: request.requestId } } }

describe('system web URL ingestion preserves individual page intents', () => {
  it('queues all pre-ready HTTP(S) events in order, including repeated URLs, without another ready replay', async () => {
    const web = new WebUrlIngress(), spatial = new SpatialLinkIngress(), execute = vi.fn(async (request: SystemWebUrlRequest) => opened(request)), report = vi.fn()
    const urls = ['http://first.example.test/?q=a%20b#source', 'https://second.example.test/', 'https://second.example.test/']
    receiveDesktopUrlArguments(spatial, web, ['electron', '--inspect=0', ...urls]); expect(execute).not.toHaveBeenCalled()
    web.ready(execute, report); await tick(); await tick()
    expect(execute.mock.calls.map(([request]) => request.url)).toEqual(urls)
    expect(new Set(execute.mock.calls.map(([request]) => request.requestId)).size).toBe(3)
    web.ready(execute, report); await tick(); expect(execute).toHaveBeenCalledTimes(3); expect(report).not.toHaveBeenCalled()
  })
  it('preserves the original amux owner while rejecting only invalid web requests', async () => {
    const web = new WebUrlIngress(), spatial = new SpatialLinkIngress(), original = vi.spyOn(spatial, 'receive'), execute = vi.fn(async (request: SystemWebUrlRequest) => opened(request)), report = vi.fn()
    receiveDesktopUrl(spatial, web, 'amux://zone/original')
    web.receive('javascript:alert(1)'); web.receive('http://'); web.receive('https://valid.example.test/')
    web.ready(execute, report); await tick()
    expect(original).toHaveBeenCalledExactlyOnceWith('amux://zone/original')
    expect(execute).toHaveBeenCalledTimes(1); expect(report).toHaveBeenCalledTimes(2)
  })
  it('does not replay a consumed interrupted request and retains undispatched requests for the new owner', async () => {
    const web = new WebUrlIngress(), report = vi.fn(), signals: AbortSignal[] = []
    let finish!: (result: SystemWebUrlResult) => void, first!: SystemWebUrlRequest
    const execute = vi.fn((request: SystemWebUrlRequest, signal: AbortSignal) => {
      signals.push(signal); first = request; return new Promise<SystemWebUrlResult>(resolve => { finish = resolve })
    })
    web.ready(execute, report); web.receive('https://first.example.test/'); web.receive('https://second.example.test/'); await tick()
    web.unavailable(); expect(signals[0]!.aborted).toBe(true)
    const next = vi.fn(async (request: SystemWebUrlRequest) => opened(request)); web.ready(next, report); await tick()
    finish(opened(first)); await tick()
    expect(execute).toHaveBeenCalledTimes(1); expect(next).toHaveBeenCalledTimes(1); expect(next.mock.calls[0]![0].url).toBe('https://second.example.test/')
    expect(report).toHaveBeenCalledTimes(1); expect(report.mock.calls[0]![0]).toContain('interrupted before confirmation'); expect(report.mock.calls[0]![0]).toContain('https://first.example.test/'); expect(report.mock.calls[0]![0]).toContain(first.requestId)
  })
  it('reports the original synchronous owner failure and continues the next explicit request', async () => {
    const web = new WebUrlIngress(), report = vi.fn()
    const execute = vi.fn((request: SystemWebUrlRequest): Promise<SystemWebUrlResult> => { if (request.url.includes('first.')) throw new Error('Original owner unavailable'); return Promise.resolve(opened(request)) })
    web.ready(execute, report); web.receive('https://first.example.test/'); web.receive('https://second.example.test/'); await tick(); await tick()
    expect(execute).toHaveBeenCalledTimes(2); expect(report).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Original owner unavailable'))
  })
})

it('keeps the exact failed request address and prepared page locator in its original recovery notice', async () => {
  const web = new WebUrlIngress(), report = vi.fn()
  web.ready(async request => ({ operation: request.operation, requestId: request.requestId, state: 'unconfirmed', browserId: null, reference: { displayWorkspaceId: 'scratch', groupId: 'original-group', tabId: 'prepared-tab', regionId: 'prepared region' }, message: 'Original native creation failed' }), report)
  web.receive('https://failed.example.test/?source=original#fragment'); await tick()
  expect(report).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('https://failed.example.test/?source=original#fragment'))
  expect(report.mock.calls[0]![0]).toContain('amux://region/prepared%20region'); expect(report.mock.calls[0]![0]).toContain('Tab prepared-tab, Group original-group, Workspace scratch')
})
