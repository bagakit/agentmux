import { Check, Copy, SquareDashed, TerminalSquare } from 'lucide-react'
import { useState } from 'react'
import type { AgentAvatarAppearance, AgentExecutorConfig } from '../../../shared/contracts'
import type { PendingAgentLaunch } from '../lib/session-state'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { presentError } from '../lib/error-presentation'
import { AgentAvatar } from './AgentAvatar'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'

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

  return <FullPageLoadingSurface
    className="session-connecting"
    scope="region"
    phase={phase === 'restore' ? 'recovering' : 'loading'}
    eyebrow={phase === 'launch' ? 'Launch request' : 'Session connection'}
    title={title}
    detail={detail}
  >
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
          ? <AgentAvatar providerId={executor.providerId} executorId={request?.executorId} label={executorLabel} appearance={appearance} size={26} />
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
  </FullPageLoadingSurface>
}
