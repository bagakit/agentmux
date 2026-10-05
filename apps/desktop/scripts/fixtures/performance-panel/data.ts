import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { createRendererPerformance } from '../../../src/renderer/src/lib/renderer-performance'
import type { MetricsObservation } from '@agentmux/core/control'
import type { ToolkitMetricsSnapshot } from '../../../src/shared/toolkit'
// 明确的有界输入；不是用户机器测量或官方链回执。
const at = Date.now()
const available = <T,>(data: T, observedAt = at) => ({ data, observedAt, lastSuccessAt: observedAt, state: 'available' as const, reason: null })
const runs = Array.from({ length: 8 }, (_, i) => ({ runId: `preparation-run-${i + 1}`, hostId: 'local', rootPid: 3101 + i,
  processCount: i === 7 ? null : 3, cpuPercent: i === 7 ? null : [27.6, 9.2, 4.3, 1.4, 0.2, 0, 0.1][i]!,
  rssKib: i === 7 ? null : [1359872, 524288, 421888, 331776, 221184, 151552, 90112][i]!,
  rootRssKib: i === 7 ? null : 28672, descendantsRssKib: i === 7 ? null : [1331200, 495616, 393216, 303104, 192512, 122880, 61440][i]!, descendantProcessCount: i === 7 ? null : 2 }))
const observation: MetricsObservation = {
  schema: 'agentmux.metrics.v1', observedAt: at, scope: { kind: 'unix-host', hostId: 'local', hostname: 'local-mac', mainPid: 1234 },
  window: { windowId: 1, webContentsId: 1, generation: 1 }, units: { cpu: 'percent', cpuBasis: 'one-logical-core', rss: 'KiB', storage: 'bytes', cpuAggregate: '10s-reading-peak', rssAggregate: 'latest' },
  app: available({ logicalCpuCount: 14, omittedProcesses: 0, processes: [
    {pid:1234,creationTime:at-400000,role:'main',type:'Browser',cpuPercent:3.1,intervalMs:1000,rssKib:131072},
    {pid:2345,creationTime:at-300000,role:'renderer',type:'Tab',cpuPercent:8.2,intervalMs:1000,rssKib:262144},
    {pid:2346,creationTime:at-200000,role:'renderer',type:'Tab',cpuPercent:2.3,intervalMs:1000,rssKib:65536},
    {pid:3456,creationTime:at-300000,role:'gpu',type:'GPU',cpuPercent:2.5,intervalMs:1000,rssKib:131072},
    ...[4567,4568,4569].map((pid,i)=>({pid,creationTime:at-100000,role:'utility' as const,type:'Utility' as const,cpuPercent:0,intervalMs:1000,rssKib:i===0?32768:16384}))
  ], processCount: 7, cpuPercent: 18.4, rssKib: 655360, unavailable: null, groups: [
    { role: 'main', processCount: 1, cpuPercent: 3.1, rssKib: 131072 }, { role: 'renderer', processCount: 2, cpuPercent: 12.8, rssKib: 327680 },
    { role: 'gpu', processCount: 1, cpuPercent: 2.5, rssKib: 131072 }, { role: 'utility', processCount: 3, cpuPercent: 0, rssKib: 65536 }
  ] }), process: available(runs),
  runTotals: { coverage: { trackedRuns: 8, observedRoots: 7, missingRoots: 1 }, processCount: null, cpuPercent: null, rssKib: null },
  runtime: available([{ hostId: 'local', resources: { observedAt: at - 60000, runCount: 11, runningRuns: 7, terminatedRuns: 4, terminatedUnattachedRuns: 2, attachments: 8, retainedOutputBytes: 3145728 },
    unavailable: null, process: { cpuPercent: null, rssKib: null, unavailable: 'Runtime does not publish its process identity.' },
    runtimeStorage: { path: _hygiene_fixturePath("Users/fixture/workspaces/editor/.runtime/history"), bytes: 1572864000 }, runtimeStorageUnavailable: null, runtimeStorageObservedAt: at - 60000 }], at - 60000),
  diagnostics: { state: 'pending', data: null, observedAt: null, lastSuccessAt: null, reason: null },
  main: available({ sessionAttachmentOwners: 3, sessionAttachmentLeases: 4, fileWatchers: 5, browserViews: 2, releasedBrowserViews: 1 }),
  renderer: available({ process:{pid:2345,creationTime:at-300000},memory:{sampledAt:at,scope:'renderer-v8-isolate',heap:{usedHeapKib:122880,totalHeapKib:196608,physicalHeapKib:180224,heapLimitKib:4194304},unavailable:null}, window: { windowId: 1, webContentsId: 1, generation: 1 }, counts: { monacoEditors: 3, monacoModels: 5, documents: 4, runtimeSubscriptions: 2, terminalViews: 3, terminalAddons: 6, terminalListeners: 9 }, performance: createRendererPerformance(() => 0, () => at).snapshot() })
}
export const performanceSnapshot: ToolkitMetricsSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'metrics', toolId: 'performance', executionId: 'preparation-execution-1', run: { hostId:'local',runId:'preparation-run-8' }, state: 'observing', reason: null, observedAt: at,
  startedAt: at - 47000, manual: false, consumerCount: 1, sequence: 1,
  document: {schema:'agentmux.toolkit.result.v1',summary:'All tracked local Run processes',items:[],links:[],notice:'RSS includes shared pages.',agentCards:{fields:['avatar','name','status','provider','workspace'],items:runs.map(run=>({reference:{kind:'run',hostId:run.hostId,runId:run.runId},metrics:[]})),omittedItems:0}},
  observation, trend: Array.from({ length: 48 }, (_, i) => ({ observedAt: at - (47 - i) * 1000,
    appCpuPercent: i < 12 ? 3.2 + i % 4 : i < 24 ? 22 + i % 5 : i < 36 ? 11 + i % 3 : 18.4,
    appRssKib: 540672 + Math.floor(i / 6) * 16384 })) }
