import { useMemo } from 'react'
import { useContentCopyAction } from '../lib/use-content-copy-action.js'
import { useMarkdownCopyText } from '../platform.js'
import { SemanticIcon } from '../theme/icons.js'

/** Copy original content through the host; feedback belongs to this source and attempt. */
export function ContentCopyButton({ text, identity, label, actionLabel = 'Copy', className = '', onCopyError }: { text: string; identity: unknown; label: string; actionLabel?: string; className?: string; onCopyError?: ((error: unknown) => void) | undefined }) {
  const copyText = useMarkdownCopyText()
  const identityScope = useMemo(() => ({}), [text, identity])
  const copy = useContentCopyAction(identityScope, copyText)
  const copyState = copy.state
  if (!copyText) return null
  return <button type="button" className={`content-copy ${className}`} data-copy-state={copyState} aria-label={label} aria-disabled={copyState === 'copying' || undefined} aria-busy={copyState === 'copying' || undefined} onClick={() => { void copy.copy(text, onCopyError) }}>
    <SemanticIcon name={copyState === 'copied' ? 'action.confirm' : copyState === 'failed' ? 'status.failed' : 'action.copy'} size={13} aria-hidden="true" />
    <span role="status" aria-live="polite">{copyState === 'copying' ? 'Copying…' : copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Retry copy' : actionLabel}</span>
  </button>
}
