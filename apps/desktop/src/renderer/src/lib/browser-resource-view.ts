import type { AgentMuxBrowserResource, AgentMuxBrowserTarget } from '@agentmux/core'
import type { AppUsageProcess } from '@agentmux/core/control'

export type BrowserDirectoryRow = { target: AgentMuxBrowserTarget; current: boolean; previousLocations?: AgentMuxBrowserResource['locations'] }
export const processKey = (process: { pid: number; creationTime: number }) => `${process.pid}:${process.creationTime}`
export const memory = (kib: number) => kib >= 1048576 ? `${(kib / 1048576).toFixed(2)} GiB` : `${Math.round(kib / 1024)} MiB`
export const stateLabel = (state: AgentMuxBrowserResource['state'] | undefined) => state === 'live' ? 'Running' : state === 'released' ? 'Released' : state === 'cold' ? 'Not loaded' : 'Unknown'
export const pageName = (target: AgentMuxBrowserTarget) => target.title || target.url || 'Original Browser'
export function pageAddress(url: string): string {
  try { return new URL(url).host || url } catch { return url || 'Address unconfirmed' }
}

const reasons = {
  visible: 'Visible in workbench', presentation: 'Displayed elsewhere', operation: 'Operation in progress', loading: 'Loading',
  'profile-switch': 'Changing profile', selection: 'Selection in progress', media: 'Playing media', download: 'Download in progress',
  upload: 'Upload files retained', debugger: 'Debugger connected', 'document-used': 'Page has been used',
  'document-unconfirmed': 'Protection unconfirmed', 'source-changed': 'Document changed', 'close-unconfirmed': 'Release unconfirmed',
  beforeunload: 'Page prevented release', 'owner-unavailable': 'Page owner unconfirmed'
} satisfies Record<NonNullable<AgentMuxBrowserResource['retention']>['reasons'][number], string>
export const retentionReason = (reason: keyof typeof reasons) => reasons[reason]
export const eligibleForRelease = (row: BrowserDirectoryRow) => row.current && row.target.resource?.state === 'live' &&
  row.target.resource.retention?.status === 'eligible' && Boolean(row.target.navigationId)

/** Process working sets, never per-page allocations or predicted release savings. */
export function browserProcessReadings(rows: readonly BrowserDirectoryRow[], processes: readonly AppUsageProcess[]) {
  const samples = new Map(processes.map(process => [processKey(process), process]))
  const counts = new Map<string, number>()
  const current = rows.filter(row => row.current)
  for (const row of current) for (const key of new Set((row.target.resource?.processes ?? []).map(processKey))) counts.set(key, (counts.get(key) ?? 0) + 1)
  const measured = [...counts.keys()].map(key => samples.get(key)).filter(process => process !== undefined)
  return { samples, counts, measured, totalKib: measured.reduce((sum, process) => sum + process.rssKib, 0),
    row(row: BrowserDirectoryRow) {
      const owned = row.current ? row.target.resource?.processes : null
      const keys = [...new Set((owned ?? []).map(processKey))]
      const matched = keys.map(key => samples.get(key)).filter(process => process !== undefined)
      return { kib: matched.length ? matched.reduce((sum, process) => sum + process.rssKib, 0) : null,
        incomplete: owned == null || keys.length > matched.length,
        shared: keys.some(key => (counts.get(key) ?? 0) > 1), keys, matched }
    } }
}
