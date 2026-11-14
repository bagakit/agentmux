import type { AppWindowOperation } from '@agentmux/core/control'
import type { ReactNode } from 'react'
import { ServiceNoticeDisclosure } from './ServiceNoticeDisclosure'
import { ServiceWindowNotice } from './ServiceWindowNotice'

/** The window owner supplies the facts; this reader only controls disclosure. */
export function WorkbenchWindowNotice({ issue, operations, children }: {
  issue: string | null
  operations: readonly AppWindowOperation[]
  children?: ReactNode
}) {
  const actionTitle = (method: AppWindowOperation['method']) => method === 'app.window.return' ? 'Window return needs attention'
    : method === 'app.window.open' ? 'Opening a window needs attention' : 'Window focus needs attention'
  const restore = 'Your original work remains available. Check the original action before moving this window again.'
  const notices = operations.map(operation => ({ id: operation.input.operationId, notice: {
    kind: 'indeterminate' as const, notice: { step: actionTitle(operation.method),
      mode: operation.message ?? `The original action is ${operation.state}.`, restore }
  } }))
  if (issue) notices.push({ id: 'presentation', notice: { kind: 'indeterminate', notice: {
    step: 'Window presentation needs attention', mode: issue, restore
  } } })
  const title = notices.length === 1 ? notices[0]!.notice.notice.step : 'Window actions need attention'
  return <ServiceNoticeDisclosure scope="workbench:windows" title={title} className="workbench-window-notice"
    notices={notices}>
    {notices.map(item => <ServiceWindowNotice key={item.id} notice={item.notice} />)}
    {children}
  </ServiceNoticeDisclosure>
}
