import { createContext, useContext, type ReactNode } from 'react'

/**
 * The shell's auxiliary menu entry, rendered at the leading edge of each top-level directory header.
 * Presentation only: the App owns the drawer; a directory never opens it by itself.
 */
export const MobileHeaderMenuContext = createContext<ReactNode>(null)

/** Shown only at a directory's top level; a drilled-in page leads with its own Back instead. */
export function MobileHeaderMenu({ hidden = false }: { hidden?: boolean }) {
  const menu = useContext(MobileHeaderMenuContext)
  return hidden ? null : <>{menu}</>
}
