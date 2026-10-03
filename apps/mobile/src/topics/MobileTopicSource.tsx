import { useEffect, useRef, useState } from 'react'
import type { AgentMuxRpcResult } from '@agentmux/core'
import type { TopicKnowledgeSource } from '@agentmux/core/control'
import { AgentMarkdown, type OpenHttpLink } from '@agentmux/client-ui/components/AgentMarkdown'
import { MobileNoteFile } from '../navigation/MobileNoteFile'
import { readNoteDocument } from '@agentmux/client-ui/note/note-document'
import type { TopicsRpc } from './MobileTopicKnowledge'
import './topics.css'

type Source = Extract<TopicKnowledgeSource, { kind: 'file' | 'note' | 'notebook' }>
type Workspace = AgentMuxRpcResult<'app.snapshot'>['workspaces'][number]
type Page = AgentMuxRpcResult<'notebook.inspect'>['pages'][number]
type Read = AgentMuxRpcResult<'file.read'>
type Listing = AgentMuxRpcResult<'file.list'>
/** A derived selection of original resource facts, never another File owner. */
export type MobileTopicSourceScope = { zoneId: string; path: string; workspace: Workspace; directoryPath: string }
export type MobileTopicSourceProps = { source: Source; rpc: TopicsRpc; onBack(): void;
  openScope(scope: MobileTopicSourceScope): void | Promise<void>;
  displayPath?: (path: string, hostId: string) => string; openHttpLink?: OpenHttpLink }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
function relativeTo(root: string, path: string): string | null {
  const directory = root.replace(/\/+$/u, '') || '/', prefix = directory === '/' ? '/' : directory + '/'
  return path === directory ? '.' : path.startsWith(prefix) ? path.slice(prefix.length) : null
}
const params = (scope: MobileTopicSourceScope) => ({ zoneId: scope.zoneId, path: scope.path,
  expectedResource: { hostId: scope.workspace.hostId, workspaceId: scope.workspace.workspaceId, workspacePath: scope.workspace.path } })

