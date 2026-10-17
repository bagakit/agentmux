import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { BrowserOperationStatus } from '../../../src/renderer/src/components/BrowserOperationSurface'
import type { BrowserSnapshot } from '../../../src/shared/contracts'

declare global { interface Window { isolationProof: {
  stop(id: string): Promise<unknown>; returnControl(): Promise<unknown>;
  observe(callback: (snapshot: BrowserSnapshot) => void): void
} } }
function Proof() {
  const [page, update] = useState<BrowserSnapshot | null>(null)
  useEffect(() => window.isolationProof.observe(update), [])
  return <main style={{ padding: 24 }}><h3>Private Browser control proof</h3>
    <input aria-label="Unrelated Composer" defaultValue="unsent draft" />
    {page?.activity ? <BrowserOperationStatus activity={page.activity} browserId={page.id}
      onTakeControl={() => { if (page.activity?.operation) void window.isolationProof.stop(page.activity.operation.id) }}
      onStop={() => { if (page.activity?.operation) void window.isolationProof.stop(page.activity.operation.id) }}
      onReturnControl={() => { void window.isolationProof.returnControl() }} /> : null}
  </main>
}
createRoot(document.getElementById('root')!).render(<Proof />)
