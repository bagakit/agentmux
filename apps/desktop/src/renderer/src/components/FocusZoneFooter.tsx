import type { FocusTopicHeading } from '../lib/focus-collection-lanes'
import { FocusTopicLabel } from './FocusTopicLabel'

/** The scan and its static example share one quiet, original-membership footer. */
export function FocusZoneFooter({ zone }: { zone?: FocusTopicHeading | undefined }) {
  if (!zone) return null
  return <div className="focus-zone-footer" data-focus-zone-footer="" role="group"
    aria-label={`${zone.kind === 'worktree' ? 'Zones' : 'Topic'} · ${zone.name}`}
    title={[zone.name, zone.summary].filter(Boolean).join('\n')}>
    <div className="focus-zone-tags" data-focus-zone-tags="">{zone.tagContent ?? <FocusTopicLabel topic={zone} />}</div>
  </div>
}
