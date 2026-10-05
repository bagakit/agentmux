import type { ReactNode } from 'react'

/** A confirmed empty workface. Discovery and recovery notices stay with their original owners. */
export function WorkbenchEmptyState({ identity, name, heading, description, action, topicId }: {
  identity?: ReactNode; name?: string | undefined; heading: string; description?: string; action: ReactNode; topicId?: string | undefined
}) {
  return <div className="workbench-empty-state" data-workbench-empty-zone data-mote-empty-space={topicId}
    onPointerDown={event => event.stopPropagation()}>
    <div className="workbench-empty-state__content">
      {identity ? <div className="workbench-empty-state__identity">{identity}</div> : null}
      {name ? <span className="workbench-empty-state__name">{name}</span> : null}
      <strong role="status">{heading}</strong>
      {description ? <p>{description}</p> : null}
      <div className="workbench-empty-state__action">{action}</div>
    </div>
  </div>
}
