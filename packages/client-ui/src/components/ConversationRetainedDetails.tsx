import { useState, type ReactNode } from 'react'

/** First opening mounts expensive raw content. Later closing preserves its DOM,
 * selection and local formatting choices. */
export function ConversationRetainedDetails({ summary, children, className }: { summary: ReactNode; children(): ReactNode; className?: string }) {
  const [presented, setPresented] = useState(false)
  return <details {...(className ? { className } : {})} onToggle={event => { if (event.currentTarget.open) setPresented(true) }}>
    <summary>{summary}</summary>{presented ? children() : null}
  </details>
}
