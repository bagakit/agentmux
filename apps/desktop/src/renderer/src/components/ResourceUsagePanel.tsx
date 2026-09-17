import { useEffect, useMemo, useState } from 'react'
import * as DropdownMenu from './HoverDropdownMenu'
import { ChevronUp, Cpu } from 'lucide-react'
import { api } from '../lib/api'
import { readRendererResourceOwnerCounts, useAppStore } from '../store'
import type { SessionSnapshot, AgentTimelineSnapshot, UsageSnapshot } from '../../../shared/contracts'
import { USAGE_METRIC_SPECS, USAGE_SAMPLE_INTERVAL_MS, type AppProcessRole, type RuntimeUsage } from '../../../shared/process-usage'
import { formatBytes, formatCpu, formatRss, subscribeWhileOpen, usagePanelRows, type UsagePanelRow } from '../lib/resource-usage-panel'
import { workspaceRootForPath } from '../lib/workbench-tabs'

const CPU_WINDOW_SECONDS = USAGE_METRIC_SPECS.cpu.windowMs / 1000
const SAMPLE_TARGET_SECONDS = USAGE_SAMPLE_INTERVAL_MS / 1000

const NO_SESSIONS: SessionSnapshot[] = []
const NO_TIMELINES: Record<string, AgentTimelineSnapshot> = {}
const ROLE_LABELS: Record<AppProcessRole, string> = {
  main: 'Main', renderer: 'Renderer', browser: 'Browser', gpu: 'GPU', utility: 'Utility', other: 'Other'
}

function UsageRow({ row }: { row: UsagePanelRow }) {
  return (
    <div className="resource-usage__row">
      <span className="resource-usage__identity">
        <strong className="resource-usage__name">{row.label}</strong>
        <small className="resource-usage__context">{row.contextText} · {row.stateText}</small>
        {row.activity ? <small className="resource-usage__activity">{row.activity}</small> : null}
      </span>
      <span className="resource-usage__metric">{row.cpuText}</span>
      <span className="resource-usage__metric">{row.rssText}</span>
    </div>
  )
}

function RuntimeObservation({ runtime }: { runtime: RuntimeUsage }) {
  const facts = runtime.resources
  const storage = runtime.runtimeStorage
  return (
    <section className="resource-usage__section" aria-label={`Runtime ${runtime.hostId}`}>
      <div className="resource-usage__row">
        <strong className="resource-usage__name">ctxmux · {runtime.hostId}</strong>
        <span className="resource-usage__metric">—</span>
        <span className="resource-usage__metric">—</span>
      </div>
      <p className="resource-usage__note">CPU / RSS unavailable: {runtime.process.unavailable}</p>
      {facts ? <p className="resource-usage__note">Run snapshot on open · {new Date(facts.observedAt).toLocaleTimeString()}</p> : null}
      {runtime.unavailable ? <p className="resource-usage__unavailable resource-usage__note">Run inventory unavailable: {runtime.unavailable}</p> : null}
      {facts ? (
        <dl className="resource-usage__facts">
          <dt>Retained output</dt><dd>{formatBytes(facts.retainedOutputBytes)}</dd>
          <dt>Runs · running / ended</dt><dd>{facts.runCount} · {facts.runningRuns} / {facts.terminatedRuns}</dd>
          <dt>Attachments</dt><dd>{facts.attachments}</dd>
          <dt>Ended without attachments</dt><dd>{facts.terminatedUnattachedRuns}</dd>
        </dl>
      ) : null}
      <details className="resource-usage__details">
        <summary>Runtime storage <span>{storage ? formatBytes(storage.bytes) : '—'}</span></summary>
        <p className="resource-usage__note">Retention and owners are observations, not a leak verdict.</p>
        {runtime.runtimeStorageUnavailable ? <p className="resource-usage__unavailable resource-usage__note">Storage unavailable: {runtime.runtimeStorageUnavailable}</p> : null}
        {storage ? (
          <div className="resource-usage__storage">
            <span title={storage.path}>Selected Runtime<small>{storage.path}</small></span>
            <span className="resource-usage__metric">{formatBytes(storage.bytes)}</span>
          </div>
        ) : null}
        <p className="resource-usage__note">Unattached Runs can still hold history. Disk usage does not imply a leak.</p>
      </details>
    </section>
  )
}

