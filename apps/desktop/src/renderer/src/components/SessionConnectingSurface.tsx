import { Check, Copy, SquareDashed, TerminalSquare } from 'lucide-react'
import { useId, useState } from 'react'
import type { AgentAvatarAppearance, AgentExecutorConfig } from '../../../shared/contracts'
import type { PendingAgentLaunch } from '../lib/session-state'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { presentError } from '../lib/error-presentation'
import { AgentAvatarBadgeIcon } from './AgentAvatarBadgeIcon'
import { AgentProviderIcon } from './AgentProviderIcon'

/**
 * An Executor is an identity anchor even before Core has published a Session status.  Reusing
 * AgentAvatar here would require manufacturing an AgentDisplayState (and therefore a status dot)
 * for a process whose Runtime state is still unknown.  Keep the provider mark and executor-owned
 * appearance, but leave the status axis empty until a real Session snapshot arrives.
 */
function ConnectingExecutorMark({ executor, label, appearance }: {
  executor: AgentExecutorConfig
  label: string
  appearance?: AgentAvatarAppearance | undefined
}) {
  const filterId = useId().replace(/:/g, '')
  return <span
    className="session-connecting__executor-mark"
    role="img"
    aria-label={label}
    title={label}
  >
    {appearance?.tint ? <svg className="session-connecting__executor-filters" aria-hidden="true" width="0" height="0">
      <defs><filter id={filterId} x="-50%" y="-50%" width="200%" height="200%" colorInterpolationFilters="sRGB">
        <feMorphology in="SourceAlpha" operator="dilate" radius="4" result="solidDilated" />
        <feMorphology in="solidDilated" operator="erode" radius="4" result="solidAlpha" />
        <feMorphology in="solidAlpha" operator="dilate" radius="1" result="expandedAlpha" />
        <feComposite in="expandedAlpha" in2="solidAlpha" operator="out" result="outerAlpha" />
        <feFlood floodColor={appearance.tint} floodOpacity="0.55" result="tintColor" />
        <feComposite in="tintColor" in2="outerAlpha" operator="in" result="tintOutline" />
        <feComposite in="SourceGraphic" in2="tintOutline" operator="over" />
      </filter></defs>
    </svg> : null}
    <span
      className="session-connecting__executor-mark-contour"
      aria-hidden="true"
      style={appearance?.tint ? { filter: `url(#${filterId})` } : undefined}
    >
      <AgentProviderIcon providerId={executor.providerId} size={22} />
      {appearance?.badge ? <span className="session-connecting__executor-badge" data-avatar-badge={appearance.badge}>
        <AgentAvatarBadgeIcon badge={appearance.badge} size={9} />
      </span> : null}
    </span>
  </span>
}

/** Launch intent stays readable while Runtime facts are still on their way. No guessed progress. */
export function SessionConnectingSurface({ phase, surfaceKind, request, executor, appearance }: {
  phase: 'launch' | 'restore' | 'connect'
  surfaceKind: 'agent' | 'terminal'
  request?: PendingAgentLaunch['request']
  executor?: AgentExecutorConfig | undefined
  appearance?: AgentAvatarAppearance | undefined
}) {
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const title = phase === 'launch' ? 'Starting your agent' : phase === 'restore' ? 'Restoring your session' : 'Connecting to this session'
  const detail = phase === 'launch'
    ? 'Waiting for the Runtime to create this session.'
    : phase === 'restore'
      ? 'Reconnecting to the saved session. Your layout stays in place.'
      : 'Waiting for this session’s Runtime state. Your layout stays in place.'
  const prompt = request?.prompt
  const executorLabel = executor?.label ?? request?.executorId ?? 'Executor not yet known'

  async function copyPrompt(): Promise<void> {
    if (!prompt || copying) return
    setCopying(true); setCopied(false); setCopyError('')
    const accepted = await copyTextToClipboard(prompt, (error) => setCopyError(presentError(error)))
    setCopied(accepted)
    setCopying(false)
  }

  return <div className="session-connecting">
    <div className="session-connecting__body">
      <div className="session-connecting__signal" aria-hidden="true">
        <span className="session-connecting__slice" />
        <span className="session-connecting__slice" />
        <span className="session-connecting__slice" />
        <span className="session-connecting__scan" />
        <span className="session-connecting__registration">+</span>
      </div>
      <header className="session-connecting__heading" role="status" aria-live="polite">
        <span className="session-connecting__eyebrow">{phase === 'launch' ? 'Launch request' : 'Session connection'}</span>
        <h2>{title}<span className="session-connecting__cursor" aria-hidden="true">_</span></h2>
        <p>{detail}</p>
      </header>
      {surfaceKind === 'agent' ? <div className="session-connecting__executor">
        {executor
          ? <ConnectingExecutorMark executor={executor} label={executorLabel} appearance={appearance} />
          : <SquareDashed size={24} aria-label="Unknown executor" />}
        <div><span className="session-connecting__eyebrow">Executor</span><strong>{executorLabel}</strong></div>
      </div> : <div className="session-connecting__executor"><TerminalSquare size={24} /><strong>Terminal</strong></div>}
      {surfaceKind === 'agent' ? <section className="session-connecting__prompt" aria-label="Initial prompt">
        <div className="session-connecting__prompt-heading">
          <span className="session-connecting__eyebrow">Initial prompt</span>
          {prompt ? <button type="button" className="session-connecting__copy" disabled={copying}
            onClick={() => { void copyPrompt() }} title="Copy the complete initial prompt" aria-label="Copy initial prompt">
            {copied ? <Check size={13} /> : <Copy size={13} />}<span>{copying ? 'Copying…' : copied ? 'Copied' : 'Copy'}</span>
          </button> : null}
        </div>
        {prompt ? <pre>{prompt}</pre> : <p className="session-connecting__empty">{request
          ? 'No initial prompt was submitted.'
          : phase === 'launch'
            ? 'The initial prompt is unavailable for this launch.'
            : 'The initial prompt is not available while reconnecting.'}</p>}
        <div className="session-connecting__feedback" aria-live="polite">
          {copyError ? <span role="alert">Copy failed: {copyError}</span> : copied ? 'Full prompt copied.' : null}
        </div>
      </section> : null}
    </div>
  </div>
}
