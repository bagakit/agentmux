import type { ReactNode } from 'react'
import type { BoardTaskArrangement } from '../lib/global-task-board'

export function sessionRegionHostClassName(arrangement: BoardTaskArrangement): string {
  return `session-region-host session-region-host--${arrangement}`
}

/** Shared presentation host; SessionPane remains the sole Session/ctxmux lifecycle owner. */
export function SessionRegionHost({
  arrangement,
  children,
  className = ''
}: {
  arrangement: BoardTaskArrangement
  children: ReactNode
  className?: string
}) {
  return <div className={`${sessionRegionHostClassName(arrangement)}${className ? ` ${className}` : ''}`}>{children}</div>
}
