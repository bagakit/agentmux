import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { DesktopClientUiProvider } from '../../src/renderer/src/components/DesktopClientUiProvider'

// happy-dom does not implement the platform move API used by the real Workbench.
// This same-document test substitute exercises existing-node placement through DOM;
// native focus/Range preservation is proved separately in ordinary Electron.
if (typeof Element !== 'undefined' && typeof Element.prototype.moveBefore !== 'function') {
  Object.defineProperty(Element.prototype, 'moveBefore', {
    configurable: true,
    value(this: Element, node: Node, before: Node | null) {
      if (node.ownerDocument !== this.ownerDocument) throw new DOMException('The node belongs to another document.', 'WrongDocumentError')
      this.insertBefore(node, before)
    }
  })
}

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