export function MobileTopicSource(props: MobileTopicSourceProps) {
  return <SourceReader key={JSON.stringify(props.source)} {...props} />
}
function SourceReader({ source, rpc, onBack, openScope, displayPath, openHttpLink }: MobileTopicSourceProps) {
  const [scopes, setScopes] = useState<MobileTopicSourceScope[]>([]), [pages, setPages] = useState<Page[]>([])
  const [notebookName, setNotebookName] = useState('笔记本'), [selectedPage, setSelectedPage] = useState<string | null>(null)
  const [view, setView] = useState<{ scope: MobileTopicSourceScope; read: Read; listing?: Listing } | null>(null)
  const [issue, setIssue] = useState(''), [readIssue, setReadIssue] = useState(''), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0)
  const intent = useRef(0)
  const pathLabel = (path: string, hostId: string) => displayPath ? displayPath(path, hostId) : path
  useEffect(() => {
    let live = true
    setLoading(true)
    async function discover() {
      if (source.kind === 'notebook') {
        const result = await rpc('notebook.inspect', { notebookId: source.notebookId })
        if (!live) return
        setPages(result.pages); setNotebookName(result.notebook?.name ?? '原笔记本')
        setIssue(result.notebook ? '' : '原笔记本尚未确认，原引用保留。')
        return
      }
      let page: Page | undefined
      if (source.kind === 'note') {
        const result = await rpc('notebook.inspect', { noteId: source.noteId })
        page = result.pages.find(value => value.noteId === source.noteId)
        if (!page) { if (live) setIssue('此 Note 未在原持久目录中确认资源文件；当前公共读取不能仅凭 Note ID 定位正文。原引用保留，可重试目录读取。'); return }
      }
      const [snapshot, spatial] = await Promise.all([rpc('app.snapshot', { include: ['workspaces'] }), rpc('space.ls', { target: {} })])
      if (!live) return
      const resource = page?.resource
      const absolutePath = source.kind === 'file' ? source.path : resource!.workspacePath.replace(/\/+$/u, '') + '/' + resource!.path
      const hostId = source.kind === 'file' ? source.hostId : resource!.hostId
      const candidates: MobileTopicSourceScope[] = []
      for (const zone of spatial.catalog.zones) {
        if (zone.hostId !== hostId || !zone.directoryPath || zone.kind === 'unknown' || page?.workface && zone.zoneId !== page.workface.zoneId) continue
        const workspace = snapshot.workspaces.find(value => value.workspaceId === zone.workspaceId && value.hostId === hostId)
        if (!workspace || resource && (workspace.workspaceId !== resource.workspaceId || workspace.path !== resource.workspacePath)
          || source.kind === 'file' && source.projectId !== undefined && workspace.projectId !== source.projectId) continue
        let path = relativeTo(zone.directoryPath, absolutePath)
        if (path === null && page?.workface && resource) {
          // Ask the original Files owner for its mapping; do not recreate Scratch logical paths.
          const mapping = await rpc('file.list', { zoneId: zone.zoneId, path: '.', expectedResource: {
            hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath } })
          if (!live) return
          if (mapping.resource) path = relativeTo(mapping.resource.path, resource.path)
        }
        if (path !== null) candidates.push({ zoneId: zone.zoneId, path, workspace, directoryPath: zone.directoryPath })
      }
      setScopes(candidates)
      const unavailable = snapshot.unavailable.map(value => `${value.message} ${value.recovery ?? ''}`).join('\n')
      setIssue(candidates.length ? unavailable : `${unavailable ? unavailable + '\n' : ''}原来源的 Host、资源 Workspace 与 Zone 尚未共同确认。原路径引用保留，可重试；不会按当前项目或首个 Zone 猜读。`)
      if (candidates.length === 1) await read(candidates[0]!, () => live)
    }
    void discover().catch(error => { if (live) setIssue(`来源发现失败：${message(error)}。原阅读与引用保留，可重试。`) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false; intent.current += 1 }
  }, [rpc, refresh]) // SourceReader is keyed by the complete original source reference.
  async function read(scope: MobileTopicSourceScope, live: () => boolean = () => true) {
    const token = ++intent.current
    try {
      const result = await rpc('file.read', params(scope))
      if (!live() || token !== intent.current) return
      if (result.result.status === 'unknown' || result.result.status === 'error') { setReadIssue(`原文件读取未确认：${result.result.message}。上次正文保留，可重试。`); return }
      if (source.kind === 'note' && result.result.status === 'read') {
        const note = readNoteDocument(result.result.document.content)
        if (note.status !== 'valid' || note.note.noteId !== source.noteId) throw new Error('原文件未确认同一 Note 身份；原引用保留')
      }
      if (result.result.status === 'directory') {
        const listing = await rpc('file.list', params(scope))
        if (!live() || token !== intent.current) return
        if (listing.result.status === 'unknown') { setReadIssue(`目录读取未确认：${listing.result.message}。上次阅读保留。`); return }
        setView({ scope, read: result, listing })
      } else setView({ scope, read: result })
      setReadIssue('')
    } catch (error) { if (live() && token === intent.current) setReadIssue(`原文件读取失败：${message(error)}。上次阅读保留，可重试。`) }
  }
  useEffect(() => () => { intent.current += 1 }, [])
  function open(scope: MobileTopicSourceScope) {
    void Promise.resolve().then(() => openScope(scope)).catch(error => setReadIssue(`原工作面打开失败：${message(error)}。当前阅读保留。`))
  }
  return <section className="mobile-topics mobile-topic-source" aria-label="原来源阅读">
    <header className="mobile-topics-actions"><button onClick={onBack}>返回知识</button><h1>{source.kind === 'notebook' ? notebookName : '原来源'}</h1><button onClick={() => setRefresh(value => value + 1)}>重试读取</button></header>
    {loading && <p role="status">正在读取原来源…</p>}
    {issue && <p className="mobile-topics-issue" role="status">{issue}</p>}
    {readIssue && <p className="mobile-topics-issue" role="status">{readIssue}<button onClick={() => { if (view) void read(view.scope); else setRefresh(value => value + 1) }}>重试原文件</button></p>}
    <details><summary>来源引用</summary>{source.kind === 'file' ? <p>{pathLabel(source.path, source.hostId)}</p> : <code>{source.kind === 'note' ? source.noteId : source.notebookId}</code>}</details>
    {source.kind === 'notebook' && <><ul className="mobile-topics-list">{pages.map(page => <li key={page.noteId}><button onClick={() => setSelectedPage(page.noteId)}><strong>{page.title}</strong><small>{pathLabel(page.resource.path, page.resource.hostId)}{page.archivedAt !== undefined ? ' · 已归档' : ''}</small></button></li>)}</ul>
      {selectedPage && <MobileTopicSource source={{ kind: 'note', noteId: selectedPage }} rpc={rpc} onBack={() => setSelectedPage(null)} openScope={openScope} {...(displayPath ? { displayPath } : {})} {...(openHttpLink ? { openHttpLink } : {})} />}</>}
    {scopes.length === 1 && <div className="mobile-topics-actions"><strong>{scopes[0]!.workspace.name}</strong><button onClick={() => open(scopes[0]!)}>打开原工作面</button></div>}
    {scopes.length > 1 && <><p>原来源有多个准确资源范围，请选择：</p><ul className="mobile-topics-list">{scopes.map(scope => <li key={scope.zoneId}><button onClick={() => { void read(scope) }}><strong>{scope.workspace.name}</strong><small>{pathLabel(scope.directoryPath, scope.workspace.hostId)}</small></button><button onClick={() => open(scope)}>打开此原工作面</button></li>)}</ul></>}
    {view && <article className="mobile-topic-reading">
      <strong>{view.scope.workspace.name}</strong>
      <p>{pathLabel(view.scope.directoryPath, view.scope.workspace.hostId)} / {view.scope.path}</p>
      {view.read.result.status === 'read' && <>
        {source.kind === 'file' && source.revision && source.revision !== view.read.result.document.revision && <p role="status">当前保存版本与来源记录的版本不同；以下为原文件当前正文。</p>}
        {source.kind === 'note' || view.read.result.document.path.endsWith('.note.json')
          ? <MobileNoteFile rpc={rpc} params={params(view.scope)} read={view.read}
            {...(source.kind === 'note' && source.blockId ? { target: { noteId: source.noteId, blockId: source.blockId } } : {})} />
          : <AgentMarkdown content={view.read.result.document.content} workspaceRoot={view.scope.directoryPath} sourcePath={view.scope.path} documentMode
            openWorkspaceFile={path => { const relative = relativeTo(view.scope.directoryPath, path); if (relative !== null) void read({ ...view.scope, path: relative }) }}
            {...(openHttpLink ? { openHttpLink } : {})} />}
      </>}
      {view.read.result.status === 'binary' && <p role="status">原文件是二进制内容（{view.read.result.byteLength} bytes），公共文本 reader 不返回正文；可打开原工作面。</p>}
      {view.read.result.status === 'deleted' && <p role="status">原 Files owner 确认此路径已不存在，原来源引用仍保留。</p>}
      {view.listing?.result.status === 'listed' && <><p>{view.listing.result.complete ? '已确认目录' : `目录部分可读 · ${view.listing.result.partialReason}`}{view.listing.result.omitted === 'git-ignored' ? ' · 沿原 Git ignore 规则' : ''}</p>
        <ul className="mobile-topics-list">{view.listing.result.files.map(path => <li key={path}><button onClick={() => { void read({ ...view.scope, path: view.scope.path === '.' ? path : view.scope.path.replace(/\/+$/u, '') + '/' + path }) }}>{path}</button></li>)}</ul></>}
    </article>}
  </section>
}
