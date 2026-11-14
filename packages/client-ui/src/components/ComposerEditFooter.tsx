import type { ReactNode } from 'react'

/** In-flow actions for a compact editor. Callers supply their real buttons and availability. */
export function ComposerEditFooter({ leading, children }: { leading?: ReactNode; children: ReactNode }) {
  return <div className="composer-edit-footer">
    {leading}
    <div className="composer-edit-footer__actions">{children}</div>
  </div>
}
