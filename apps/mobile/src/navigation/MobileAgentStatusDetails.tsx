import { useState } from 'react'
import { ordinaryUnknownAgentStatus, type MobileAgentPresentation } from './mobile-agent-status'
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
      {ordinaryUnknownAgentStatus(presentation) && <p>尚未确认当前运行状态，不代表会话已结束。原会话与已有能力保留，可继续打开原对话。</p>}
      {!presentation && <p>目录尚未提供这条 Agent 的状态资料，可刷新原目录核对。</p>}
      {presentation?.stateLabel && <p className="mobile-agent-status-details__label">{presentation.stateLabel}</p>}
      {presentation?.detail && <p className="mobile-agent-status-details__reason">{presentation.detail}</p>}
      <p className="mobile-agent-status-details__source">来自上次目录读取。刷新后可回到原目录查看新的状态。</p>
      {onRefresh && <button type="button" onClick={() => setNotice(onRefresh() === false
        ? '原目录来源已变化，未刷新。请回到原目录重新打开详情。' : '已请求刷新；回到原目录时重新读取。')}>刷新状态</button>}
      {notice && <p role="status">{notice}</p>}
    </div>
  </details>
}
