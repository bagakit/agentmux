import type { ReactNode } from 'react'
import { SurfaceState } from './SurfaceState'

/** A confirmed empty workface. Discovery and recovery notices stay with their original owners. */
export function WorkbenchEmptyState({ identity, name, heading, description, action, topicId }: {
  identity?: ReactNode; name?: string | undefined; heading: string; description?: string; action: ReactNode; topicId?: string | undefined
}) {
  return <SurfaceState className="workbench-empty-state" data-workbench-empty-zone data-mote-empty-space={topicId}
    onPointerDown={event => event.stopPropagation()} identity={identity} eyebrow={name}
    title={<span role="status">{heading}</span>} description={description} actions={action} />
}
