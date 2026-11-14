import { useMemo, type RefObject } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import type { SpaceMountMemberTarget } from '../../../shared/space-mount'
import { spaceMountKey } from '../../../shared/space-mount'
import { useAppStore } from '../store'
import { sourceInputRecoveryRows } from '../lib/source-composer-handoff'
import { originalSourceInputOwnerKey } from '../lib/original-space-navigation'
import { copyTextToClipboard } from '../lib/clipboard-copy'

/** Read-only original bytes; only an explicit edit may fill the current shared draft. */
export function SourceComposerRecovery({ target, tabId, surfaceRef }: { target: SpaceMountMemberTarget; tabId?: string | undefined; surfaceRef?: RefObject<HTMLDetailsElement | null> }) {
  const key = spaceMountKey(target.target.reference), identity = JSON.stringify(target)
  const original = useAppStore(state => {
    const value = state.mountedSpaceInputs
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : value
  })
  const malformedRoot = useAppStore(state => state.mountedSpaceInputs !== undefined &&
    !(state.mountedSpaceInputs && typeof state.mountedSpaceInputs === 'object' && !Array.isArray(state.mountedSpaceInputs)))
  const owner = originalSourceInputOwnerKey(target.target.runtimeId, target.target.agentSessionId)
  const queue = useAppStore(state => state.agentSteerQueues[owner])
  const rows = useMemo(() => [...sourceInputRecoveryRows(malformedRoot ? original : { [key]: original }, target, tabId), ...(queue ?? []).flatMap(entry =>
    entry.recoveredSourceInput === undefined ? [] : [{ path: [owner, entry.operationId], raw: entry.recoveredSourceInput, text: entry.text,
      issue: 'This request is in the shared message queue. Its original saved data is retained below.' }])], [original, malformedRoot, identity, tabId, queue])
  if (!rows.length) return null
  return <details ref={surfaceRef} className="mounted-space-agent__inputs"><summary>Saved inputs to recover · {rows.length}</summary>
    <p>These saved inputs have not been sent again. Filling the current draft changes only its text; any original delivery remains separate.</p>
    <ul>{rows.map(row => <li key={JSON.stringify(row.path)}><p role="status">{row.issue}</p>
      {row.text !== undefined ? <><pre>{row.text}</pre><Button type="button"
        onClick={() => useAppStore.getState().appendAgentComposerDraft(owner, row.text!)}>Append to current draft</Button></> : null}
      <Button type="button" onClick={() => void copyTextToClipboard(JSON.stringify({ path: row.path, original: row.raw }, null, 2), useAppStore.getState().reportError)}>Copy saved input</Button>
      <details><summary>Original saved data</summary><pre>{JSON.stringify(row.raw, null, 2)}</pre></details>
    </li>)}</ul>
  </details>
}
