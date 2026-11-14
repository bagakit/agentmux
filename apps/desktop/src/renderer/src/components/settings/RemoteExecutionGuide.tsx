import { useContext } from 'react'
import { DocumentationNavigation } from '../documentation/DocumentationNavigation'

/** One entry into the App-owned document reader and the canonical offline Core guide. */
export function RemoteExecutionGuide({ active }: { active: boolean }) {
  const documentation = useContext(DocumentationNavigation)
  return <div className="remote-execution-guide" data-settings-field="guide">
    <button type="button" className="agent-work-text-action" onClick={() => { if (active) documentation?.open('remote-execution') }}>Remote work guide</button>
  </div>
}
