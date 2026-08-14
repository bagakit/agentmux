import { useAppStore } from '../store'
import {
  selectDisplacedAgentNotices,
  displacedAgentStepOutcome
} from '../lib/control-spatial-commit'
import { classifyServiceNotice, serviceNoticeToRender } from '../lib/service-window-notice'
import { ServiceWindowNotice } from './ServiceWindowNotice'

/**
 * 「已健康启动、但布局落点没了」的持续告示（T-005）。Agent 进程好好的、还在 session 列表里可被发现，
 * 缺的只是它没落在用户要的地方——启动竞态里那一格被关掉/回收了。
 *
 * 挂在 App 的 `main-shell__notices` 里（与 Runtime 归属 / shell 环境两块同处），这一点是这个告示成立的
 * **全部前提**：它必须停在任何布局操作都搬不动、也毁不掉的地方。若它住在那个消失的 Region/Tab 里，或被
 * 引发错位的同一次重排清掉，用户就回到了原点——第一半已经证明「照 plan.regionId / 旧 tabId 回执」是错的。
 *
 * 要不要显示、显示哪几条，全由 `selectDisplacedAgentNotices` 对**当前** sessions + tabs 重新判定：store
 * 那份 id 列表只增不减、可留陈旧项，这里按活着的 session 与当前布局过滤，死项/已重新安放的自愈消失。
 * 点击「找回」走 `selectSession(agentSessionId)`——只凭 session id 重新解析落点，绝不复用已失效的
 * plan.regionId / 旧 tabId（那正是第一半证伪的假设）。selectSession 给这个 session 建/激活一格后，它进入
 * `placedSessionIds`，选择器随即把它从告示里去掉，告示自愈消失。
 */
export function DisplacedAgentNotice() {
  const sessions = useAppStore((state) => state.sessions)
  const tabs = useAppStore((state) => state.tabs)
  const displacedAgentSessionIds = useAppStore((state) => state.displacedAgentSessionIds)
  const selectSession = useAppStore((state) => state.selectSession)
  const notices = selectDisplacedAgentNotices(sessions, tabs, displacedAgentSessionIds)
  if (notices.length === 0) return null
  return (
    <>
      {notices.map((notice) => {
        const rendered = serviceNoticeToRender(classifyServiceNotice(displacedAgentStepOutcome(notice.label)))
        if (!rendered) return null
        return (
          <div className="displaced-agent-notice" key={notice.agentSessionId}>
            <ServiceWindowNotice notice={rendered} />
            <button
              type="button"
              className="small-button displaced-agent-notice__action"
              onClick={() => selectSession(notice.agentSessionId)}
            >
              Give it a place
            </button>
          </div>
        )
      })}
    </>
  )
}
