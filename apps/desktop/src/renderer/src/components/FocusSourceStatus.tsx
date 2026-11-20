import { useContext, useEffect, useRef, useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { useAppStore } from '../store'
import type { FocusHistoryCatalogue } from '../lib/focus-history-sources'
import type { FocusSourceIssue } from '../lib/use-focus-sources'
import { useReadReceipts, type ServiceNoticeItem } from '../lib/use-service-notices'
import * as Menu from './DropdownMenu'
import { ServiceNoticeDisclosure } from './ServiceNoticeDisclosure'
import { SettingsNavigation } from './SettingsNavigation'

type CoreUpdateTarget = Pick<FocusSourceIssue, 'key' | 'host' | 'hostId'> & { upgradeRuntimeId: string }

function FocusCoreUpgradeHint({ issues, visible, open }: {
  issues: readonly CoreUpdateTarget[]
  visible: boolean
  open(hostId: string): void
}) {
  const primary = useRef<HTMLButtonElement>(null)
  // Focus only reads demanded sources, so their absence cannot prune receipts.
  const { unread, acknowledge } = useReadReceipts('focus:core-update', Object.fromEntries(
    issues.map(issue => [issue.key, issue.upgradeRuntimeId])
  ), true, false)
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => {
    if (!visible || issues.length < 2) setMenuOpen(false)
  }, [visible, issues.length])
  const first = issues[0]
  if (!first) return null
  const expanded = unread.length > 0
  const multiple = issues.length > 1
  const label = multiple ? `Update Core on ${issues.length} hosts` : `Update Core on ${first.host}`
  const action = <button ref={primary} type="button" className="recent-focus__coverage-button" title={label} aria-label={label}
    onClick={multiple ? undefined : () => open(first.hostId)}>
    <SemanticIcon name="action.upgrade-host" size={13} />{expanded ? <span>Update Core{multiple ? ` · ${issues.length}` : null}</span> : null}
  </button>
  return <span className="focus-core-upgrade">
    {multiple ? <Menu.Root modal={false} open={visible && menuOpen} onOpenChange={setMenuOpen}>
      <Menu.Trigger asChild>{action}</Menu.Trigger>
      <Menu.Portal><Menu.Content className="tab-context-menu focus-core-upgrade__menu" align="start" sideOffset={4} collisionPadding={8}
        onCloseAutoFocus={event => { if (!visible) event.preventDefault() }}>
        {issues.map(issue => <Menu.Item key={issue.key} className="tab-context-menu__item" onSelect={() => open(issue.hostId)}>
          {issue.host}
        </Menu.Item>)}
      </Menu.Content></Menu.Portal>
    </Menu.Root> : action}
    {expanded ? <IconButton type="button" aria-label="Dismiss Core update hint" title="Dismiss Core update hint" onClick={() => {
      setMenuOpen(false)
      acknowledge(unread)
      primary.current?.focus({ preventScroll: true })
    }}><SemanticIcon name="action.close" size={12} /></IconButton> : null}
  </span>
}

