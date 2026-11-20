import { useContext, type ComponentPropsWithRef } from 'react'
import { FocusPlacementScope, focusPlacementCardId } from '../lib/use-focus-context-placements'

/** Give each mounted occurrence an indexed address within its placement scope. */
export function FocusPlacementCard({ cardKey, ...props }: Omit<ComponentPropsWithRef<'div'>, 'id'> & { cardKey: string }) {
  const scope = useContext(FocusPlacementScope)
  return <div {...props} id={scope === null ? undefined : focusPlacementCardId(scope, cardKey)} data-focus-card-key={cardKey} />
}
