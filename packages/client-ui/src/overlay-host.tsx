import { createContext, useContext, type ReactNode } from 'react'

/** DOM capabilities for the document currently presenting an overlay. */
export type ClientUiOverlayHost = {
  ownerDocument?: Document | undefined
  overlayContainer(): Element | DocumentFragment
}

const OverlayHostContext = createContext<ClientUiOverlayHost | null>(null)

export function ClientUiOverlayProvider({ host, children }: { host: ClientUiOverlayHost; children: ReactNode }) {
  return <OverlayHostContext.Provider value={host}>{children}</OverlayHostContext.Provider>
}

export function useClientUiOverlayHost(): ClientUiOverlayHost | null {
  return useContext(OverlayHostContext)
}

export function useClientUiOwnerDocument(): Document | undefined {
  return useClientUiOverlayHost()?.ownerDocument
}
