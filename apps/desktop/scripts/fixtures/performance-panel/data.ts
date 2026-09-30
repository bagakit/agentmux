import type { MetricsObservation } from '@agentmux/core/control'
import type { ToolkitSnapshot } from '../../../src/shared/toolkit'
import { runKey } from '../../../src/renderer/src/components/performance/PerformanceOverview'
// 明确的有界输入；不是用户机器测量或官方链回执。
const at = Date.now()
const available = <T,>(data: T, observedAt = at) => ({ data, observedAt, lastSuccessAt: observedAt, state: 'available' as const, reason: null })
const runs = Array.from({ length: 8 }, (_, i) => ({ runId: `preparation-run-${i + 1}`, hostId: 'local', rootPid: 3101 + i,
  processCount: i === 7 ? null : 3, cpuPercent: i === 7 ? null : [27.6, 9.2, 4.3, 1.4, 0.2, 0, 0.1][i],
  rssKib: i === 7 ? null : [1359872, 524288, 421888, 331776, 221184, 151552, 90112][i],
  rootRssKib: i === 7 ? null : 28672, descendantsRssKib: i === 7 ? null : [1331200, 495616, 393216, 303104, 192512, 122880, 61440][i], descendantProcessCount: i === 7 ? null : 2 }))
const observation: MetricsObservation = {
  schema: 'agentmux.metrics.v1', observedAt: at, scope: { kind: 'unix-host', hostId: 'local', hostname: 'local-mac', mainPid: 1234 },
  window: { windowId: 1, webContentsId: 1, generation: 1 }, units: { cpu: 'percent', rss: 'KiB', storage: 'bytes', cpuAggregate: '10s-reading-peak', rssAggregate: 'latest' },
  app: available({ processCount: 7, cpuPercent: 18.4, rssKib: 655360, unavailable: null, groups: [
    { role: 'main', processCount: 1, cpuPercent: 3.1, rssKib: 131072 }, { role: 'renderer', processCount: 2, cpuPercent: 12.8, rssKib: 327680 },
    { role: 'gpu', processCount: 1, cpuPercent: 2.5, rssKib: 131072 }, { role: 'utility', processCount: 3, cpuPercent: 0, rssKib: 65536 }
  ] }), process: available(runs),
  runtime: available([{ hostId: 'local', resources: { observedAt: at - 60000, runCount: 11, runningRuns: 7, terminatedRuns: 4, terminatedUnattachedRuns: 2, attachments: 8, retainedOutputBytes: 3145728 },
    unavailable: null, process: { cpuPercent: null, rssKib: null, unavailable: 'Runtime does not publish its process identity.' },
    runtimeStorage: { path: '/Users/fixture/workspaces/editor/.runtime/history', bytes: 1572864000 }, runtimeStorageUnavailable: null, runtimeStorageObservedAt: at - 60000 }], at - 60000),
  main: available({ sessionAttachmentOwners: 3, sessionAttachmentLeases: 4, fileWatchers: 5, browserViews: 2, releasedBrowserViews: 1 }),
  renderer: available({ window: { windowId: 1, webContentsId: 1, generation: 1 }, counts: { monacoEditors: 3, monacoModels: 5, documents: 4, runtimeSubscriptions: 2, terminalViews: 3, terminalAddons: 6, terminalListeners: 9 } })
}
export const performanceSnapshot: ToolkitSnapshot = { schema: 'agentmux.toolkit.v1', toolId: 'performance', executionId: 'preparation-execution-1', run: { hostId:'local',runId:'preparation-run-8' }, state: 'observing', reason: null, observedAt: at,
  startedAt: at - 47000, manual: false, consumerCount: 1, sequence: 1,
  observation, trend: Array.from({ length: 48 }, (_, i) => ({ observedAt: at - (47 - i) * 1000,
    appCpuPercent: i < 12 ? 3.2 + i % 4 : i < 24 ? 22 + i % 5 : i < 36 ? 11 + i % 3 : 18.4,
    appRssKib: 540672 + Math.floor(i / 6) * 16384 })) }
export const performanceContexts = Object.fromEntries(runs.slice(0, 7).map((run, i) => [runKey(run), {
  label: ['Review resource observation and Toolkit ownership', 'Improve the Settings workspace', 'Verify keyboard interactions', 'Implement the next source slice', 'Review pending changes', 'Inspect the terminal history', 'Summarize the current evidence'][i],
  context: ['codex · agentmux', 'claude · editor', 'codex · workspace', 'codex · agentmux', 'claude · workbench', 'codex · terminal', 'claude · docs'][i], state: i < 4 ? 'working' : 'idle 3m'
}]))
