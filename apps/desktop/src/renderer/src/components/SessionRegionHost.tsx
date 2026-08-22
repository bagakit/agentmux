import type { ReactNode } from 'react'
import type { DemandArrangement } from '../lib/global-task-board'

export function sessionRegionHostClassName(arrangement: DemandArrangement): string {
  return `session-region-host session-region-host--${arrangement}`
}

/** Shared presentation host; SessionPane remains the sole Session/ctxmux lifecycle owner. */
export function SessionRegionHost({
  arrangement,
  children,
  className = ''
}: {
  arrangement: DemandArrangement
  children: ReactNode
  className?: string
}) {
  return <div className={`${sessionRegionHostClassName(arrangement)}${className ? ` ${className}` : ''}`}>{children}</div>
}
