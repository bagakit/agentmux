import { SemanticIcon } from '@agentmux/client-ui/icons'

/** Compact but persistent observation feedback; opening it never changes a capability. */
export function MobileDirectoryNotice({ issues, retry }: { issues: { source: string; message: string }[]; retry(): void }) {
  if (!issues.length) return null
  return <details className="mobile-directory-notice" role="status">
    <summary><SemanticIcon name="status.warning" size={14} /><span>部分目录信息未确认</span><small>{issues.length} 项 · 详情</small></summary>
    <div><p>已有目录、会话和工作面保留，可继续使用。</p>{issues.map((issue, index) => <p key={index}><strong>{issue.source}</strong><span>{issue.message}</span></p>)}
      <button type="button" onClick={retry}><SemanticIcon name="action.refresh" size={14} />刷新原目录与呈现</button></div>
  </details>
}
