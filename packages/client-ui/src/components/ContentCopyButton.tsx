import { useEffect, useMemo, useRef, useState } from 'react'
import { useMarkdownCopyText } from '../platform.js'
import { SemanticIcon } from '../theme/icons.js'

/** Copy original content through the host; feedback belongs to this source and attempt. */
export function ContentCopyButton({ text, identity, label, className = '' }: { text: string; identity: unknown; label: string; className?: string }) {
  const copyText = useMarkdownCopyText()
  const owner = useMemo(() => ({}), [text, identity, copyText])
  const latestOwner = useRef(owner); latestOwner.current = owner
  const mounted = useRef(true)
  const actionRef = useRef<{ owner: object; pending: boolean } | null>(null)
  const [copy, setCopy] = useState<{ owner: object; state: 'copying' | 'copied' | 'failed' } | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; actionRef.current = null } }, [])
  const copyState = copy?.owner === owner ? copy.state : 'idle'
  async function copyContent() {
    if (!copyText || !mounted.current || latestOwner.current !== owner || (actionRef.current?.owner === owner && actionRef.current.pending)) return
    const action = { owner, pending: true }; actionRef.current = action
    const current = () => latestOwner.current === owner && actionRef.current === action
    let failed = false, accepted = false
    setCopy({ owner, state: 'copying' })
    try {
      accepted = await copyText(text, () => {
        failed = true
        action.pending = false
        if (current()) setCopy({ owner, state: 'failed' })
      }) === true
    } catch { failed = true }
    action.pending = false
    if (current()) setCopy({ owner, state: accepted && !failed ? 'copied' : 'failed' })
  }
  if (!copyText) return null
  return <button type="button" className={`content-copy ${className}`} aria-label={label} aria-disabled={copyState === 'copying' || undefined} aria-busy={copyState === 'copying' || undefined} onClick={() => { void copyContent() }}>
    <SemanticIcon name={copyState === 'copied' ? 'action.confirm' : copyState === 'failed' ? 'status.failed' : 'action.copy'} size={13} aria-hidden="true" />
    <span role="status" aria-live="polite">{copyState === 'copying' ? 'Copying…' : copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Retry copy' : 'Copy'}</span>
  </button>
}
