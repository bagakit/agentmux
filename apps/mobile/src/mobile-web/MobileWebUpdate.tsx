import { SemanticIcon } from '@agentmux/client-ui/icons'
import { MobileNotice } from '../notices/MobileNotice'
import { useMobileWebReloadAction } from './use-mobile-web-reload-action'
import { mobileWebUpdateStatus, type MobileWebPageObservation } from './use-mobile-web-observation'

/** This entry observes the original release; applying it is an explicit user action. */
export function MobileWebUpdateSettings({ observation }: { observation: MobileWebPageObservation }) {
  const { busy, issue, reload } = useMobileWebReloadAction(), status = mobileWebUpdateStatus(observation)
  const description = observation.inspection.pending ? '正在检查版本' : status === 'available' ? '有新版本可载入' : status === 'current' ? '已是当前版本' : '版本尚未确认'
  return <section className="mobile-web-update-settings" aria-label="网页更新">
    <div className="mobile-web-update-heading"><SemanticIcon name="action.refresh" size={18} /><span>网页更新<small>{description}</small></span></div>
    <div className="mobile-web-update-actions">
      <button type="button" className="mobile-secondary" onClick={() => { void observation.refresh() }}>检查更新</button>
      <button type="button" className="mobile-secondary" disabled={busy} onClick={() => { void reload() }}>{busy ? '正在保全…' : status === 'available' ? '载入最新版' : '重新打开网页'}</button>
    </div>
    {issue && <MobileNotice identity={[issue.message, issue.attempt]} className="mobile-spatial-notice">{issue.message}</MobileNotice>}
  </section>
}
