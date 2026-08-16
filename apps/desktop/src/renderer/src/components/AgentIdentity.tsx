import { useContext, useId, useRef } from 'react'
import type { AgentAvatarAppearance, SessionSnapshot } from '../../../shared/contracts'
import { AgentAvatar } from './AgentAvatar'
import { agentProviderLabel } from './AgentProviderIcon'
import { SettingsNavigation } from './SettingsNavigation'

/** Identity has its own disclosure; mailbox unread state never changes this control. */
export function AgentIdentity({ session, name, executorLabel, appearance }: {
  session: Extract<SessionSnapshot, { kind: 'agent' }>
  name: string
  executorLabel: string
  appearance?: AgentAvatarAppearance | undefined
}) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  const navigation = useContext(SettingsNavigation)
  return <>
    <button type="button" className="composer-agent-identity" popoverTarget={id} aria-label={`${name} · Agent details`} title={`${name} · ${session.status.state}`}>
      <AgentAvatar providerId={session.providerId} state={session.status.state} label={name} appearance={appearance} />
    </button>
    <div ref={panel} id={id} popover="auto" className="agent-identity-popover" aria-label="Agent identity">
      <strong>{name}</strong>
      <dl><dt>Provider</dt><dd>{agentProviderLabel(session.providerId)}</dd>
        <dt>Executor</dt><dd>{executorLabel} · {session.executorId}</dd>
        <dt>Status</dt><dd>{session.status.state}</dd></dl>
      <button type="button" className="small-button" disabled={!navigation} onClick={() => {
        panel.current?.hidePopover()
        navigation?.open('appearance')
      }}>Customize avatar</button>
    </div>
  </>
}
