import { MobileNotice, MobileNoticeScope } from '../notices/MobileNotice'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxMotePresentation } from '@agentmux/core/control'
import { parseFileReadResult, type FileReadResult } from '@agentmux/core/files'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import type { MobileObjectIdentity } from './MobileIdentity'
import { isMoteFilePath, moteFileSources } from '../recovery/mote-file-drafts'
import { createBrowserPlatform } from '../platform/browser'
import { MobileMoteQuickEditor } from './MobileMoteQuickEditor'
import { MobileMoteMainActions } from './MobileMoteMainActions'
import { MobileMoteFileEditor } from './MobileMoteFileEditor'

type Props = { identity: MobileObjectIdentity; client: AgentMuxHostedClient | null; visible?: boolean;
  sourcePath?: string | null; onSourceChange?(path: string | null): void;
  copyText?: ClientUiPlatform['copyText'];
  onOpenGoals?(agentSessionId: string): void; onOpenMain?(): void; onBackChange?(back: (() => void) | null): void }
/** Original source text and saved facts. This surface cannot create, configure or operate a Run. */
export function MobileMoteProfile(props: Props) {
  const content = props.identity.mote?.contentReference ?? props.identity.mote?.facts?.content
  return <MoteProfile key={JSON.stringify([props.identity.mote?.spaceId, content?.hostId, content?.workspaceId, content?.workspacePath, content?.zoneId])} {...props} />
}
function MoteProfile({ identity, client, visible = true, sourcePath, onSourceChange, onOpenGoals, onBackChange, copyText, onOpenMain }: Props) {
  const spaceId = identity.mote?.spaceId
  const reference = identity.mote?.contentReference ?? identity.mote?.facts?.content ?? null
  const [facts, setFacts] = useState<AgentMuxMotePresentation | null>(() => identity.mote?.facts ? { ...identity.mote.facts, content: reference } : null)
  const [issue, setIssue] = useState(''), [queryDiagnostic, setQueryDiagnostic] = useState(''), [refresh, setRefresh] = useState(0)
  const [localSource, setLocalSource] = useState<string | null>(null), [reading, setReading] = useState(false)
  const controlled = sourcePath !== undefined
  const selected = controlled ? sourcePath : localSource
  const [files, setFiles] = useState<Record<string, FileReadResult>>({})
  const [observations, setObservations] = useState<Record<string, FileReadResult>>({})
  const [editing, setEditing] = useState(false), [quickEditing, setQuickEditing] = useState(false)
  const [fileIssue, setFileIssue] = useState('')
  const intent = useRef(0)
  const originalContent = useRef(reference)
  useEffect(() => {
    if (!visible || !spaceId) return
    let current = true
    const controller = new AbortController()
    if (client?.forwardRpc) void client.forwardRpc('space.ls', { target: { spaceId }, presentation: 'status' }, { signal: controller.signal }).then(value => {
      if (!current) return
      setQueryDiagnostic('')
      const original = value.catalog.motePresentation?.find(value => value.spaceId === spaceId)
      if (!original) { setIssue('Mote 资料还没确认，可以刷新。'); return }
      const next = original.content
      const initial = originalContent.current
      if (initial && next && ['hostId', 'workspaceId', 'workspacePath', 'zoneId'].some(key => initial[key as keyof typeof initial] !== next[key as keyof typeof next])) {
        setIssue('Mote 资料位置已改变，请重新选择。'); return
      }
      if (next) originalContent.current = next
      setFacts({ ...original, content: next ?? originalContent.current }); setIssue('')
    }).catch(error => {
      if (current) {
        setQueryDiagnostic(error instanceof Error ? error.message : String(error))
        setIssue('配置还没重新确认，可以刷新资料。')
      }
    })
    else setIssue('连接暂不可用，暂时读不到配置。')
    return () => { current = false; controller.abort() }
  }, [client, spaceId, visible, refresh])
  const changeSource = useCallback((path: string | null) => {
    setEditing(false); setQuickEditing(false)
    if (!controlled) setLocalSource(path)
    onSourceChange?.(path)
  }, [controlled, onSourceChange])
  const backToProfile = useCallback(() => { intent.current += 1; setReading(false); changeSource(null) }, [changeSource])
  const backFromQuick = useCallback(() => setQuickEditing(false), [])
  const backToReading = useCallback(() => setEditing(false), [])
  useLayoutEffect(() => {
    if (!visible || !onBackChange) return
    onBackChange(quickEditing ? backFromQuick : selected ? editing ? backToReading : backToProfile : null)
    return () => onBackChange?.(null)
  }, [Boolean(selected), editing, quickEditing, visible, onBackChange, backToProfile, backToReading, backFromQuick])
  const content = facts?.content ?? originalContent.current
  const loadSource = useCallback(async (path: string) => {
    const token = ++intent.current
    if (!visible || !spaceId || !content || !client?.forwardRpc) {
      setReading(false); setFileIssue('资料的读取范围或连接还没确认，正文待重新读取；可以刷新或继续对话。'); return
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
        setFileIssue('读取期间 Mac 已变化，请刷新文件。'); return
      }
      setObservations(previous => ({ ...previous, [path]: read }))
      if (read.result.status === 'read') {
        setFiles(previous => ({ ...previous, [path]: read }))
        setFileIssue('')
      } else setFileIssue(`${'message' in read.result ? read.result.message : `文件状态：${read.result.status}`}。正文待重新读取，可以刷新重试。`)
    } catch (error) { if (token === intent.current) setFileIssue(`${error instanceof Error ? error.message : String(error)}。正文待重新读取，可以刷新重试。`) }
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
  return <MobileNoticeScope owner={client} identity={[identity.mote?.spaceId,sourcePath]}><section className="mobile-mote-profile" aria-label="Mote Profile" data-mote-space-id={spaceId}>
    {issue && <MobileNotice identity={[identity.mote?.spaceId,issue]} role="status">{issue}</MobileNotice>}
    {queryDiagnostic && <details><summary>上次资料查询诊断</summary><p>{queryDiagnostic}</p></details>}
    {facts?.issue && <MobileNotice identity={[identity.mote?.spaceId,facts?.issue]} role="status">{facts.issue}</MobileNotice>}
    {quickEditing && spaceId && content ? <MobileMoteQuickEditor key={JSON.stringify([spaceId, content])} target={{ spaceId, zoneId: content.zoneId,
      expectedResource: { hostId: content.hostId, workspaceId: content.workspaceId, workspacePath: content.workspacePath } }}
      client={client} visible={visible} copyText={copyText ?? createBrowserPlatform().copyText} onClose={backFromQuick}
      onSaved={() => setRefresh(value => value + 1)} /> : selected && editing && spaceId && content && isMoteFilePath(selected) ? <MobileMoteFileEditor
      key={JSON.stringify([spaceId, selected, content])} target={{ spaceId, path: selected, reference: content,
        observation: observations[selected] ?? files[selected] ?? null }} client={client} visible={visible}
      copyText={copyText ?? createBrowserPlatform().copyText} onClose={backToReading}
      onRead={() => { void loadSource(selected) }}
      onSaved={() => { void loadSource(selected); setRefresh(value => value + 1) }} /> : selected ? <section className="mobile-mote-source" aria-label="Mote 文件阅读">
      <button type="button" className="mobile-text-button" onClick={backToProfile}>返回资料</button>
      <h3>{selected}</h3>
      <button type="button" className="mobile-text-button" onClick={() => { void loadSource(selected) }}>刷新文件</button>
      {reading && <p role="status">正在读取文件…</p>}
      {spaceId && content && isMoteFilePath(selected) && <button type="button" className="mobile-text-button" onClick={() => setEditing(true)}>编辑</button>}
      {fileIssue && <MobileNotice identity={[identity.mote?.spaceId,fileIssue]} role="status">{fileIssue}</MobileNotice>}
      {document && <><AgentMarkdown content={document.content} sourcePath={document.path} {...(read?.resource?.workspacePath ? { workspaceRoot: read.resource.workspacePath } : {})} />
        <details><summary>文件来源与修订</summary><p>{document.path}</p><p>{document.revision}</p><p>{read?.resource?.hostId} · {read?.resource?.workspaceId}</p></details></>}
    </section> : <>
      {spaceId && content && <MobileMoteMainActions client={client} target={{ spaceId, zoneId: content.zoneId, expectedResource: { hostId: content.hostId, workspaceId: content.workspaceId, workspacePath: content.workspacePath } }} visible={visible} onConfigure={() => setQuickEditing(true)} onBound={() => setRefresh(value => value + 1)} onOpenMain={onOpenMain} />}
      {spaceId && content && <button type="button" className="mobile-menu-row" aria-label="编辑快捷配置" onClick={() => setQuickEditing(true)}><span>编辑快捷配置<small>Agent、主对话与自动心跳</small></span></button>}
      <dl className="mobile-mote-profile__defaults"><dt>主对话</dt><dd>{main ? <><span>{identity.mote?.conversationName ?? '已保存的主对话'}</span><small>{facts?.conversation ? '' : '主对话位置还没确认'}</small></> : facts?.quickMode.status === 'missing' ? '尚未保存 MOTE.md' : saved ? '未选择主对话' : '配置未确认'}</dd>
        <dt>新对话 Agent</dt><dd>{saved?.defaults.executorId ?? (saved ? '未设置' : '配置未确认')}</dd>
      </dl>
      {main && <details><summary>主对话引用</summary><dl>{Object.entries(main).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></details>}
      {facts?.quickMode.status === 'unconfirmed' && <MobileNotice identity={[identity.mote?.spaceId,JSON.stringify(facts?.quickMode)]} role="status">{facts.quickMode.message}</MobileNotice>}
      {main && onOpenGoals && <button type="button" className="mobile-menu-row" onClick={() => onOpenGoals(main.sessionId)}><span>主对话的目标与结果</span></button>}
      <div className="mobile-mote-profile__sources"><h3>资料</h3>{moteFileSources.map(source => <button type="button" className="mobile-menu-row" key={source.path} aria-label={source.label} onClick={() => changeSource(source.path)}><span>{source.label}</span></button>)}</div>
      <p>资料来自 Mote 中保存的文件。</p>
      <button type="button" className="mobile-text-button" onClick={() => setRefresh(value => value + 1)}>刷新资料</button>
    </>}
  </section></MobileNoticeScope>
}
