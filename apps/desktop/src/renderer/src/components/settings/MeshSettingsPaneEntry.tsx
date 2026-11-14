import { useEffect, useLayoutEffect, useState, type ComponentProps } from 'react'
import type { MeshSettingsPane as LoadedMeshSettingsPane } from './MeshSettingsPane'
import { FullPageLoadingSurface } from '../FullPageLoadingSurface'
import { desktopPresentationCommitted } from '../../lib/desktop-presentation'

/** The contribution remains discoverable; the original editor opens on demand. */
export function MeshSettingsPane({ onBack, ...props }: ComponentProps<typeof LoadedMeshSettingsPane> & { onBack(): void }) {
  const [entry, setEntry] = useState<{ Component: typeof LoadedMeshSettingsPane } | { error: unknown }>()
  const enabled = props.active !== false
  useEffect(() => {
    if (!enabled || entry) return
    let current = true
    void import('./MeshSettingsPane').then(({ MeshSettingsPane }) => {
      if (current) setEntry({ Component: MeshSettingsPane })
    }, error => { if (current) setEntry({ error }) })
    return () => { current = false }
  }, [enabled, entry])
  useLayoutEffect(() => {
    if (entry && 'Component' in entry) desktopPresentationCommitted()
  }, [entry])

  if (entry && 'Component' in entry) return <entry.Component {...props} />
  if (!enabled) return null
  const failed = entry && 'error' in entry
  return <section data-settings-editor-state={failed ? 'failed' : 'loading'} style={{ height: '100%', minHeight: 320 }}>
    <FullPageLoadingSurface scope="region" phase={failed ? 'failed' : 'loading'} eyebrow="Mesh settings"
      title={failed ? 'Could not open Mesh settings' : 'Opening Mesh settings'}
      detail={failed ? 'The editor could not be loaded. Other settings remain available.' : 'Preparing device and network settings.'}
      actions={<button type="button" className="small-button" onClick={onBack}>Back to Overview</button>}
      {...(failed ? { details: { summary: 'Load details', content: entry.error instanceof Error ? entry.error.message : String(entry.error) } } : {})} />
  </section>
}
