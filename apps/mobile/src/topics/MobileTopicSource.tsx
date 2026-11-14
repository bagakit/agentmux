import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { MobileHeaderMenu } from '../navigation/MobileHeaderMenu'
import type { MobilePanePresentation } from '../layout/workface-presentation'
import { MobileNotice } from '../notices/MobileNotice'
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
import './source-reader.css'

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
  presentation: MobilePanePresentation; onBackChange?(back: (() => void) | null): void; backLabel?: string;
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
function SourceReader({ source, rpc, onBack, openScope, displayPath, openHttpLink, onBackChange, initialReference, onReferenceChange, presentation, backLabel = '返回知识' }: MobileTopicSourceProps) {
  const reference = useRef<MobileTopicSourceContentReference>(initialReference ?? (source.kind === 'notebook'
    ? { kind: 'notebook', selectedNote: null } : source.kind === 'note' ? { kind: 'note', mapping: null, trail: [] } : { kind: 'file', trail: [] }))
  const selected = reference.current.kind === 'notebook' ? reference.current.selectedNote : null
  const noteReferences = useRef(new Map<string, MobileTopicNoteMapping & { trail: MobileTopicFileReference[] }>(selected ? [[selected.noteId, selected]] : []))
  const reportReference = useRef(onReferenceChange); reportReference.current = onReferenceChange
  const mounted = useRef(true), observedRef = useRef(presentation.observed); observedRef.current = presentation.observed
  const restoring = useRef(reference.current.kind !== 'notebook' && reference.current.trail.length > 0)
  const [scopes, setScopes] = useState<MobileTopicSourceScope[]>([]), [pages, setPages] = useState<Page[]>([])
  const [notebookName, setNotebookName] = useState('笔记本'), [selectedPage, setSelectedPage] = useState<string | null>(selected?.noteId ?? null)
  const selectedPageRef = useRef(selectedPage); selectedPageRef.current = selectedPage
  const [notebookReady, setNotebookReady] = useState(false)
  const [noteName, setNoteName] = useState('笔记')
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
    if (!mounted.current || !observedRef.current) return
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
    if (!presentation.observed || !onBackChange) return
    onBackChange(activeBack)
    return () => onBackChange(null)
  }, [presentation.observed, onBackChange, activeBack])
  const pathLabel = (path: string, hostId: string) => displayPath ? displayPath(path, hostId) : path
  const currentFilePath = view?.scope.path ?? (reference.current.kind !== 'notebook' ? reference.current.trail.at(-1)?.target.path : undefined)
    ?? (source.kind === 'file' ? source.path : '')
  useEffect(() => {
    if (!presentation.observed) return
    let live = true
    const active = () => live && mounted.current && observedRef.current
    setLoading(true)
    async function discover() {
      if (source.kind === 'notebook') {
        const result = await rpc('notebook.inspect', { notebookId: source.notebookId })
        if (!active()) return
        setQueryDiagnostic('')
        setPages(result.pages); setNotebookName(result.notebook?.name ?? '笔记本')
        const saved = reference.current.kind === 'notebook' ? reference.current.selectedNote : null
        if (saved) {
          const matches = result.pages.filter(page => page.noteId === saved.noteId)
          if (!result.notebook || matches.length !== 1 || !sameTopicNoteMapping(saved, pageMapping(matches[0]!, saved.blockId))) {
            setNotebookReady(false); setIssue('所选笔记的文件位置还没确认或已变化，可以重试读取。'); return
          }
        }
        setNotebookReady(Boolean(result.notebook))
        setIssue(result.notebook ? '' : '还没确认这个笔记本，可以重试读取。')
        return
      }
      let page: Page | undefined
      if (source.kind === 'note') {
        const result = await rpc('notebook.inspect', { noteId: source.noteId })
        if (!active()) return
        setQueryDiagnostic('')
        const matches = result.pages.filter(value => value.noteId === source.noteId)
        page = matches.length === 1 ? matches[0] : undefined
        if (!page) { setIssue('没有在目录里找到这条笔记对应的文件，可以重试读取。'); return }
        const mapping = pageMapping(page, source.blockId)
        const saved = reference.current.kind === 'note' ? reference.current.mapping : null
        if (saved && !sameTopicNoteMapping(saved, mapping)) {
          setIssue('这条笔记的文件位置已变化，可以重试读取。'); return
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
      setIssue(candidates.length ? unavailable : `${unavailable ? unavailable + '\n' : ''}还没确认来源所在的 Mac 和工作区，可以重试。`)
      const previous = viewRef.current?.scope
      if (previous && !candidates.some(candidate => candidate.zoneId === previous.zoneId && candidate.workspace.hostId === previous.workspace.hostId
        && candidate.workspace.workspaceId === previous.workspace.workspaceId && candidate.workspace.path === previous.workspace.path
        && candidate.directoryPath === previous.directoryPath)) {
        setIssue('来源位置已变化，请重新选择来源。'); return
      }
      setScopes(candidates)
      if (previous) await read(previous, active)
      else if (reference.current.kind !== 'notebook' && reference.current.trail.length) {
        const trail = reference.current.trail, restored: SourceView[] = []
        const first = trail[0]!
        if (!candidates.some(scope => scope.zoneId === first.target.zoneId && scope.path === first.target.path
          && scope.workspace.hostId === first.resource.hostId && scope.workspace.workspaceId === first.resource.workspaceId
          && scope.workspace.path === first.resource.workspacePath && scope.directoryPath === first.resource.zonePath)) {
          setIssue('来源位置已变化或还没确认，可以重试。'); return
        }
        for (const pin of trail) {
          const zone = spatial.catalog.zones.find(zone => zone.zoneId === pin.target.zoneId && zone.hostId === pin.resource.hostId
            && zone.workspaceId === pin.resource.workspaceId && zone.directoryPath === pin.resource.zonePath)
          const workspace = snapshot.workspaces.find(workspace => workspace.workspaceId === pin.resource.workspaceId
            && workspace.hostId === pin.resource.hostId && workspace.path === pin.resource.workspacePath)
          if (!zone || !workspace) { setIssue('来源位置已变化或还没确认，可以重试。'); return }
          const next = await read({ zoneId: zone.zoneId, path: pin.target.path, workspace, directoryPath: pin.resource.zonePath }, active, false, pin)
          if (!next || !active()) return
          restored.push(next)
        }
        setHistory(restored.slice(0, -1)); setView(restored.at(-1)!); restoring.current = false
      }
      else if (candidates.length === 1) await read(candidates[0]!, active)
    }
    void discover().catch(error => { if (active()) {
      setQueryDiagnostic(message(error)); setIssue('来源范围还没重新确认，可以重试。')
    } })
      .finally(() => { if (active()) setLoading(false) })
    return () => { live = false; intent.current += 1 }
  }, [rpc, refresh, presentation.observed]) // SourceReader is keyed by the complete original source reference; cached Back never re-discovers.
  async function read(scope: MobileTopicSourceScope, live: () => boolean = () => mounted.current && observedRef.current, descend = false, pin?: MobileTopicFileReference): Promise<SourceView | undefined> {
    if (!observedRef.current) return
    const token = ++intent.current
    setRequestedScope(scope)
    try {
      const result = await rpc('file.read', params(scope))
      if (!live() || token !== intent.current) return
      if (pin && result.resource && !sameTopicFileResource(pin.resource, result.resource)) throw new Error('来源文件位置已变化')
      const previous = viewRef.current
      const originalResource = previous?.read.resource
      if (previous?.scope.zoneId === scope.zoneId && originalResource && result.resource
        && ['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'logicalDirectory'].some(key =>
          originalResource[key as keyof typeof originalResource] !== result.resource![key as keyof typeof originalResource])) {
        throw new Error('来源文件位置已变化，请重新选择来源')
      }
      if (result.result.status === 'unknown' || result.result.status === 'error') { setReadIssue(`文件读取没有完成：${result.result.message}。可以重试。`); return }
      if (source.kind === 'note' && result.result.status === 'read') {
        const note = readNoteDocument(result.result.document.content)
        if (note.status !== 'valid' || note.note.noteId !== source.noteId) throw new Error('文件内容不是这条笔记')
      }
      if (result.result.status === 'directory') {
        const listing = await rpc('file.list', params(scope))
        if (!live() || token !== intent.current) return
        if (result.resource && listing.resource && !sameTopicFileResource(result.resource, listing.resource)) throw new Error('来源目录位置已变化')
        if (listing.result.status === 'unknown') { setReadIssue(`目录读取未确认：${listing.result.message}。上次阅读保留。`); return }
        const next = { scope, read: result, listing }
        if (!pin) retain(next)
        setReadIssue(''); return next
      }
      const next = { scope, read: result }
      if (!pin) retain(next)
      setReadIssue('')
      return next
    } catch (error) { if (live() && token === intent.current) setReadIssue(`文件读取失败：${message(error)}。可以重试。`) }
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
    if (original && !sameTopicNoteMapping(original, mapping)) { setIssue('这条笔记的文件位置已变化，可以重试读取。'); return }
    const selected = original ?? { ...mapping, trail: [] }
    noteReferences.current.set(page.noteId, selected); selectedPageRef.current = page.noteId; setSelectedPage(page.noteId)
    setVisitedPages(values => values.includes(page.noteId) ? values : [...values, page.noteId])
    publish({ kind: 'notebook', selectedNote: selected })
  }
  function open(scope: MobileTopicSourceScope) {
    void Promise.resolve().then(() => openScope(scope)).catch(error => setReadIssue(`工作面打开失败：${message(error)}。`))
  }
  return <section className="mobile-topics mobile-topic-source-reader" aria-label="来源阅读" hidden={!presentation.presented}>
    <div hidden={Boolean(selectedPage)}>
    <SourceHeader title={source.kind === 'notebook' ? notebookName : source.kind === 'note' ? noteName : (currentFilePath === '.' && source.kind === 'file' ? source.path : currentFilePath).split('/').at(-1) || '文件'}
      backLabel={history.length ? '返回上层来源' : view && scopes.length > 1 ? '返回来源范围' : backLabel} onBack={activeBack} onRetry={() => setRefresh(value => value + 1)} />
    {loading && <p role="status">正在读取来源…</p>}
    {issue && <MobileNotice identity={[JSON.stringify(source),issue]} className="mobile-topics-issue" role="status">{issue}</MobileNotice>}
    {queryDiagnostic && <details><summary>上次来源查询诊断</summary><p>{queryDiagnostic}</p></details>}
    {readIssue && <MobileNotice identity={[JSON.stringify(requestedScope),readIssue]} className="mobile-topics-issue" role="status">{readIssue}<button onClick={() => { if (requestedScope && !restoring.current) void read(requestedScope, undefined, Boolean(view && requestedScope.path !== view.scope.path)); else setRefresh(value => value + 1) }}>重试此文件</button></MobileNotice>}
    <details className="mobile-source-location"><summary>来源与位置</summary><dl>
      <dt>来源引用</dt><dd>{source.kind === 'file' ? pathLabel(source.path, source.hostId) : source.kind === 'note' ? source.noteId : source.notebookId}</dd>
      {view && <><dt>当前文件位置</dt><dd>{pathLabel(view.scope.directoryPath, view.scope.workspace.hostId)} / {view.scope.path}</dd></>}
    </dl></details>
    {source.kind === 'notebook' && <ul className="mobile-topics-list">{pages.map(page => <li key={page.noteId}><button onClick={() => selectPage(page)}><strong>{page.title}</strong><small>{pathLabel(page.resource.path, page.resource.hostId)}{page.archivedAt !== undefined ? ' · 已归档' : ''}</small></button></li>)}</ul>}
    {scopes.length === 1 && <div className="mobile-topics-actions"><strong>{scopes[0]!.workspace.name}</strong><button onClick={() => open(view?.scope ?? scopes[0]!)}>打开工作面</button>{view && <button onClick={() => { void read(view.scope) }}>刷新文件</button>}</div>}
    {scopes.length > 1 && <><p>来源有多个位置，请选择：</p><ul className="mobile-topics-list">{scopes.map(scope => <li key={scope.zoneId}><button onClick={() => { void read(scope) }}><strong>{scope.workspace.name}</strong><small>{pathLabel(scope.directoryPath, scope.workspace.hostId)}</small></button><button onClick={() => open(scope)}>打开此工作面</button></li>)}</ul></>}
    {view && <article className="mobile-topic-reading">
      {scopes.length > 1 && <strong>{view.scope.workspace.name}</strong>}
      {view.read.result.status === 'read' && <>
        {source.kind === 'file' && source.revision && scopes.some(scope => JSON.stringify(params(scope)) === JSON.stringify(params(view.scope))) && source.revision !== view.read.result.document.revision && <MobileNotice identity={[JSON.stringify(source),JSON.stringify(view.scope),view.read.result.document.revision]} role="status">文件在记录之后已修改，下面是当前内容。</MobileNotice>}
        {source.kind === 'note' || view.read.result.document.path.endsWith(NOTE_FILE_EXTENSION)
          ? <MobileNoteFile rpc={rpc} params={params(view.scope)} read={view.read}
            visible={presentation.observed && !selectedPage} {...(source.kind === 'note' && source.blockId ? { target: { noteId: source.noteId, blockId: source.blockId } } : {})} />
          : <AgentMarkdown content={view.read.result.document.content} workspaceRoot={view.scope.directoryPath} sourcePath={view.scope.path} documentMode
            openWorkspaceFile={path => { void read({ ...view.scope, path }, undefined, true) }}
            {...(openHttpLink ? { openHttpLink } : {})} />}
      </>}
      {view.read.result.status === 'binary' && <p role="status">这是二进制文件（{view.read.result.byteLength} 字节），这里无法显示；可以打开工作面查看。</p>}
      {view.read.result.status === 'deleted' && <p role="status">这个文件已不存在。</p>}
      {view.listing?.result.status === 'listed' && <><p>{view.listing.result.complete ? '已确认目录' : `目录部分可读 · ${view.listing.result.partialReason}`}{view.listing.result.omitted === 'git-ignored' ? ' · 已按 Git ignore 规则省略' : ''}</p>
        <ul className="mobile-topics-list">{view.listing.result.files.map(path => <li key={path}><button onClick={() => { void read({ ...view.scope, path: view.scope.path === '.' ? path : view.scope.path.replace(/\/+$/u, '') + '/' + path }, undefined, true) }}>{path}</button></li>)}</ul></>}
    </article>}
    </div>
    {selectedPage && !notebookReady && <section aria-label="笔记页待核实"><SourceHeader title={pages.find(page => page.noteId === selectedPage)?.title ?? '笔记页'} backLabel="返回笔记本" onBack={backToNotebook} onRetry={() => setRefresh(value => value + 1)} /><MobileNotice dismissible={Boolean(issue)} kind={issue ? "warning" : "feedback"} identity={[JSON.stringify(source),selectedPage,issue]} role="status">{issue || '正在核对所选笔记页…'}</MobileNotice></section>}
    {visitedPages.map(noteId => <div key={noteId} hidden={selectedPage !== noteId || !notebookReady}><NotebookSourcePage source={{ kind: 'note', noteId, ...(noteReferences.current.get(noteId)!.blockId ? { blockId: noteReferences.current.get(noteId)!.blockId! } : {}) }} noteId={noteId} reportBack={reportPageBack} reportReference={reportNoteReference} rpc={rpc} onBack={backToNotebook} presentation={{ presented: presentation.presented && notebookReady && selectedPage === noteId, observed: presentation.observed && notebookReady && selectedPage === noteId }} backLabel="返回笔记本" openScope={openScope}
      initialReference={{ kind: 'note', mapping: noteMapping(noteReferences.current.get(noteId)!), trail: noteReferences.current.get(noteId)!.trail }}
      {...(displayPath ? { displayPath } : {})} {...(openHttpLink ? { openHttpLink } : {})} /></div>)}
  </section>
}

function SourceHeader({ title, backLabel, onBack, onRetry }: { title: string; backLabel: string; onBack(): void; onRetry(): void }) {
  return <header className="mobile-source-header">
    <MobileHeaderMenu />
    <IconButton className="mobile-source-action" aria-label={backLabel} onClick={onBack}><SemanticIcon name="navigation.back" size={18} /></IconButton>
    <h1 className="mobile-source-title">{title}</h1>
    <IconButton className="mobile-source-action" aria-label="重试读取" onClick={onRetry}><SemanticIcon name="action.refresh" size={18} /></IconButton>
  </header>
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
