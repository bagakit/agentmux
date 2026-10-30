import { createContext, useCallback, useMemo, useState } from 'react'
import { useWorkbenchDocument } from '../../lib/workbench-document'

export const DocumentationNavigation = createContext<{ open(): void } | null>(null)

/** One App-owned reading request. It does not change the underlying workface or drafts. */
export function useDocumentationOwner() {
  const document = useWorkbenchDocument()
  const [opening, setOpening] = useState<{ opener: HTMLElement | null } | null>(null)
  const open = useCallback(() => {
    const active = document.activeElement
    const opener = active?.nodeType === 1 ? active as HTMLElement : null
    setOpening(current => current ?? { opener })
  }, [document])
  const close = useCallback(() => setOpening(null), [])
  const navigation = useMemo(() => ({ open }), [open])
  return { opening, close, navigation }
}
