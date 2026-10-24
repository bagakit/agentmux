import { MobileNotice } from '../notices/MobileNotice'
import { useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { readGoalFileEvidence } from '@agentmux/core/goal-evidence'
import { demandEvidenceLabel, demandEvidenceText, type DemandEvidence } from '@agentmux/demand/goals'
import { useMarkdownCopyText, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { parseHttpLinkUrl } from '@agentmux/client-ui/link-url'

export function MobileGoalEvidence({ evidence, client, copyText }: { evidence: readonly DemandEvidence[]; client: AgentMuxHostedClient | null; copyText?: ClientUiPlatform['copyText'] | undefined }) {
  return <ul className="mobile-goal-evidence">{evidence.map((reference, index) => <Evidence key={`${index}:${demandEvidenceText(reference)}`} reference={reference} client={client} copyText={copyText} />)}</ul>
}
function Evidence({ reference, client, copyText }: { reference: DemandEvidence; client: AgentMuxHostedClient | null; copyText?: ClientUiPlatform['copyText'] | undefined }) {
  const inheritedCopy = useMarkdownCopyText(), copy = copyText ?? inheritedCopy
  const [issue, setIssue] = useState(''), [busy, setBusy] = useState(false), [content, setContent] = useState<string | null>(null)
  const currentClient = useRef(client); currentClient.current = client
  const label = demandEvidenceLabel(reference), original = demandEvidenceText(reference), url = typeof reference === 'string' ? parseHttpLinkUrl(reference) : null
  async function read() {
    if (typeof reference === 'string') return
    setBusy(true); setIssue(''); setContent(null)
    try {
      if (!client?.forwardRpc) throw new Error('原文件读取服务暂不可用，原引用保留。')
      const runtime = client.runtimeOwnerIdentity()
      const observed = await readGoalFileEvidence(reference, params => client.forwardRpc!('file.read', params))
      if (client !== currentClient.current || JSON.stringify(client.runtimeOwnerIdentity()) !== JSON.stringify(runtime)) throw new Error('读取期间原连接发生变化，原引用保留，请重新读取。')
      const result = observed.observation.result
      if (result.status === 'read') setContent(result.document.content)
      else if (result.status !== 'binary') throw new Error(result.status === 'unknown' || result.status === 'error' ? result.message : `原文件状态：${result.status}`)
      const format = result.status === 'binary' ? `原文件为二进制文件（${result.byteLength} 字节），可在桌面查看。` : ''
      const version = observed.version === 'changed' ? '当前文件已不同于报告中的修订；原报告修订保留。' : observed.version === 'unrecorded' ? '报告未记录文件修订，读取的是当前内容。' : ''
      setIssue(format + version)
    } catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  async function copyReference() {
    try {
      if (copy) { if (!await copy(original, error => setIssue(String(error)))) throw new Error('复制未确认，完整引用仍可选取。') }
      else { if (!navigator.clipboard) throw new Error('复制服务暂不可用，完整引用仍可选取。'); await navigator.clipboard.writeText(original) }
    } catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
  }
  return <li>
    {typeof reference !== 'string' ? <button type="button" disabled={busy} onClick={() => void read()}>{busy ? '读取中…' : `查看证据 ${label}`}</button>
      : url ? <a href={url} target="_blank" rel="noopener noreferrer">{label}</a> : <code>{label}</code>}
    <button type="button" onClick={() => void copyReference()}>复制完整引用</button>
    {typeof reference === 'string' && !url ? <small>作者原文引用，未记录本地文件来源。</small> : null}
    {typeof reference !== 'string' ? <details><summary>文件来源与报告修订</summary><code>{original}</code></details> : null}
    {issue ? <MobileNotice identity={[issue]} role="status">{issue}</MobileNotice> : null}
    {content !== null ? <pre className="mobile-region-source">{content}</pre> : null}
  </li>
}
