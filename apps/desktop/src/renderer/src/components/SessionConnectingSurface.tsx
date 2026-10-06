import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useState, type ReactNode } from 'react'
import type { AgentAvatarAppearance, AgentExecutorConfig, SessionHistoryReference } from '../../../shared/contracts'
import type { PendingAgentLaunch } from '../lib/session-state'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { AgentAvatar } from './AgentAvatar'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { SessionRecap } from './SessionRecap'
import { ServiceWindowNotice } from './ServiceWindowNotice'

const ThemeObjectBoundaryIcon = semanticIconComponent('object.boundary')
const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')
const ThemeStatusCopiedIcon = semanticIconComponent('status.copied')
const ThemeActionCopyIcon = semanticIconComponent('action.copy')


/** Launch intent stays readable while Runtime facts are still on their way. No guessed progress. */
export function SessionConnectingSurface({ phase, surfaceKind, request, executor, appearance, session, actions, visible = true, unknownTerminalCreation = false }: {
  phase: 'launch' | 'restore' | 'connect'
  surfaceKind: 'agent' | 'terminal'
  request?: PendingAgentLaunch['request']
  executor?: AgentExecutorConfig | undefined
  appearance?: AgentAvatarAppearance | undefined
  session?: SessionHistoryReference | undefined
  actions?: ReactNode
  visible?: boolean
  /** Exact retained Terminal Region has no confirmed Run or original creation receipt. */
  unknownTerminalCreation?: boolean
}) {
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const title = unknownTerminalCreation ? 'Terminal creation is unconfirmed' : phase === 'launch' ? 'Starting your agent' : phase === 'restore' ? 'Restoring your session' : 'Connecting to this session'
  const detail = unknownTerminalCreation ? '' : phase === 'launch'
    ? ''
    : phase === 'restore'
      ? 'Reconnecting to the saved session.'
      : 'Waiting for this session to reconnect.'
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
    phase={unknownTerminalCreation ? 'parked' : phase === 'restore' ? 'recovering' : 'loading'}
    eyebrow={unknownTerminalCreation ? 'Terminal retained' : phase === 'launch' ? 'Launch request' : 'Session connection'}
    title={title}
    detail={detail}
    actions={actions}
    supplement={<div className="session-connecting__body">
      {unknownTerminalCreation ? <ServiceWindowNotice summary={{
        step: 'Waiting for the original request result.',
        mode: 'Your Tab and layout are kept.',
        restore: 'Do not repeat Start while the result is unknown.'
      }} notice={{ kind: 'indeterminate', notice: {
        step: 'The original Terminal creation result and Run identity are unknown.',
        mode: 'No confirmed Run is bound to this Region. Its original layout remains available.',
        restore: 'The original creation request identity is unconfirmed here. Do not repeat Start while its result is unknown; keep this Region and check the original Runtime or continue observing the original request.'
      } }} /> : null}
      {surfaceKind === 'agent' ? <div className="session-connecting__executor">
        {executor
          ? <AgentAvatar providerId={executor.providerId} executorId={request?.executorId} label={executorLabel} appearance={appearance} size={18} />
          : <ThemeObjectBoundaryIcon size={18} aria-label="Unknown executor" />}
        <strong>{executorLabel}</strong>
      </div> : !unknownTerminalCreation ? <div className="session-connecting__executor"><ThemeObjectTerminalIcon size={18} /><strong>Terminal</strong></div> : null}
      {surfaceKind === 'agent' && phase === 'launch' ? <section className="session-connecting__prompt" aria-label="Initial prompt">
        <div className="session-connecting__prompt-heading">
          <span className="session-connecting__eyebrow">Initial prompt</span>
          {prompt ? <button type="button" className="session-connecting__copy" disabled={copying}
            onClick={() => { void copyPrompt() }} title="Copy the complete initial prompt" aria-label="Copy initial prompt">
            {copied ? <ThemeStatusCopiedIcon size={13} /> : <ThemeActionCopyIcon size={13} />}<span aria-live="polite">{copying ? 'Copying…' : copied ? 'Copied' : 'Copy'}</span>
          </button> : null}
        </div>
        {prompt ? <pre>{prompt}</pre> : <p className="session-connecting__empty">{request
          ? 'No initial prompt was submitted.'
          : phase === 'launch'
            ? 'The initial prompt is unavailable for this launch.'
            : 'The initial prompt is not available while reconnecting.'}</p>}
        {copyError ? <div className="session-connecting__feedback" role="alert">Copy failed: {copyError}</div> : null}
      </section> : null}
      {surfaceKind === 'agent' && phase !== 'launch' ? <SessionRecap
        session={session ?? { hostId: '', agentSessionId: '' }} visible={visible} context /> : null}
    </div>}
  />
}
