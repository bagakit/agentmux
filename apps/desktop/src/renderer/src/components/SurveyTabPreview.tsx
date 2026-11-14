import { useEffect, useState, type ReactNode } from 'react'
import { useVisibleWork } from '@agentmux/client-ui/use-visible-work'
import { workbenchRegionBounds } from '@agentmux/layout'
import type { BrowserRecoveryPreview } from '../../../shared/browser-recovery-preview'
import type { WorkbenchSurface, WorkbenchTab } from '../lib/workbench-tabs'
import { api } from '../lib/api'

/** One visible card reads historical artwork; it never captures, wakes or selects content. */
export function SurveyTabPreview({ tab, active, children, placeholders }: {
  tab: WorkbenchTab
  active: boolean
  children: ReactNode
  placeholders?: ReadonlyMap<string, ReactNode> | undefined
}) {
  const { ref, visible } = useVisibleWork<HTMLSpanElement>(active)
  const regions = workbenchRegionBounds(tab.layout.root)
  return <span ref={ref} className="survey-tab-preview" data-split={regions.length > 1 || undefined} aria-hidden="true">
    {regions.map(({ regionId, bounds }) => <span key={regionId} className="survey-tab-preview__region" data-region-id={regionId}
      data-region-kind={tab.regions[regionId]?.kind ?? 'unknown'} style={{ left: `${bounds.x * 100}%`, top: `${bounds.y * 100}%`, width: `${bounds.width * 100}%`, height: `${bounds.height * 100}%` }}>
      <RegionPreview surface={tab.regions[regionId]} visible={visible} placeholder={placeholders?.get(regionId)} />
    </span>)}
    {children}
  </span>
}

/** Each leaf retains its original resource, environment and navigation generation. */
function RegionPreview({ surface, visible, placeholder }: { surface: WorkbenchSurface | undefined; visible: boolean; placeholder: ReactNode }) {
  const browser = surface?.kind === 'browser' ? surface : null
  const key = browser ? JSON.stringify([browser.browserId, browser.workspaceId, browser.mode, browser.profileId, browser.url, browser.navigationId]) : null
  const [loaded, setLoaded] = useState<{ key: string; preview: BrowserRecoveryPreview } | null>(null)
  const preview = loaded?.key === key ? loaded.preview : null
  useEffect(() => {
    if (!visible || !browser || !key || browser.mode === 'normal' && !browser.profileId) return
    let current = true
    void api.browser.getRecoveryPreview(browser.browserId).then(result => {
      if (!current) return
      const candidate = result.status === 'available' ? result.preview : null
      if (candidate && candidate.scope.browserId === browser.browserId && candidate.scope.workspaceId === browser.workspaceId &&
        candidate.scope.mode === browser.mode && candidate.scope.profileId === browser.profileId && candidate.url === browser.url) {
        setLoaded({ key, preview: candidate })
      } else setLoaded(null)
    }).catch(() => { if (current) setLoaded(null) })
    return () => { current = false }
  }, [visible, key])
  return preview ? <img className="survey-tab-preview__image" src={preview.image.dataUrl} alt="" loading="lazy" title="Last viewed preview"
    onError={() => setLoaded(null)} /> : <>
    <span className="survey-tab-preview__placeholder" />
    {placeholder ? <span className="survey-tab-preview__type" title="No stored image preview">{placeholder}</span> : null}
  </>
}