export function ResourceUsagePanel() {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  // Closed panels neither sample processes nor follow unrelated Session/timeline updates.
  const sessions = useAppStore((state) => open ? state.sessions : NO_SESSIONS)
  const timelines = useAppStore((state) => open ? state.timelines : NO_TIMELINES)
  const config = useAppStore((state) => open ? state.config : null)
  const workspaceRoots = useMemo(() => {
    const roots: Record<string, string> = {}
    for (const session of sessions) {
      const path = workspaceRootForPath(config ?? null, session)
      if (path) roots[session.id] = path
    }
    return roots
  }, [config, sessions])

  useEffect(
    () => subscribeWhileOpen(open, api.resourceUsage.subscribe, setSnapshot),
    [open]
  )

  const rendererOwners = useMemo(() => snapshot ? readRendererResourceOwnerCounts() : null, [snapshot])
  const rows = usagePanelRows(snapshot, sessions, { timelines, workspaceRoots })
  const app = snapshot?.app
  const mainOwners = snapshot?.mainOwners
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button className="agent-status-bar__segment agent-status-bar__segment--action" type="button"
          aria-label="Show performance and resource owners" title="Performance and resource owners">
          <Cpu size={11} aria-hidden="true" />
          <ChevronUp size={10} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="resource-usage" side="top" align="end" sideOffset={6} collisionPadding={8}>
          <div className="resource-usage__heading"><strong>Performance</strong><span>{snapshot ? new Date(snapshot.observedAt).toLocaleTimeString() : 'Sampling…'}</span></div>
          <div className="resource-usage__row resource-usage__columns"><span>Process resources</span><span title={`Highest available CPU reading over ${CPU_WINDOW_SECONDS}s; sources are described below`}>CPU · peak</span><span title="Resident memory, latest sample">RSS · latest</span></div>
          <div className="resource-usage__list">
            <section className="resource-usage__section" aria-label="Application resources">
              <details className="resource-usage__details">
                <summary className="resource-usage__row"><strong>AgentMux <small>{app?.processCount ?? '—'} processes</small></strong><span className="resource-usage__metric">{formatCpu(app?.cpuPercent ?? null)}</span><span className="resource-usage__metric">{formatRss(app?.rssKib ?? null)}</span></summary>
                {app?.groups.map((group) => <div className="resource-usage__row" key={group.role}><span>{ROLE_LABELS[group.role]} <small>{group.processCount}</small></span><span className="resource-usage__metric">{formatCpu(group.cpuPercent)}</span><span className="resource-usage__metric">{formatRss(group.rssKib)}</span></div>)}
              </details>
              <p className="resource-usage__note">CPU: interval average · {CPU_WINDOW_SECONDS}s reading peak</p>
              {app?.unavailable ? <p className="resource-usage__unavailable resource-usage__note">Application readings stale: {app.unavailable}</p> : app && app.cpuPercent === null ? <p className="resource-usage__note">CPU warming up · waiting for a second sample</p> : null}
            </section>
            {snapshot?.runtimeUnavailable ? <p className="resource-usage__unavailable resource-usage__note">Runtime observation unavailable: {snapshot.runtimeUnavailable}</p> : null}
            {!snapshot || (snapshot.runtime === null && !snapshot.runtimeUnavailable) ? <p className="resource-usage__note">Observing Runtime…</p> : snapshot.runtime?.length === 0 ? <p className="resource-usage__note">No connected Runtime</p> : snapshot.runtime?.map((runtime) => <RuntimeObservation key={runtime.hostId} runtime={runtime} />)}
            <section className="resource-usage__section" aria-label="Agent resources">
              <details className="resource-usage__details" open>
                <summary>Agents <span>{snapshot ? `${rows.length} ${rows.length === 1 ? 'Run' : 'Runs'}` : '—'}</span></summary>
                <p className="resource-usage__note">CPU: ps averaged reading · {CPU_WINDOW_SECONDS}s reading peak · {SAMPLE_TARGET_SECONDS}s sampling target</p>
                {snapshot?.unavailable ? <p className="resource-usage__unavailable resource-usage__note">Agent readings stale: {snapshot.unavailable}</p> : null}
                {rows.length ? rows.map((row) => <UsageRow key={row.key} row={row} />) : <p className="resource-usage__note">{snapshot ? 'No agent processes' : 'Sampling…'}</p>}
              </details>
            </section>
            <details className="resource-usage__details resource-usage__section">
              <summary>Resource owners <span>Main & this window</span></summary>
              <dl className="resource-usage__facts">
                <dt>Main attachment owners / leases</dt><dd>{mainOwners ? `${mainOwners.sessionAttachmentOwners} / ${mainOwners.sessionAttachmentLeases}` : '—'}</dd>
                <dt>File watchers</dt><dd>{mainOwners?.fileWatchers ?? '—'}</dd>
                <dt>Browser views / released</dt><dd>{mainOwners ? `${mainOwners.browserViews} / ${mainOwners.releasedBrowserViews}` : '—'}</dd>
                <dt>Terminal views / addons / listeners</dt><dd>{rendererOwners ? `${rendererOwners.terminalViews} / ${rendererOwners.terminalAddons} / ${rendererOwners.terminalListeners}` : '—'}</dd>
                <dt>Editors / models / documents</dt><dd>{rendererOwners ? `${rendererOwners.monacoEditors} / ${rendererOwners.monacoModels} / ${rendererOwners.documents}` : '—'}</dd>
                <dt>Runtime subscriptions</dt><dd>{rendererOwners?.runtimeSubscriptions ?? '—'}</dd>
              </dl>
            </details>
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
