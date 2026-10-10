import type { Root } from 'react-dom/client'
import { AgentInformationPreviewHost } from '../../src/renderer/src/components/AgentInformationPreview'
import { createClientUiRoot } from './client-ui-render'
import { registerWorkbenchDocument } from '../../src/renderer/src/lib/workbench-window-registry'

/** A component scene retains the same window-level reader owner as App. */
export function createAgentInformationRoot(container: Element | DocumentFragment): Root {
  const root = createClientUiRoot(container)
  const unregister = registerWorkbenchDocument(container.ownerDocument!, { windowId: 'reading-test-window', documentGeneration: 'reading-test-document' })
  return {
    render: content => root.render(<><AgentInformationPreviewHost />{content}</>),
    unmount: () => { root.unmount(); unregister() }
  }
}
