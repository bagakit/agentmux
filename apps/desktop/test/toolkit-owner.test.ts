import { describe, expect, it, vi } from 'vitest'
import type { AgentMuxClientEvent } from '@agentmux/core'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, parseToolkitSnapshot, type MetricsObservation } from '@agentmux/core/control'
import { ToolkitOwner } from '../src/main/toolkit-owner.js'
import type { ToolkitRunPort } from '../src/main/toolkit-run-port.js'
import { resolve } from 'node:path'

export function observation(time = 1000): MetricsObservation {
  const pending = { state: 'pending', data: null, observedAt: null, lastSuccessAt: null, reason: null } as const
  return { schema: 'agentmux.metrics.v1', observedAt: time, scope: { kind: 'unix-host', hostId: 'local', hostname: 'private-fixture', mainPid: process.pid }, window: null,
    units: { cpu: 'percent', rss: 'KiB', storage: 'bytes', cpuAggregate: '10s-reading-peak', rssAggregate: 'latest' },
    process: { state: 'available', data: [{ hostId: 'local', runId: 'nonempty-run', rootPid: process.pid, processCount: 1, cpuPercent: 2, rssKib: 64,
      rootRssKib: 64, descendantsRssKib: 0, descendantProcessCount: 0 }], observedAt: time, lastSuccessAt: time, reason: null },
    app: pending, runtime: pending, main: pending, renderer: pending }
}
const request = (operation: 'toolkit.get'|'toolkit.run'|'toolkit.stop') => ({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'owning', operation, toolId: 'performance' as const })
async function fixture(delayed = false) {
  let accept: (event: AgentMuxClientEvent) => void = () => {}
  let releaseCreate: (() => void) | undefined
  const port: ToolkitRunPort = { create: vi.fn(async (_input, listener) => {
    accept = listener
    if (delayed) await new Promise<void>(resolve => { releaseCreate = resolve })
    return { runId: 'owned-run', pid: 88, kind: 'terminal' } as any
  }), attach: vi.fn(async () => ({ replay: [], gap: null } as any)),
    stop: vi.fn(async () => {}), release: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
  const owner = new ToolkitOwner({ openRunPort: async () => port, launch: () => ({
    runner: process.execPath, cli: '/private/compiled-cli.mjs', script: resolve('apps/desktop/resources/toolkit/performance.mjs'),
    cwd: process.cwd(), env: {} }), enabled: () => true })
  let cursor = 0
  function bytes(data: Uint8Array) {
    const startByte = cursor; cursor += data.length
    accept({ type: 'terminal-output', run: { runId: 'owned-run' }, dataBytes: data, data: '',
      evidence: { source: 'terminal-output', observedAt: 1000, run: { runId: 'owned-run' }, outputByteRange: { startByte, endByte: cursor } } } as any)
  }
  function frame(sequence = 1, obs = observation()) { return JSON.stringify({ schema: 'agentmux.toolkit.result.v1', event: 'result', sequence, payload: obs }) + '\r\n' }
  return { owner, port, bytes, frame, releaseCreate: () => releaseCreate!(), get accept() { return accept } }
}
const flush = async () => { for (let i=0;i<8;i++) await new Promise(resolve => setImmediate(resolve)) }

describe('Toolkit observation owner', () => {
  it('shares one actual port acquisition and preserves manual reason beyond individual leases', async () => {
    const f = await fixture(); const a = new AbortController(), b = new AbortController()
    const one = vi.fn(), two = vi.fn()
    const s1 = await f.owner.subscribe('performance', one, vi.fn(), a.signal)
    const s2 = await f.owner.subscribe('performance', two, vi.fn(), b.signal)
    expect(f.port.create).toHaveBeenCalledTimes(1); expect(f.owner.current.consumerCount).toBe(2)
    f.bytes(Buffer.from(f.frame()))
    expect(one.mock.calls.at(-1)?.[0].observation.process.data).toHaveLength(1)
    expect(two.mock.calls.at(-1)?.[0].sequence).toBe(1)
    await f.owner.execute(request('toolkit.run'), a.signal)
    await f.owner.execute(request('toolkit.run'), a.signal)
    s1.dispose(); s2.dispose(); await flush()
    expect(f.port.stop).not.toHaveBeenCalled(); expect(f.port.create).toHaveBeenCalledTimes(1)
    await f.owner.execute(request('toolkit.stop'), a.signal)
    expect(f.port.stop).toHaveBeenCalledTimes(1); expect(f.port.release).toHaveBeenCalledTimes(1); expect(f.port.remove).toHaveBeenCalledTimes(1)
    expect(f.owner.current.state).toBe('paused'); expect(f.owner.current.observedAt).toBe(1000)
  })
  it('ends a delayed partial creation after consumer abort with no attach or late snapshot', async () => {
    const f = await fixture(true), signal = new AbortController(), seen = vi.fn()
    const establishing = f.owner.subscribe('performance', seen, vi.fn(), signal.signal)
    while ((f.port.create as any).mock.calls.length === 0) await flush()
    const before = seen.mock.calls.length; expect(before).toBeGreaterThan(0)
    signal.abort(); f.releaseCreate(); const subscription = await establishing; subscription.dispose(); await flush()
    expect(f.port.attach).not.toHaveBeenCalled()
    expect(f.port.stop).toHaveBeenCalledTimes(1); expect(f.port.release).toHaveBeenCalledTimes(1); expect(f.port.remove).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledTimes(before)
    await f.owner.dispose()
  })
  it('decodes split UTF8/CRLF from raw bytes, deduplicates replay and rejects missing LF and late consumption', async () => {
    const f = await fixture(); const seen = vi.fn(), end = vi.fn()
    await f.owner.subscribe('performance', seen, end, new AbortController().signal)
    const obs = observation(); obs.scope.hostname = '主机'
    const encoded = Buffer.from(f.frame(1, obs)), split = encoded.indexOf(Buffer.from('主'))
    f.bytes(encoded.subarray(0,split+1)); f.bytes(encoded.subarray(split+1))
    expect(f.owner.current.observation?.scope.hostname).toBe('主机')
    f.accept({ type: 'terminal-snapshot', replay: [{ startByte: 0, endByte: encoded.length, dataBytes: encoded }], gap: null } as any)
    expect(f.owner.current.sequence).toBe(1)
    const tail = Buffer.from(f.frame(2, observation(2000)).trimEnd())
    f.bytes(tail)
    f.accept({ type: 'process-state', state: 'exited', exitCode: 0, run: {runId:'owned-run'} } as any)
    await flush()
    expect(f.owner.current.state).toBe('failed'); expect(f.owner.current.sequence).toBe(1)
    expect(f.owner.current.reason).toContain('without a complete LF frame')
    const count = seen.mock.calls.length
    f.bytes(Buffer.from('\n' + f.frame(3)))
    expect(seen).toHaveBeenCalledTimes(count)
    expect(end).toHaveBeenCalledOnce()
  })
  it('keeps app source age honest and bounded without stale points or cross execution history', async () => {
    const f = await fixture()
    const lease = await f.owner.subscribe('performance', vi.fn(), vi.fn(), new AbortController().signal)
    for (let i=1;i<=65;i++) {
      const obs = observation(i*1000)
      obs.app = { state:'available', observedAt:i*1000, lastSuccessAt:i*1000, reason:null,
        data:{ processCount:1,cpuPercent:2,rssKib:64,groups:[],unavailable:null } }
      f.bytes(Buffer.from(f.frame(i,obs)))
    }
    expect(f.owner.current.trend).toHaveLength(60); expect(f.owner.current.trend[0]?.observedAt).toBe(6000)
    const stale = observation(66000); stale.app = { ...f.owner.current.observation!.app, state:'stale',reason:'reader unavailable' }
    f.bytes(Buffer.from(f.frame(66,stale)))
    expect(f.owner.current.trend).toHaveLength(60); expect(f.owner.current.trend.at(-1)).toEqual({observedAt:66000,appCpuPercent:null,appRssKib:null})
    expect(parseToolkitSnapshot(f.owner.current).observedAt).toBe(66000)
    f.bytes(Buffer.from(f.frame(67,stale)));expect(f.owner.current.trend).toHaveLength(60)
    const cached=observation(67000);cached.app={...stale.app,state:'available',reason:null}
    f.bytes(Buffer.from(f.frame(68,cached)))
    expect(f.owner.current.trend.at(-1)).toEqual({observedAt:66000,appCpuPercent:null,appRssKib:null})
    const restored=observation(68000);restored.app={...stale.app,state:'available',observedAt:68000,lastSuccessAt:68000,reason:null}
    f.bytes(Buffer.from(f.frame(69,restored)))
    expect(f.owner.current.trend.slice(-2)).toEqual([{observedAt:66000,appCpuPercent:null,appRssKib:null},{observedAt:68000,appCpuPercent:2,appRssKib:64}])
    lease.dispose(); await flush(); await f.owner.dispose()
  })
  it('does not admit another execution while exact cleanup is unknown', async () => {
    const f = await fixture(); (f.port.remove as any).mockRejectedValue(new Error('native pin still held'))
    const lease = await f.owner.subscribe('performance', vi.fn(), vi.fn(), new AbortController().signal)
    lease.dispose(); await flush()
    expect(f.owner.current.state).toBe('unknown')
    await expect(f.owner.subscribe('performance',vi.fn(),vi.fn(),new AbortController().signal)).rejects.toMatchObject({code:'CONTROL_UNAVAILABLE'})
    expect(f.port.create).toHaveBeenCalledTimes(1)
    await f.owner.dispose()
  })
  it('rejects a partial UTF8 code point at EOF and a raw Gap without publishing guessed observations', async () => {
    const f = await fixture(), end = vi.fn()
    await f.owner.subscribe('performance', vi.fn(), end, new AbortController().signal)
    f.bytes(Buffer.from([0xe4]))
    f.accept({type:'process-state',state:'exited',exitCode:0,run:{runId:'owned-run'}} as any)
    await flush();expect(f.owner.current.state).toBe('failed');expect(f.owner.current.observation).toBeNull();expect(end).toHaveBeenCalledOnce()
    const g=await fixture(), gapEnd=vi.fn()
    await g.owner.subscribe('performance',vi.fn(),gapEnd,new AbortController().signal)
    g.accept({type:'terminal-snapshot',replay:[],gap:{latestOutputBytes:50}} as any)
    await flush();expect(g.owner.current.state).toBe('failed');expect(g.owner.current.sequence).toBe(0);expect(gapEnd).toHaveBeenCalledOnce()
  })
  it('settles aborted port acquisition without any create and preserves unknown creation outcome instead of retrying',async()=>{
    const f=await fixture(),signal=new AbortController()
    let open!: (p:ToolkitRunPort)=>void
    const owner=new ToolkitOwner({openRunPort:()=>new Promise(resolve=>{open=resolve}),launch:()=>({runner:process.execPath,cli:'/private/compiled-cli.mjs',
      script:resolve('apps/desktop/resources/toolkit/performance.mjs'),cwd:process.cwd(),env:{}}),enabled:()=>true})
    const pending=owner.subscribe('performance',vi.fn(),vi.fn(),signal.signal)
    while(!open)await flush();signal.abort();open(f.port);(await pending).dispose();await flush()
    expect(f.port.create).not.toHaveBeenCalled();expect(owner.current).toMatchObject({state:'paused',run:null,consumerCount:0})
    ;(f.port.create as any).mockRejectedValue(new Error('dispatch reply lost'))
    await expect(f.owner.execute(request('toolkit.run'),new AbortController().signal)).rejects.toThrow('dispatch reply lost')
    await flush();expect(f.owner.current).toMatchObject({state:'unknown',run:null,manual:false})
    const id=f.owner.current.executionId;expect(id).toBeTruthy()
    await expect(f.owner.execute(request('toolkit.run'),new AbortController().signal)).rejects.toMatchObject({code:'CONTROL_UNAVAILABLE'})
    expect(f.port.create).toHaveBeenCalledTimes(1);expect(f.owner.current.executionId).toBe(id)
    await f.owner.dispose();expect(f.owner.current.state).toBe('unknown')
  })
})
