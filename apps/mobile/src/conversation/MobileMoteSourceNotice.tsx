/** These are original read/role/configuration explanations, not input authority. */
export function MobileMoteSourceNotice({ roleIssue, readingIssue, configurationIssue, refresh, onMain }: {
  roleIssue?: string | undefined; readingIssue?: string | null | undefined; configurationIssue?: string | null | undefined
  refresh(): void; onMain?: (() => void) | undefined
}) {
  if (!roleIssue && !readingIssue && !configurationIssue) return null
  return <details className="mobile-mote-source-status"><summary>主对话信息待核对</summary>
    <dl>{roleIssue && <><dt>主角色</dt><dd>{roleIssue}</dd></>}{readingIssue && <><dt>读取</dt><dd>{readingIssue}</dd></>}
      {configurationIssue && <><dt>配置</dt><dd>{configurationIssue}</dd></>}</dl>
    <button type="button" onClick={refresh}>重新核对主对话信息</button>
    {onMain && <button type="button" onClick={onMain}>返回当前主对话</button>}
  </details>
}
