import { useEffect, useState, type ReactNode } from 'react'
import { useVisibleWork } from '@agentmux/client-ui/use-visible-work'
import type { BrowserRecoveryPreview } from '../../../shared/browser-recovery-preview'
import type { BrowserWorkbenchSurface } from '../lib/workbench-tabs'
import { api } from '../lib/api'

/** Optional last-seen artwork. This reader never captures, wakes or selects a page. */
export function SurveyTabPreview({ browser, active, children }: {
  browser: BrowserWorkbenchSurface | null
  active: boolean
  children: ReactNode
}) {
  const { ref, visible } = useVisibleWork<HTMLSpanElement>(active && browser !== null)
  const key = browser ? JSON.stringify([browser.browserId, browser.workspaceId, browser.mode, browser.profileId, browser.url, browser.navigationId]) : null
  const [loaded, setLoaded] = useState<{ key: string; preview: BrowserRecoveryPreview } | null>(null)
  const preview = loaded?.key === key ? loaded.preview : null
  useEffect(() => {
    if (!visible || !browser || !key || browser.mode === 'normal' && !browser.profileId) return
    let current = true
    void api.browser.getRecoveryPreview(browser.browserId).then(result => {
      if (!current) return
      const candidate = result.status === 'available' ? result.preview : null
      // Historical navigation may predate a reload; the original page and environment must match.
      if (candidate && candidate.scope.browserId === browser.browserId && candidate.scope.workspaceId === browser.workspaceId &&
        candidate.scope.mode === browser.mode && candidate.scope.profileId === browser.profileId && candidate.url === browser.url) {
        setLoaded({ key, preview: candidate })
      } else setLoaded(null)
    }).catch(() => { if (current) setLoaded(null) })
    return () => { current = false }
  }, [visible, key])
  return <span ref={ref} className="survey-tab-preview" data-preview={Boolean(preview) || undefined} title={preview ? 'Last viewed preview' : undefined} aria-hidden="true">
    {preview ? <img className="survey-tab-preview__image" src={preview.image.dataUrl} alt="" loading="lazy"
      onError={() => setLoaded(null)} /> : <span className="survey-tab-preview__placeholder" />}
    {children}
  </span>
}
