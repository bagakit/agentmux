import type { ReactNode } from 'react'
import { DocumentationNavigation, useDocumentationOwner } from '../../src/renderer/src/components/documentation/DocumentationNavigation'
import { DocumentationOverlay } from '../../src/renderer/src/components/documentation/DocumentationOverlay'

/** Compose the same owner used by App; no duplicate document state or opening logic. */
export function DocumentationTestOwner({ children }: { children: ReactNode }) {
  const owner = useDocumentationOwner()
  return <DocumentationNavigation.Provider value={owner.navigation}>{children}
    {owner.opening ? <DocumentationOverlay opener={owner.opening.opener} onClose={owner.close} /> : null}
  </DocumentationNavigation.Provider>
}
