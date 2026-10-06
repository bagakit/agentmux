import { NOTE_FILE_EXTENSION } from '@agentmux/client-ui/note/note-format'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentMuxRpcResult } from '@agentmux/core'
import type { TopicKnowledgeSource } from '@agentmux/core/control'
import { AgentMarkdown, type OpenHttpLink } from '@agentmux/client-ui/components/AgentMarkdown'
import { MobileNoteFile } from '../navigation/MobileNoteFile'
import { readNoteDocument } from '@agentmux/client-ui/note/note-document'
import type { TopicsRpc } from './MobileTopicKnowledge'
import { sameTopicFileResource, sameTopicNoteMapping, type MobileTopicFileReference, type MobileTopicNoteMapping, type MobileTopicSourceContentReference } from './source-reference'
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
  displayPath?: (path: string, hostId: string) => string; openHttpLink?: OpenHttpLink;
  visible?: boolean; onBackChange?(back: (() => void) | null): void; backLabel?: string;
  initialReference?: MobileTopicSourceContentReference; onReferenceChange?(reference: MobileTopicSourceContentReference): void }
type SourceView = { scope: MobileTopicSourceScope; read: Read; listing?: Listing }
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
function SourceReader({ source, rpc, onBack, openScope, displayPath, openHttpLink, onBackChange, initialReference, onReferenceChange, visible = true, backLabel = '返回知识' }: MobileTopicSourceProps) {
  const reference = useRef<MobileTopicSourceContentReference>(initialReference ?? (source.kind === 'notebook'
    ? { kind: 'notebook', selectedNote: null } : source.kind === 'note' ? { kind: 'note', mapping: null, trail: [] } : { kind: 'file', trail: [] }))
  const selected = reference.current.kind === 'notebook' ? reference.current.selectedNote : null
  const noteReferences = useRef(new Map<string, MobileTopicNoteMapping & { trail: MobileTopicFileReference[] }>(selected ? [[selected.noteId, selected]] : []))
  const reportReference = useRef(onReferenceChange); reportReference.current = onReferenceChange
  const mounted = useRef(true), visibleRef = useRef(visible); visibleRef.current = visible
  const restoring = useRef(reference.current.kind !== 'notebook' && reference.current.trail.length > 0)
  const [scopes, setScopes] = useState<MobileTopicSourceScope[]>([]), [pages, setPages] = useState<Page[]>([])
  const [notebookName, setNotebookName] = useState('笔记本'), [selectedPage, setSelectedPage] = useState<string | null>(selected?.noteId ?? null)
  const selectedPageRef = useRef(selectedPage); selectedPageRef.current = selectedPage
  const [notebookReady, setNotebookReady] = useState(false)
  const [noteName, setNoteName] = useState('原 Note')
  const [view, setView] = useState<SourceView | null>(null), [history, setHistory] = useState<SourceView[]>([])
  const [visitedPages, setVisitedPages] = useState<string[]>(selected ? [selected.noteId] : [])
  const [pageBack, setPageBack] = useState<{ noteId: string; back: () => void } | null>(null)
  const [requestedScope, setRequestedScope] = useState<MobileTopicSourceScope | null>(null)
  const [issue, setIssue] = useState(''), [queryDiagnostic, setQueryDiagnostic] = useState(''), [readIssue, setReadIssue] = useState(''), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0)
  const intent = useRef(0)
  const viewRef = useRef(view); viewRef.current = view
  const historyRef = useRef(history); historyRef.current = history
  const onBackRef = useRef(onBack); onBackRef.current = onBack
  const leaveSource = useCallback(() => { intent.current += 1; onBackRef.current() }, [])
  function publish(next: MobileTopicSourceContentReference) {
    if (!mounted.current || !visibleRef.current) return
    reference.current = next; reportReference.current?.(next)
  }
  const backToNotebook = useCallback(() => { selectedPageRef.current = null; setSelectedPage(null); publish({ kind: 'notebook', selectedNote: null }) }, [])
  const backToPrevious = useCallback(() => {
    const previous = historyRef.current.at(-1)
    if (!previous) {
      if (reference.current.kind !== 'notebook' && reference.current.trail.length > 1) {
        intent.current += 1; publish({ ...reference.current, trail: reference.current.trail.slice(0, -1) }); setRefresh(value => value + 1)
      }
      return
    }
    intent.current += 1; setView(previous); setHistory(values => values.slice(0, -1)); setReadIssue(''); setRequestedScope(null)
    if (reference.current.kind !== 'notebook') publish({ ...reference.current, trail: reference.current.trail.slice(0, -1) })
  }, [])
  const backToScopes = useCallback(() => {
    intent.current += 1; setView(null); setHistory([]); setReadIssue(''); setRequestedScope(null)
    if (reference.current.kind !== 'notebook') publish({ ...reference.current, trail: [] })
  }, [])
  const reportPageBack = useCallback((noteId: string, back: (() => void) | null) => {
    setPageBack(previous => back ? previous?.noteId === noteId && previous.back === back ? previous : { noteId, back }
      : previous?.noteId === noteId ? null : previous)
  }, [])
  const activeBack = selectedPage ? pageBack?.noteId === selectedPage ? pageBack.back : backToNotebook
    : history.length || reference.current.kind !== 'notebook' && reference.current.trail.length > 1 ? backToPrevious : view && scopes.length > 1 ? backToScopes : leaveSource
  useLayoutEffect(() => {
    if (!visible || !onBackChange) return
    onBackChange(activeBack)
    return () => onBackChange(null)
  }, [visible, onBackChange, activeBack])
  const pathLabel = (path: string, hostId: string) => displayPath ? displayPath(path, hostId) : path
  const currentFilePath = view?.scope.path ?? (reference.current.kind !== 'notebook' ? reference.current.trail.at(-1)?.target.path : undefined)
    ?? (source.kind === 'file' ? source.path : '')
  useEffect(() => {
    if (!visible) return
    let live = true
    const active = () => live && mounted.current && visibleRef.current
    setLoading(true)
    async function discover() {
      if (source.kind === 'notebook') {
        const result = await rpc('notebook.inspect', { notebookId: source.notebookId })
        if (!active()) return
        setQueryDiagnostic('')
        setPages(result.pages); setNotebookName(result.notebook?.name ?? '原笔记本')
        const saved = reference.current.kind === 'notebook' ? reference.current.selectedNote : null
        if (saved) {
          const matches = result.pages.filter(page => page.noteId === saved.noteId)
          if (!result.notebook || matches.length !== 1 || !sameTopicNoteMapping(saved, pageMapping(matches[0]!, saved.blockId))) {
            setNotebookReady(false); setIssue('原笔记本所选 Note 的资源映射尚未确认或已改变；原页引用、阅读与草稿保留，可重试目录读取。'); return
          }
        }
        setNotebookReady(Boolean(result.notebook))
        setIssue(result.notebook ? '' : '原笔记本尚未确认，原引用保留。')
        return
      }
      let page: Page | undefined
      if (source.kind === 'note') {
        const result = await rpc('notebook.inspect', { noteId: source.noteId })
        if (!active()) return
        setQueryDiagnostic('')
        const matches = result.pages.filter(value => value.noteId === source.noteId)
        page = matches.length === 1 ? matches[0] : undefined
        if (!page) { setIssue('此 Note 未在原持久目录中确认唯一资源文件；当前公共读取不能仅凭 Note ID 定位正文。原引用保留，可重试目录读取。'); return }
        const mapping = pageMapping(page, source.blockId)
        const saved = reference.current.kind === 'note' ? reference.current.mapping : null
        if (saved && !sameTopicNoteMapping(saved, mapping)) {
          setIssue('原 Note 的资源映射已改变；原引用、阅读与草稿保留，可重试目录读取。'); return
        }
        setNoteName(page.title)
        if (reference.current.kind === 'note') publish({ ...reference.current, mapping })
      }
      const [snapshot, spatial] = await Promise.all([rpc('app.snapshot', { include: ['workspaces'] }), rpc('space.ls', { target: {} })])
      if (!active()) return
      setQueryDiagnostic('')
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
          if (!active()) return
          if (mapping.resource) path = relativeTo(mapping.resource.path, resource.path)
        }
        if (path !== null) candidates.push({ zoneId: zone.zoneId, path, workspace, directoryPath: zone.directoryPath })
      }
      const unavailable = snapshot.unavailable.map(value => `${value.message} ${value.recovery ?? ''}`).join('\n')
      setIssue(candidates.length ? unavailable : `${unavailable ? unavailable + '\n' : ''}原来源的 Host、资源 Workspace 与 Zone 尚未共同确认。原路径引用保留，可重试；不会按当前项目或首个 Zone 猜读。`)
      const previous = viewRef.current?.scope
      if (previous && !candidates.some(candidate => candidate.zoneId === previous.zoneId && candidate.workspace.hostId === previous.workspace.hostId
        && candidate.workspace.workspaceId === previous.workspace.workspaceId && candidate.workspace.path === previous.workspace.path
        && candidate.directoryPath === previous.directoryPath)) {
        setIssue('原来源资源映射已改变；已确认范围、引用与已有正文（如有）保留，请重新选择准确来源。'); return
      }
      setScopes(candidates)
      if (previous) await read(previous, active)
      else if (reference.current.kind !== 'notebook' && reference.current.trail.length) {
        const trail = reference.current.trail, restored: SourceView[] = []
        const first = trail[0]!
        if (!candidates.some(scope => scope.zoneId === first.target.zoneId && scope.path === first.target.path
          && scope.workspace.hostId === first.resource.hostId && scope.workspace.workspaceId === first.resource.workspaceId
          && scope.workspace.path === first.resource.workspacePath && scope.directoryPath === first.resource.zonePath)) {
          setIssue('原来源资源映射已改变或尚未确认；原内层引用保留，请重试准确来源。'); return
        }
        for (const pin of trail) {
          const zone = spatial.catalog.zones.find(zone => zone.zoneId === pin.target.zoneId && zone.hostId === pin.resource.hostId
            && zone.workspaceId === pin.resource.workspaceId && zone.directoryPath === pin.resource.zonePath)
          const workspace = snapshot.workspaces.find(workspace => workspace.workspaceId === pin.resource.workspaceId
            && workspace.hostId === pin.resource.hostId && workspace.path === pin.resource.workspacePath)
          if (!zone || !workspace) { setIssue('原来源资源映射已改变或尚未确认；原内层引用保留，请重试准确来源。'); return }
          const next = await read({ zoneId: zone.zoneId, path: pin.target.path, workspace, directoryPath: pin.resource.zonePath }, active, false, pin)
          if (!next || !active()) return
          restored.push(next)
        }
        setHistory(restored.slice(0, -1)); setView(restored.at(-1)!); restoring.current = false
      }
      else if (candidates.length === 1) await read(candidates[0]!, active)
    }
    void discover().catch(error => { if (active()) {
      setQueryDiagnostic(message(error)); setIssue('原来源范围查询尚未重新核实；原引用、已确认范围和已有正文（如有）保留，可重试查询。')
    } })
      .finally(() => { if (active()) setLoading(false) })
    return () => { live = false; intent.current += 1 }
  }, [rpc, refresh, visible]) // SourceReader is keyed by the complete original source reference; cached Back never re-discovers.
  async function read(scope: MobileTopicSourceScope, live: () => boolean = () => mounted.current && visibleRef.current, descend = false, pin?: MobileTopicFileReference): Promise<SourceView | undefined> {
    if (!visibleRef.current) return
    const token = ++intent.current
    setRequestedScope(scope)
    try {
      const result = await rpc('file.read', params(scope))
      if (!live() || token !== intent.current) return
      if (pin && result.resource && !sameTopicFileResource(pin.resource, result.resource)) throw new Error('原来源的 Zone 文件映射已改变；原内层引用、阅读与草稿保留')
      const previous = viewRef.current
      const originalResource = previous?.read.resource
      if (previous?.scope.zoneId === scope.zoneId && originalResource && result.resource
        && ['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'logicalDirectory'].some(key =>
          originalResource[key as keyof typeof originalResource] !== result.resource![key as keyof typeof originalResource])) {
        throw new Error('原来源的 Zone 文件映射已改变；原引用、阅读与草稿保留，请重新选择准确来源')
      }
      if (result.result.status === 'unknown' || result.result.status === 'error') { setReadIssue(`原文件读取未确认：${result.result.message}。原引用和已有正文（如有）保留，可重试。`); return }
      if (source.kind === 'note' && result.result.status === 'read') {
        const note = readNoteDocument(result.result.document.content)
        if (note.status !== 'valid' || note.note.noteId !== source.noteId) throw new Error('原文件未确认同一 Note 身份；原引用保留')
      }
      if (result.result.status === 'directory') {
        const listing = await rpc('file.list', params(scope))
        if (!live() || token !== intent.current) return
        if (result.resource && listing.resource && !sameTopicFileResource(result.resource, listing.resource)) throw new Error('原来源目录的 Zone 文件映射已改变；原内层引用、阅读与草稿保留')
        if (listing.result.status === 'unknown') { setReadIssue(`目录读取未确认：${listing.result.message}。上次阅读保留。`); return }
        const next = { scope, read: result, listing }
        if (!pin) retain(next)
        setReadIssue(''); return next
      }
      const next = { scope, read: result }
      if (!pin) retain(next)
      setReadIssue('')
      return next
    } catch (error) { if (live() && token === intent.current) setReadIssue(`原文件读取失败：${message(error)}。原引用和已有正文（如有）保留，可重试。`) }
    function retain(next: SourceView) {
      const previous = viewRef.current
      const child = descend && previous && JSON.stringify(params(previous.scope)) !== JSON.stringify(params(scope))
      if (child) setHistory(values => [...values, previous])
      setView(next)
      if (next.read.resource && reference.current.kind !== 'notebook') {
        const item = { target: params(next.scope), resource: next.read.resource }
        const trail = reference.current.trail
        const sameTarget = JSON.stringify(trail.at(-1)?.target) === JSON.stringify(item.target)
        if (!child && !sameTarget) setHistory([])
        publish({ ...reference.current, trail: child ? [...trail, item] : sameTarget ? [...trail.slice(0, -1), item] : [item] })
      }
    }
  }
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; intent.current += 1 } }, [])
  const reportNoteReference = useCallback((noteId: string, next: MobileTopicSourceContentReference) => {
    const original = noteReferences.current.get(noteId)
    if (!original || next.kind !== 'note' || !next.mapping || !sameTopicNoteMapping(original, next.mapping)) return
    const selected = { ...original, trail: next.trail }
    noteReferences.current.set(noteId, selected)
    if (selectedPageRef.current === noteId) publish({ kind: 'notebook', selectedNote: selected })
  }, [])
  function selectPage(page: Page) {
    const original = noteReferences.current.get(page.noteId), mapping = pageMapping(page, original?.blockId)
    if (original && !sameTopicNoteMapping(original, mapping)) { setIssue('此 Note 的资源映射已改变；原页引用、阅读与草稿保留。'); return }
    const selected = original ?? { ...mapping, trail: [] }
    noteReferences.current.set(page.noteId, selected); selectedPageRef.current = page.noteId; setSelectedPage(page.noteId)
    setVisitedPages(values => values.includes(page.noteId) ? values : [...values, page.noteId])
    publish({ kind: 'notebook', selectedNote: selected })
  }
  function open(scope: MobileTopicSourceScope) {
    void Promise.resolve().then(() => openScope(scope)).catch(error => setReadIssue(`原工作面打开失败：${message(error)}。当前阅读保留。`))
  }
  return <section className="mobile-topics mobile-topic-source-reader" aria-label="原来源阅读" hidden={!visible}>
    <div hidden={Boolean(selectedPage)}>
    <header className="mobile-topics-actions"><button onClick={activeBack}>{history.length ? '返回上层来源' : view && scopes.length > 1 ? '返回来源范围' : backLabel}</button><div className="mobile-topics-heading"><small>{source.kind === 'notebook' ? '原笔记本' : '知识来源'}</small><h1>{source.kind === 'notebook' ? notebookName : source.kind === 'note' ? noteName : currentFilePath.split('/').at(-1) || '原文件'}</h1></div><button onClick={() => setRefresh(value => value + 1)}>重试读取</button></header>
    {loading && <p role="status">正在读取原来源…</p>}
    {issue && <p className="mobile-topics-issue" role="status">{issue}</p>}
    {queryDiagnostic && <details><summary>上次来源查询诊断</summary><p>{queryDiagnostic}</p></details>}
    {readIssue && <p className="mobile-topics-issue" role="status">{readIssue}<button onClick={() => { if (requestedScope && !restoring.current) void read(requestedScope, undefined, Boolean(view && requestedScope.path !== view.scope.path)); else setRefresh(value => value + 1) }}>重试原文件</button></p>}
    <details><summary>来源引用</summary>{source.kind === 'file' ? <p>{pathLabel(source.path, source.hostId)}</p> : <code>{source.kind === 'note' ? source.noteId : source.notebookId}</code>}</details>
    {source.kind === 'notebook' && <ul className="mobile-topics-list">{pages.map(page => <li key={page.noteId}><button onClick={() => selectPage(page)}><strong>{page.title}</strong><small>{pathLabel(page.resource.path, page.resource.hostId)}{page.archivedAt !== undefined ? ' · 已归档' : ''}</small></button></li>)}</ul>}
    {scopes.length === 1 && <div className="mobile-topics-actions"><strong>{scopes[0]!.workspace.name}</strong><button onClick={() => open(view?.scope ?? scopes[0]!)}>打开原工作面</button>{view && <button onClick={() => { void read(view.scope) }}>刷新原文件</button>}</div>}
    {scopes.length > 1 && <><p>原来源有多个准确资源范围，请选择：</p><ul className="mobile-topics-list">{scopes.map(scope => <li key={scope.zoneId}><button onClick={() => { void read(scope) }}><strong>{scope.workspace.name}</strong><small>{pathLabel(scope.directoryPath, scope.workspace.hostId)}</small></button><button onClick={() => open(scope)}>打开此原工作面</button></li>)}</ul></>}
    {view && <article className="mobile-topic-reading">
      {scopes.length > 1 && <strong>{view.scope.workspace.name}</strong>}
      <details><summary>当前文件位置</summary><p>{pathLabel(view.scope.directoryPath, view.scope.workspace.hostId)} / {view.scope.path}</p></details>
      {view.read.result.status === 'read' && <>
        {source.kind === 'file' && source.revision && scopes.some(scope => JSON.stringify(params(scope)) === JSON.stringify(params(view.scope))) && source.revision !== view.read.result.document.revision && <p role="status">当前保存版本与来源记录的版本不同；以下为原文件当前正文。</p>}
        {source.kind === 'note' || view.read.result.document.path.endsWith(NOTE_FILE_EXTENSION)
          ? <MobileNoteFile rpc={rpc} params={params(view.scope)} read={view.read}
            visible={visible && !selectedPage} {...(source.kind === 'note' && source.blockId ? { target: { noteId: source.noteId, blockId: source.blockId } } : {})} />
          : <AgentMarkdown content={view.read.result.document.content} workspaceRoot={view.scope.directoryPath} sourcePath={view.scope.path} documentMode
            openWorkspaceFile={path => { const relative = relativeTo(view.scope.directoryPath, path); if (relative !== null) void read({ ...view.scope, path: relative }, undefined, true) }}
            {...(openHttpLink ? { openHttpLink } : {})} />}
      </>}
      {view.read.result.status === 'binary' && <p role="status">原文件是二进制内容（{view.read.result.byteLength} bytes），公共文本 reader 不返回正文；可打开原工作面。</p>}
      {view.read.result.status === 'deleted' && <p role="status">原 Files owner 确认此路径已不存在，原来源引用仍保留。</p>}
      {view.listing?.result.status === 'listed' && <><p>{view.listing.result.complete ? '已确认目录' : `目录部分可读 · ${view.listing.result.partialReason}`}{view.listing.result.omitted === 'git-ignored' ? ' · 沿原 Git ignore 规则' : ''}</p>
        <ul className="mobile-topics-list">{view.listing.result.files.map(path => <li key={path}><button onClick={() => { void read({ ...view.scope, path: view.scope.path === '.' ? path : view.scope.path.replace(/\/+$/u, '') + '/' + path }, undefined, true) }}>{path}</button></li>)}</ul></>}
    </article>}
    </div>
    {selectedPage && !notebookReady && <section aria-label="原笔记页待核实"><button onClick={backToNotebook}>返回笔记本</button><p role="status">{issue || '正在核对原笔记本所选页引用…'}</p><button onClick={() => setRefresh(value => value + 1)}>重试读取</button></section>}
    {visitedPages.map(noteId => <div key={noteId} hidden={selectedPage !== noteId || !notebookReady}><NotebookSourcePage source={{ kind: 'note', noteId, ...(noteReferences.current.get(noteId)!.blockId ? { blockId: noteReferences.current.get(noteId)!.blockId! } : {}) }} noteId={noteId} reportBack={reportPageBack} reportReference={reportNoteReference} rpc={rpc} onBack={backToNotebook} visible={visible && notebookReady && selectedPage === noteId} backLabel="返回笔记本" openScope={openScope}
      initialReference={{ kind: 'note', mapping: noteMapping(noteReferences.current.get(noteId)!), trail: noteReferences.current.get(noteId)!.trail }}
      {...(displayPath ? { displayPath } : {})} {...(openHttpLink ? { openHttpLink } : {})} /></div>)}
  </section>
}

function pageMapping(page: Page, blockId?: string): MobileTopicNoteMapping {
  return { noteId: page.noteId, resource: page.resource, ...(page.workface ? { workface: page.workface } : {}), ...(blockId ? { blockId } : {}) }
}
function noteMapping({ trail: _trail, ...mapping }: MobileTopicNoteMapping & { trail: MobileTopicFileReference[] }): MobileTopicNoteMapping { return mapping }
function NotebookSourcePage({ noteId, reportBack, reportReference, ...props }: MobileTopicSourceProps & {
  noteId: string; reportBack(noteId: string, back: (() => void) | null): void; reportReference(noteId: string, reference: MobileTopicSourceContentReference): void
}) {
  const onBackChange = useCallback((back: (() => void) | null) => reportBack(noteId, back), [noteId, reportBack])
  const onReferenceChange = useCallback((reference: MobileTopicSourceContentReference) => reportReference(noteId, reference), [noteId, reportReference])
  return <MobileTopicSource {...props} onBackChange={onBackChange} onReferenceChange={onReferenceChange} />
}
