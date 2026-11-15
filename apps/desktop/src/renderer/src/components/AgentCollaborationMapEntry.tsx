import { useLayoutEffect, type ComponentProps } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import type { AgentCollaborationMap as LoadedAgentCollaborationMap } from './AgentCollaborationMap'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { desktopPresentationCommitted } from '../lib/desktop-presentation'
import { useAppStore } from '../store'
import { useDeferredSurface } from '../hooks/useDeferredSurface'

const loadMap = () => import('./AgentCollaborationMap').then(module => module.AgentCollaborationMap)

/** First-use module loading only. The original Map owns its state after opening. */
export function AgentCollaborationMap(props: ComponentProps<typeof LoadedAgentCollaborationMap>) {
  const enabled = props.active !== false && props.request !== null
  const entry = useDeferredSurface(enabled, loadMap)
  useLayoutEffect(() => {
    if (entry?.status === 'loaded') desktopPresentationCommitted()
  }, [entry])

  if (entry?.status === 'loaded') return <entry.Component {...props} />
  if (!enabled) return null
  const failed = entry?.status === 'failed'
  // Only the loaded Map exposes the ready marker consumed by public navigation.
  return <section className="collaboration-map" aria-label="Focus map loading">
    <FullPageLoadingSurface scope="region" phase={failed ? 'failed' : 'loading'} eyebrow="Focus map"
      title={failed ? 'Could not open the map' : 'Opening map'}
      detail={failed ? 'The map view could not be loaded. Continue in List.' : 'Preparing the collaboration view.'}
      actions={<Button type="button" onClick={() => useAppStore.getState().setFocusView('list')}>Back to List</Button>}
      {...(failed ? { details: { summary: 'Load details', content: entry.error instanceof Error ? entry.error.message : String(entry.error) } } : {})} />
  </section>
}