// Controlled inputs for actual product rendering only; not live machine attribution.
function attributionSnapshot() {
  const result = structuredClone(performanceSnapshot), observation = result.observation!, app = observation.app.data!
  app.cpuPercent = 148.4
  const group = app.groups.find(value => value.role === 'renderer')!
  group.cpuPercent = 126; group.rssKib = 1887437 + 65536
  const process = app.processes.find(value => value.pid === 2345)!
  process.cpuPercent = 114.6; process.rssKib = 1887437
  app.rssKib = app.groups.reduce((sum, value) => sum + value.rssKib, 0)
  observation.renderer.data!.memory.heap = {usedHeapKib:786432,totalHeapKib:1048576,physicalHeapKib:983040,heapLimitKib:4194304}
  let mono = 1500
  const recorder = createRendererPerformance(() => mono, () => at)
  mono = 2500; recorder.sessionEvent('fixture', mono - 123)
  mono = 3500; recorder.terminalWrite(false, 'fixture', mono - 520, { hostId: 'local', sessionId: 'preparation-session', runId: 'preparation-run', regionId: 'preparation-region', instanceId: recorder.allocateTerminalInstance(), cause: 'history' })
  mono = 4500; recorder.terminalInteraction('write-request', 80, 4200)
  mono = 12500; observation.renderer.data!.performance = recorder.snapshot()
  return result
}
const fresh = attributionSnapshot(), refresh = structuredClone(fresh), newInstance = structuredClone(fresh)
refresh.sequence++; refresh.observedAt! += 1000; refresh.observation!.observedAt += 1000
refresh.observation!.app.observedAt! += 1000; refresh.observation!.app.lastSuccessAt! += 1000
refresh.observation!.app.data!.processes.find(value => value.pid === 2345)!.cpuPercent = 118
const replaced = newInstance.observation!.app.data!.processes.find(value => value.pid === 2345)!
replaced.creationTime += 1 // same PID reused; old window memory must not be joined.
const stale = structuredClone(refresh)
stale.observedAt! += 30000; stale.observation!.observedAt += 30000
stale.observation!.app.state = 'stale'; stale.observation!.app.reason = 'Application sample could not be refreshed.'
stale.observation!.renderer.state = 'stale'; stale.observation!.renderer.reason = 'Renderer has not answered.'
const unknown = structuredClone(fresh)
unknown.observation!.app.data!.processes.forEach(value => {value.cpuPercent=null;value.intervalMs=null})
unknown.observation!.app.data!.groups.forEach(value => {value.cpuPercent=null})
unknown.observation!.app.data!.cpuPercent = null; unknown.observation!.app.data!.logicalCpuCount = null
unknown.observation!.renderer.data!.memory.heap = null; unknown.observation!.renderer.data!.memory.unavailable = 'V8 heap reading unavailable.'
export const performanceAttributionSnapshots = {fresh,refresh,waiting:fresh,newInstance,stale,unknown}