/** Catalogue coverage can be partial while existing tasks and their controls stay usable. */
export function FocusSourceStatus({ catalogue, laneErrors, laneReads, onRetryLanes, visible, locationIssues = [] }: {
  catalogue: FocusHistoryCatalogue
  laneErrors: readonly string[]
  laneReads: number
  onRetryLanes(): void
  visible: boolean
  locationIssues?: readonly FocusSourceIssue[]
}) {
  const settings = useContext(SettingsNavigation)
  const hosts = useAppStore(state => state.config?.hosts)
  const [catalogueAttempt, setCatalogueAttempt] = useState<number | null>(null)
  const [laneAttempt, setLaneAttempt] = useState<number | null>(null)
  const { warnings, loading, readError, completedReads } = catalogue
  const canOpenConnection = (warning: typeof warnings[number]) =>
    warning.code === 'RUNTIME_UNAVAILABLE' && warning.availability !== 'connected' &&
    Boolean(settings && hosts?.some(host => host.id === warning.hostId && host.kind === 'ssh'))
  const upgrades: CoreUpdateTarget[] = []
  const diagnoses: FocusSourceIssue[] = []
  for (const issue of locationIssues) {
    const { upgradeRuntimeId } = issue
    const host = settings && upgradeRuntimeId ? hosts?.find(host => host.id === issue.hostId) : undefined
    if (upgradeRuntimeId && host?.kind === 'ssh' && host.transport !== 'tailcat' &&
        (!host.runtimeId || host.runtimeId === upgradeRuntimeId)) {
      upgrades.push({ key: issue.key, host: issue.host, hostId: issue.hostId, upgradeRuntimeId })
    } else {
      diagnoses.push(issue)
    }
  }
  const notices: ServiceNoticeItem[] = []
  const hasSourceIssue = Boolean(readError || warnings.length)
  if (hasSourceIssue) notices.push({ id: 'project-sources', cause: readError ?? JSON.stringify(warnings.map(warning => [warning.hostId, warning.code, warning.message])),
    notice: { kind: 'process-degraded', notice: { step: 'Retained conversations', mode: 'Some history sources could not be read. Previously loaded history is kept.', restore: '' } } })
  if (laneErrors.length) notices.push({ id: 'lane-details', cause: JSON.stringify(laneErrors),
    notice: { kind: 'process-degraded', notice: { step: 'Project details', mode: 'Some project details could not be read. Existing tasks are kept.', restore: '' } } })
  if (diagnoses.length) notices.push({ id: 'original-locations', cause: JSON.stringify(diagnoses.map(issue => [issue.key, issue.message])),
    notice: { kind: 'process-degraded', notice: { step: 'Agent locations', mode: 'Some source locations could not be confirmed. Existing tasks are kept.', restore: '' } } })
  const cataloguePending = catalogueAttempt !== null && completedReads === catalogueAttempt
  const lanePending = laneAttempt !== null && laneReads === laneAttempt
  const details = <ServiceNoticeDisclosure compact scope="focus:sources" notices={notices} available={!loading} visible={visible}
    title="History and project sources" className="focus-source-status">
    {diagnoses.length ? <section aria-label="Agent locations">
      <h4>Agent locations</h4>
      {diagnoses.map(issue => <div className="focus-source-status__entry" key={issue.key}>
        <strong>{issue.host}{issue.reference ? ` · ${issue.label}` : ''}</strong>
        <p>{issue.message}</p>
        {issue.reference ? <details className="focus-source-status__cause"><summary>Source identity</summary>
          <p>Runtime: {issue.reference.runtimeId}<br />Space: {issue.reference.spaceId}</p></details> : null}
        <div className="focus-source-status__actions">
          <button className="small-button" type="button" disabled={issue.reading} aria-busy={issue.reading} onClick={issue.refresh}>{issue.reading ? 'Checking…' : 'Check again'}</button>
          {settings && hosts?.some(host => host.id === issue.hostId && host.kind === 'ssh') ? <button className="small-button" type="button" onClick={event => {
            event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover()
            settings.open('hosts', undefined, 'mesh-devices', issue.hostId)
          }}>Host settings</button> : null}
        </div>
      </div>)}
    </section> : null}
    {hasSourceIssue ? <section>
      <h4>Retained conversations</h4>
      <p>Some sources could not be read. Previously loaded history is kept.</p>
      {warnings.map(warning => <div className="focus-source-status__entry" key={warning.hostId}>
        <strong>{hosts?.find(host => host.id === warning.hostId)?.label ?? warning.hostId}</strong>
        <p>{warning.message}</p>
        {canOpenConnection(warning) ? <Button type="button" onClick={event => {
          event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover()
          settings?.open('hosts', undefined, 'mesh-devices', warning.hostId)
        }}>Connection settings</Button> : null}
      </div>)}
      {readError ? <p>{readError}</p> : null}
      <Button type="button" aria-disabled={loading || cataloguePending} onClick={() => {
        if (loading || cataloguePending) return
        setCatalogueAttempt(completedReads); catalogue.refresh()
      }}>{loading || cataloguePending ? 'Checking history…' : 'Check history again'}</Button>
      {catalogueAttempt !== null ? <p role="status">{loading || cataloguePending ? 'Reading the saved conversation sources.' : 'Some history is still unavailable.'}</p> : null}
    </section> : null}
    {laneErrors.length ? <section>
      <h4>Project details</h4>
      <p>Some project details could not be read. Existing tasks are kept.</p>
      <ul className="focus-source-status__cause" title={laneErrors.join('\n')}>{laneErrors.map((error, index) => <li key={index}>{error}</li>)}</ul>
      <Button type="button" aria-disabled={lanePending} onClick={() => {
        if (lanePending) return
        setLaneAttempt(laneReads); onRetryLanes()
      }}>{lanePending ? 'Checking projects…' : 'Check project details again'}</Button>
      {laneAttempt !== null ? <p role="status">{lanePending ? 'Reading project details.' : 'Some details are still unavailable.'}</p> : null}
    </section> : null}
  </ServiceNoticeDisclosure>
  return <>
    {settings && upgrades.length > 0 ? <FocusCoreUpgradeHint issues={upgrades} visible={visible}
      open={hostId => settings.open('hosts', undefined, 'host-core', hostId)} /> : null}
    {details}
  </>
}
