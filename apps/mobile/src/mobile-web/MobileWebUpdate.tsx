import { useState } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { MobileNotice } from '../notices/MobileNotice'
import { useMobileWebUpdateSafety } from './update-safety'
import { mobileWebUpdateStatus, type MobileWebPageObservation } from './use-mobile-web-observation'

/** This entry observes the original release; applying it is an explicit user action. */
export function MobileWebUpdateSettings({ observation }: { observation: MobileWebPageObservation }) {
  const safety = useMobileWebUpdateSafety(), status = mobileWebUpdateStatus(observation)
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState<{ message: string; attempt: number } | null>(null)
  const apply = async () => {
    if (busy || status !== 'available') return
    setBusy(true); setIssue(null)
    try {
      const result = await safety.apply()
      if (result.status === 'blocked') setIssue(previous => ({ message: result.message, attempt: (previous?.attempt ?? 0) + 1 }))
    } catch {
      setIssue(previous => ({ message: '原页面更新尚未确认；当前工作面和内容保留，请稍后重试。', attempt: (previous?.attempt ?? 0) + 1 }))
    } finally { setBusy(false) }
  }
  const description = observation.inspection.pending ? '正在检查版本' : status === 'available' ? '有新版本可载入' : status === 'current' ? '已是当前版本' : '版本尚未确认'
  return <section className="mobile-web-update-settings" aria-label="网页更新">
    <div className="mobile-web-update-heading"><SemanticIcon name="action.refresh" size={18} /><span>网页更新<small>{description}</small></span></div>
    <div className="mobile-web-update-actions">
      <button type="button" className="mobile-secondary" onClick={() => { void observation.refresh() }}>检查更新</button>
      {status === 'available' && <button type="button" className="mobile-secondary" disabled={busy} onClick={() => { void apply() }}>{busy ? '正在保全…' : '载入最新版'}</button>}
    </div>
    {issue && <MobileNotice identity={[issue.message, issue.attempt]} className="mobile-spatial-notice">{issue.message}</MobileNotice>}
  </section>
}
