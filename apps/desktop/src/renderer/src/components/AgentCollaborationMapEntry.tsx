import { useEffect, useLayoutEffect, useState, type ComponentProps } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import type { AgentCollaborationMap as LoadedAgentCollaborationMap } from './AgentCollaborationMap'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { desktopPresentationCommitted } from '../lib/desktop-presentation'
import { useAppStore } from '../store'

/** First-use module loading only. The original Map owns its state after opening. */
export function AgentCollaborationMap(props: ComponentProps<typeof LoadedAgentCollaborationMap>) {
  const [entry, setEntry] = useState<{ Component: typeof LoadedAgentCollaborationMap } | { error: unknown }>()
  const enabled = props.active !== false && props.request !== null
  useEffect(() => {
    if (!enabled || entry) return
    let current = true
    void import('./AgentCollaborationMap').then(({ AgentCollaborationMap }) => {
      if (current) setEntry({ Component: AgentCollaborationMap })
    }, error => { if (current) setEntry({ error }) })
    return () => { current = false }
  }, [enabled, entry])
  useLayoutEffect(() => {
    if (entry && 'Component' in entry) desktopPresentationCommitted()
  }, [entry])

  if (entry && 'Component' in entry) return <entry.Component {...props} />
  if (!enabled) return null
  const failed = entry && 'error' in entry
  // Only the loaded Map exposes the ready marker consumed by public navigation.
  return <section className="collaboration-map" aria-label="Focus map loading">
    <FullPageLoadingSurface scope="region" phase={failed ? 'failed' : 'loading'} eyebrow="Focus map"
      title={failed ? 'Could not open the map' : 'Opening map'}
      detail={failed ? 'The map view could not be loaded. Continue in List.' : 'Preparing the collaboration view.'}
      actions={<Button type="button" onClick={() => useAppStore.getState().setFocusView('list')}>Back to List</Button>}
      {...(failed ? { details: { summary: 'Load details', content: entry.error instanceof Error ? entry.error.message : String(entry.error) } } : {})} />
  </section>
}
