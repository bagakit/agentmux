import { useState } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { ComposerLayoutToggle, type ComposerToolPhase } from '@agentmux/client-ui/components/ComposerLayoutToggle'
/** The same input layout control as Desktop; communication records have their own mailbox. */
export function MobileMessageTools({ refresh, terminal }: { refresh(): void; terminal?: (() => void) | undefined }) {
  const [phase, setPhase] = useState<ComposerToolPhase>('collapsed')
  return <span className="composer-tools" data-mode={phase}><ComposerLayoutToggle phase={phase} onChange={setPhase} />
    {phase !== 'collapsed' && <>{terminal && <button className="composer-tool" aria-label="查看终端" onClick={terminal}><SemanticIcon name="object.terminal" size={16} /></button>}<button className="composer-tool" aria-label="刷新原对话" onClick={refresh}><SemanticIcon name="action.refresh" size={16} /></button></>}
  </span>
}
