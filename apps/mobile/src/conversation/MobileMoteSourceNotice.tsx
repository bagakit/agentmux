import { SemanticIcon } from '@agentmux/client-ui/icons'

/** These are original read/role/configuration explanations, not input authority. */
export function MobileMoteSourceNotice({ roleIssue, readingIssue, configurationIssue, refresh, onMain }: {
  roleIssue?: string | undefined; readingIssue?: string | null | undefined; configurationIssue?: string | null | undefined
  refresh(): void; onMain?: (() => void) | undefined
}) {
  const count = [roleIssue, readingIssue, configurationIssue].filter(Boolean).length
  if (!count) return null
  // One quiet status chip; the explanations and recovery actions stay one tap away.
  return <details className="mobile-mote-source-status"><summary aria-label={`主对话信息待核对 · ${count} 项`}>
      <span className="mobile-mote-source-status__dot" aria-hidden="true" /><span>主对话信息待核对</span>
      {count > 1 ? <span className="mobile-mote-source-status__count" aria-hidden="true">{count}</span> : null}
      <SemanticIcon className="mobile-mote-source-status__chevron" name="navigation.disclosure" size={12} aria-hidden="true" /></summary>
    <div className="mobile-mote-source-status__panel">
      <dl>{roleIssue && <><dt>主角色</dt><dd>{roleIssue}</dd></>}{readingIssue && <><dt>读取</dt><dd>{readingIssue}</dd></>}
        {configurationIssue && <><dt>配置</dt><dd>{configurationIssue}</dd></>}</dl>
      <div className="mobile-mote-source-status__actions">
        <button type="button" onClick={refresh}>重新核对</button>
        {onMain && <button type="button" onClick={() => onMain()}>返回当前主对话</button>}
      </div>
    </div>
  </details>
}
