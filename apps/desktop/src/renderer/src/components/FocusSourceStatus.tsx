import { useContext, useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { useAppStore } from '../store'
import type { FocusHistoryCatalogue } from '../lib/focus-history-sources'
import type { ServiceNoticeItem } from '../lib/use-service-notices'
import { ServiceNoticeDisclosure } from './ServiceNoticeDisclosure'
import { SettingsNavigation } from './SettingsNavigation'

/** Catalogue coverage can be partial while existing tasks and their controls stay usable. */
export function FocusSourceStatus({ catalogue, laneErrors, laneReads, onRetryLanes, visible }: {
  catalogue: FocusHistoryCatalogue
  laneErrors: readonly string[]
  laneReads: number
  onRetryLanes(): void
  visible: boolean
}) {
  const settings = useContext(SettingsNavigation)
  const hosts = useAppStore(state => state.config?.hosts)
  const [catalogueAttempt, setCatalogueAttempt] = useState<number | null>(null)
  const [laneAttempt, setLaneAttempt] = useState<number | null>(null)
  const { warnings, loading, readError, completedReads } = catalogue
  const canOpenConnection = (warning: typeof warnings[number]) =>
    warning.code === 'RUNTIME_UNAVAILABLE' && warning.availability !== 'connected' &&
    Boolean(settings && hosts?.some(host => host.id === warning.hostId && host.kind === 'ssh'))
  const notices: ServiceNoticeItem[] = []
  const hasSourceIssue = Boolean(readError || warnings.length)
  if (hasSourceIssue) notices.push({ id: 'project-sources', cause: readError ?? JSON.stringify(warnings.map(warning => [warning.hostId, warning.code, warning.message])),
    notice: { kind: 'process-degraded', notice: { step: 'Retained conversations', mode: 'Some history sources could not be read. Previously loaded history is kept.', restore: '' } } })
  if (laneErrors.length) notices.push({ id: 'lane-details', cause: JSON.stringify(laneErrors),
    notice: { kind: 'process-degraded', notice: { step: 'Project details', mode: 'Some project details could not be read. Existing tasks are kept.', restore: '' } } })
  const cataloguePending = catalogueAttempt !== null && completedReads === catalogueAttempt
  const lanePending = laneAttempt !== null && laneReads === laneAttempt
  return <ServiceNoticeDisclosure compact scope="focus:sources" notices={notices} available={!loading} visible={visible}
    title="History and project sources" className="focus-source-status">
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
}
