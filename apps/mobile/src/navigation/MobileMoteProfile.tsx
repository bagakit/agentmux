import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxMotePresentation } from '@agentmux/core/control'
import { parseFileReadResult, type FileReadResult } from '@agentmux/core/files'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import type { MobileObjectIdentity } from './MobileIdentity'
import { isMoteFilePath, moteFileSources } from '../recovery/mote-file-drafts'
import { createBrowserPlatform } from '../platform/browser'
import { MobileMoteFileEditor } from './MobileMoteFileEditor'

type Props = { identity: MobileObjectIdentity; client: AgentMuxHostedClient | null; visible?: boolean;
  sourcePath?: string | null; onSourceChange?(path: string | null): void;
  copyText?: ClientUiPlatform['copyText'];
  onOpenGoals?(agentSessionId: string): void; onBackChange?(back: (() => void) | null): void }
/** Original source text and saved facts. This surface cannot create, configure or operate a Run. */
export function MobileMoteProfile(props: Props) {
  const content = props.identity.mote?.contentReference ?? props.identity.mote?.facts?.content
  return <MoteProfile key={JSON.stringify([props.identity.mote?.spaceId, content?.hostId, content?.workspaceId, content?.workspacePath, content?.zoneId])} {...props} />
}
function MoteProfile({ identity, client, visible = true, sourcePath, onSourceChange, onOpenGoals, onBackChange, copyText }: Props) {
  const spaceId = identity.mote?.spaceId
  const reference = identity.mote?.contentReference ?? identity.mote?.facts?.content ?? null
  const [facts, setFacts] = useState<AgentMuxMotePresentation | null>(() => identity.mote?.facts ? { ...identity.mote.facts, content: reference } : null)
  const [issue, setIssue] = useState(''), [queryDiagnostic, setQueryDiagnostic] = useState(''), [refresh, setRefresh] = useState(0)
  const [localSource, setLocalSource] = useState<string | null>(null), [reading, setReading] = useState(false)
  const controlled = sourcePath !== undefined
  const selected = controlled ? sourcePath : localSource
  const [files, setFiles] = useState<Record<string, FileReadResult>>({})
  const [observations, setObservations] = useState<Record<string, FileReadResult>>({})
  const [editing, setEditing] = useState(false)
  const [fileIssue, setFileIssue] = useState('')
  const intent = useRef(0)
  const originalContent = useRef(reference)
  useEffect(() => {
    if (!visible || !spaceId) return
    let current = true
    if (client?.forwardRpc) void client.forwardRpc('space.ls', { target: { spaceId }, presentation: true }).then(value => {
      if (!current) return
      setQueryDiagnostic('')
      const original = value.catalog.motePresentation?.find(value => value.spaceId === spaceId)
      if (!original) { setIssue('原 Mote 资料尚未确认；原对象、保存引用与会话保留，可刷新。'); return }
      const next = original.content
      const initial = originalContent.current
      if (initial && next && ['hostId', 'workspaceId', 'workspacePath', 'zoneId'].some(key => initial[key as keyof typeof initial] !== next[key as keyof typeof next])) {
        setIssue('原 Mote 资料映射已改变；本次原引用和已有正文（如有）保留，请重新选择准确对象。'); return
      }
      if (next) originalContent.current = next
      setFacts({ ...original, content: next ?? originalContent.current }); setIssue('')
    }).catch(error => {
      if (current) {
        setQueryDiagnostic(error instanceof Error ? error.message : String(error))
        setIssue('原配置查询尚未重新核实；原对象引用和已确认资料（如有）保留，可刷新原资料。')
      }
    })
    else setIssue('原配置查询端口暂不可用；原对象引用和已确认资料（如有）保留。')
    return () => { current = false }
  }, [client, spaceId, visible, refresh])
  const changeSource = useCallback((path: string | null) => {
    setEditing(false)
    if (!controlled) setLocalSource(path)
    onSourceChange?.(path)
  }, [controlled, onSourceChange])
  const backToProfile = useCallback(() => { intent.current += 1; setReading(false); changeSource(null) }, [changeSource])
  const backToReading = useCallback(() => setEditing(false), [])
  useLayoutEffect(() => {
    if (!visible || !onBackChange) return
    onBackChange(selected ? editing ? backToReading : backToProfile : null)
    return () => onBackChange?.(null)
  }, [Boolean(selected), editing, visible, onBackChange, backToProfile, backToReading])
  const content = facts?.content ?? originalContent.current
  const loadSource = useCallback(async (path: string) => {
    const token = ++intent.current
    if (!visible || !spaceId || !content || !client?.forwardRpc) {
      setReading(false); setFileIssue('原资料读取范围或连接尚未确认；原引用与已有正文（如有）保留，正文待重新读取，可刷新或继续原会话。'); return
    }
    setReading(true); setFileIssue('')
    try {
      const owner = client.runtimeOwnerIdentity?.()
      const params = { zoneId: content.zoneId, spaceId, path,
        expectedResource: { hostId: content.hostId, workspaceId: content.workspaceId, workspacePath: content.workspacePath } }
      const read = parseFileReadResult(await client.forwardRpc('file.read', params), params)
      if (token !== intent.current) return
      const currentOwner = client.runtimeOwnerIdentity?.()
      if (owner && (!currentOwner || currentOwner.runtimeId !== owner.runtimeId || currentOwner.ownerInstanceId !== owner.ownerInstanceId)) {
        setFileIssue('原 Host 读取归属已变化；原引用与已确认正文保留，请重新核对原文件。'); return
      }
      setObservations(previous => ({ ...previous, [path]: read }))
      if (read.result.status === 'read') {
        setFiles(previous => ({ ...previous, [path]: read }))
        setFileIssue('')
      } else setFileIssue(`${'message' in read.result ? read.result.message : `原文件状态：${read.result.status}`}；原引用与已有正文（如有）保留，正文待重新读取。`)
    } catch (error) { if (token === intent.current) setFileIssue(`${error instanceof Error ? error.message : String(error)}；原引用与已有正文（如有）保留，正文待重新读取，可刷新。`) }
    finally { if (token === intent.current) setReading(false) }
  }, [client, spaceId, visible, content?.zoneId, content?.hostId, content?.workspaceId, content?.workspacePath])
  useEffect(() => {
    if (visible && selected) void loadSource(selected)
    return () => { intent.current += 1 }
  }, [visible, selected, loadSource])
  const saved = facts?.quickMode.status === 'saved' ? facts.quickMode : null
  const main = saved?.defaults.conversation
  const read = selected ? files[selected] : undefined
  const document = read?.result.status === 'read' ? read.result.document : null
  return <section className="mobile-mote-profile" aria-label="Mote Profile" data-mote-space-id={spaceId}>
    {issue && <p role="status">{issue}</p>}
    {queryDiagnostic && <details><summary>上次资料查询诊断</summary><p>{queryDiagnostic}</p></details>}
    {facts?.issue && <p role="status">{facts.issue}</p>}
    {selected && editing && spaceId && content && isMoteFilePath(selected) ? <MobileMoteFileEditor
      key={JSON.stringify([spaceId, selected, content])} target={{ spaceId, path: selected, reference: content,
        observation: observations[selected] ?? files[selected] ?? null }} client={client} visible={visible}
      copyText={copyText ?? createBrowserPlatform().copyText} onClose={backToReading}
      onRead={() => { void loadSource(selected) }}
      onSaved={() => { void loadSource(selected); setRefresh(value => value + 1) }} /> : selected ? <section className="mobile-mote-source" aria-label="原 Mote 文件阅读">
      <button type="button" className="mobile-text-button" onClick={backToProfile}>返回 Profile</button>
      <h3>{selected}</h3>
      <button type="button" className="mobile-text-button" onClick={() => { void loadSource(selected) }}>刷新原文件</button>
      {reading && <p role="status">正在读取原文件…</p>}
      {spaceId && content && isMoteFilePath(selected) && <button type="button" className="mobile-text-button" onClick={() => setEditing(true)}>编辑原稿</button>}
      {fileIssue && <p role="status">{fileIssue}</p>}
      {document && <><AgentMarkdown content={document.content} sourcePath={document.path} {...(read?.resource?.workspacePath ? { workspaceRoot: read.resource.workspacePath } : {})} />
        <details><summary>文件来源与修订</summary><p>{document.path}</p><p>{document.revision}</p><p>{read?.resource?.hostId} · {read?.resource?.workspaceId}</p></details></>}
    </section> : <>
      <dl className="mobile-mote-profile__defaults"><dt>原主对话</dt><dd>{main ? <><span>{identity.mote?.conversationName ?? '已保存的原主对话'}</span><small>{facts?.conversation ? '原展示位置已确认' : '保存引用尚未确认；原会话保留'}</small></> : facts?.quickMode.status === 'missing' ? '尚未保存 MOTE.md' : saved ? '未选择主对话' : '原配置未确认'}</dd>
        <dt>新对话 Executor</dt><dd>{saved?.defaults.executorId ?? (saved ? '未设置' : '原配置未确认')}</dd>
        {saved?.defaults.recovery && <><dt>保存的接回时机</dt><dd>{saved.defaults.recovery === 'startup' ? '启动时' : '打开时'}</dd></>}
      </dl>
      {main && <details><summary>主对话原引用</summary><dl>{Object.entries(main).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></details>}
      {facts?.quickMode.status === 'unconfirmed' && <p role="status">{facts.quickMode.message}</p>}
      {main && onOpenGoals && <button type="button" className="mobile-menu-row" onClick={() => onOpenGoals(main.sessionId)}><span>主对话的目标与结果</span></button>}
      <div className="mobile-mote-profile__sources"><h3>原资料</h3>{moteFileSources.map(source => <button type="button" className="mobile-menu-row" key={source.path} aria-label={source.label} onClick={() => changeSource(source.path)}><span>{source.label}</span></button>)}</div>
      <p>资料来自已保存的原文件；当前讨论保留原上下文。</p>
      <button type="button" className="mobile-text-button" onClick={() => setRefresh(value => value + 1)}>刷新原资料</button>
    </>}
  </section>
}
