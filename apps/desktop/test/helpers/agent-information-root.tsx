import type { Root } from 'react-dom/client'
import { AgentInformationPreviewHost } from '../../src/renderer/src/components/AgentInformationPreview'
import { createClientUiRoot } from './client-ui-render'

/** A component scene retains the same window-level reader owner as App. */
export function createAgentInformationRoot(container: Element | DocumentFragment): Root {
  const root = createClientUiRoot(container)
  return {
    render: content => root.render(<><AgentInformationPreviewHost />{content}</>),
    unmount: () => root.unmount()
  }
}
