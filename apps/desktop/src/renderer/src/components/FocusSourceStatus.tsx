import { ServiceNoticeDisclosure } from './ServiceNoticeDisclosure'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import type { ServiceNoticeItem } from '../lib/use-service-notices'

/** Source read failures do not change Context or Agent capability. */
export function FocusSourceStatus({ sourceError, loading, laneErrors, onRetrySources, onRetryLanes, visible }: {
  sourceError: string | null
  loading: boolean
  laneErrors: readonly string[]
  onRetrySources(): void
  onRetryLanes(): void
  visible: boolean
}) {
  const notices: ServiceNoticeItem[] = []
  // Original failure values distinguish read acknowledgments, never Agent control facts.
  if (sourceError) notices.push({ id: 'project-sources', cause: sourceError, notice: { kind: 'process-degraded', notice: {
    step: 'Project status could not be checked.',
    mode: 'Recent projects remain available; current source status is unknown.',
    restore: loading ? 'Retrying project sources…' : 'Retry project sources to check their current status.'
  } } })
  if (laneErrors.length) notices.push({ id: 'lane-details', cause: JSON.stringify(laneErrors), notice: { kind: 'process-degraded', notice: {
    step: 'Some lane details could not load.',
    mode: 'Contexts and previously known lane details remain available.',
    restore: 'Retry lane details to read the unavailable workspace sources.'
  } } })
  return <ServiceNoticeDisclosure scope="focus:sources" notices={notices} available={!loading} visible={visible}
    title="Sources unavailable" className="focus-source-status" actions={<>
      {sourceError ? <button type="button" className="small-button" aria-busy={loading} onClick={onRetrySources}>Retry project sources</button> : null}
      {laneErrors.length ? <button type="button" className="small-button" onClick={onRetryLanes}>Retry lane details</button> : null}
    </>}>
    {notices.map(item => <section key={item.id}>
      <ServiceWindowNotice notice={item.notice} />
      <p className="focus-source-status__cause" title={item.id === 'project-sources' ? sourceError! : laneErrors.join('\n')}>
        {item.id === 'project-sources' ? sourceError : laneErrors.join('\n')}
      </p>
    </section>)}
  </ServiceNoticeDisclosure>
}
