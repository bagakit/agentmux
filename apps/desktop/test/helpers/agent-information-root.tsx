import type { Root } from 'react-dom/client'
import { AgentInformationPreviewHost } from '../../src/renderer/src/components/AgentInformationPreview'
import { ExecutorIdentityContext } from '../../src/renderer/src/components/AgentAvatar'
import { useAppStore } from '../../src/renderer/src/store'
import type { ReactNode } from 'react'
import { createClientUiRoot } from './client-ui-render'
import { registerWorkbenchDocument } from '../../src/renderer/src/lib/workbench-window-registry'

function AgentInformationFixture({ children }: { children: ReactNode }) {
  const config = useAppStore(state => state.config)
  return <ExecutorIdentityContext.Provider value={{ config }}><AgentInformationPreviewHost />{children}</ExecutorIdentityContext.Provider>
}

/** A component scene retains the same window-level reader owner as App. */
export function createAgentInformationRoot(container: Element | DocumentFragment): Root {
  const root = createClientUiRoot(container)
  const unregister = registerWorkbenchDocument(container.ownerDocument!, { windowId: 'reading-test-window', documentGeneration: 'reading-test-document' })
  return {
    render: content => root.render(<AgentInformationFixture>{content}</AgentInformationFixture>),
    unmount: () => { root.unmount(); unregister() }
  }
}
