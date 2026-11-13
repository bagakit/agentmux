import { useState } from 'react'
import { mobileAgentStateLabel, ordinaryUnknownAgentStatus, type MobileAgentPresentation } from './mobile-agent-status'
import './agent-status.css'

/** Original directory copy stays available on demand; refreshing is read-only. */
export function MobileAgentStatusDetails({ presentation, onRefresh }: {
  presentation: MobileAgentPresentation | undefined; onRefresh?: (() => boolean | void) | undefined
}) {
  const [notice, setNotice] = useState('')
  if (!presentation && !onRefresh) return null
  return <details className="mobile-agent-status-details">
    <summary>状态与来源</summary>
    <div className="mobile-agent-status-details__body">
      {ordinaryUnknownAgentStatus(presentation) && <p>运行状态还没确认，不代表对话已结束，仍可打开对话。</p>}
      {!presentation && <p>目录还没有提供这个 Agent 的状态，可以刷新目录。</p>}
      {/* The same Chinese state the row shows; the Host's label is for its own English surfaces. */}
      {presentation && <p className="mobile-agent-status-details__label">{mobileAgentStateLabel(presentation)}</p>}
      {presentation?.detail && <p className="mobile-agent-status-details__reason">{presentation.detail}</p>}
      <p className="mobile-agent-status-details__source">来自上次目录读取，刷新后在目录中查看新的状态。</p>
      {onRefresh && <button type="button" onClick={() => setNotice(onRefresh() === false
        ? '目录来源已变化，未刷新；请回到目录重新打开详情。' : '已请求刷新，回到目录时重新读取。')}>刷新状态</button>}
      {notice && <p role="status">{notice}</p>}
    </div>
  </details>
}
