import { browserAgentBoundaryAppearance, type BrowserAgentControlPreferences } from '../../../shared/browser-agent-control'

/** The same steady edge as the native input surface, fitted to the captured page. */
export function BrowserControlBoundary({ preferences, viewport }: {
  preferences: BrowserAgentControlPreferences
  viewport?: { width: number; height: number } | undefined
}) {
  return <svg data-browser-control-boundary="" aria-hidden="true"
    viewBox={viewport ? `0 0 ${viewport.width} ${viewport.height}` : undefined}
    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'hidden', pointerEvents: 'none',
      ...browserAgentBoundaryAppearance(preferences) }}>
    <svg width={viewport?.width ?? '100%'} height={viewport?.height ?? '100%'} overflow="hidden">
      <rect width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  </svg>
}
