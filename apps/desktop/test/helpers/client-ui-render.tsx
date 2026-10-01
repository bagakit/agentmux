import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { DesktopClientUiProvider } from '../../src/renderer/src/components/DesktopClientUiProvider'

/** Component tests use the same explicit platform adapter as the Desktop application. */
export function createClientUiRoot(container: Element | DocumentFragment): Root {
  const root = createRoot(container)
  return {
    render: content => root.render(<DesktopClientUiProvider>{content}</DesktopClientUiProvider>),
    unmount: () => root.unmount()
  }
}

export function renderClientUiMarkup(content: ReactNode): string {
  return renderToStaticMarkup(<DesktopClientUiProvider>{content}</DesktopClientUiProvider>)
}
