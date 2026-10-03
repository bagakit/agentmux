import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { FileReadParams, FileReadResult, FileReadResource } from '@agentmux/core/files'
import { NoteReader } from '@agentmux/client-ui/components/NoteReader'
import { readNoteDocument, type NoteBlockTarget } from '@agentmux/client-ui/note/note-document'
import type { NoteFileDocument, NoteLocation } from '@agentmux/client-ui/note/note-knowledge'
import { noteDrafts } from './note-drafts'

type Rpc = NonNullable<AgentMuxHostedClient['forwardRpc']>
export type MobileNoteFileProps = { rpc: Rpc; params: FileReadParams; read: FileReadResult; visible?: boolean; target?: NoteBlockTarget }
function fileScope({ maxBytes: _readLimit, ...scope }: FileReadParams) { return scope }
function originalFileIdentity(params: FileReadParams, resource: FileReadResource | null) {
  return resource ? [resource.hostId, resource.workspaceId, resource.workspacePath, resource.zoneId, resource.zonePath, resource.path, resource.logicalDirectory ?? null]
    : [params.expectedResource.hostId, params.expectedResource.workspaceId, params.expectedResource.workspacePath, params.zoneId, null, params.path, null]
}
function relativePath(resource: FileReadResource, path: string): string | null {
  const root = resource.workspacePath.replace(/\/+$/u, '') || '/'
  const directory = resource.logicalDirectory ?? (resource.zonePath === root ? '' : resource.zonePath.slice((root === '/' ? '/' : root + '/').length))
  if (!directory) return path
  return path.startsWith(directory + '/') ? path.slice(directory.length + 1) : null
}
export function MobileNoteFile(props: MobileNoteFileProps) {
  return <NoteFile key={JSON.stringify(originalFileIdentity(props.params, props.read.resource))} {...props} />
}
function NoteFile({ rpc, params, read, visible = true, target }: MobileNoteFileProps) {
  const [documents, setDocuments] = useState<{ location: NoteLocation; document: NoteFileDocument }[]>([])
  const [reference, setReference] = useState<NoteBlockTarget | null>(null), [candidates, setCandidates] = useState<{ path: string; params: FileReadParams }[]>([])
  const [issue, setIssue] = useState('')
  const intent = useRef(0)
  useEffect(() => () => { intent.current += 1 }, [visible, rpc])
  const parsed = read.result.status === 'read' ? readNoteDocument(read.result.document.content) : null
  const noteId = parsed?.status === 'valid' ? parsed.note.noteId : 'unconfirmed-note'
  const resourceIdentity = JSON.stringify(originalFileIdentity(params, read.resource))
  const draft = useMemo(() => noteDrafts([resourceIdentity, noteId]), [resourceIdentity, noteId])
  async function readCandidate(target: NoteBlockTarget, path: string, token = ++intent.current, scope = params) {
    if (!visible) return
    const result = await rpc('file.read', { ...scope, path })
    if (token !== intent.current) return
    if (result.result.status !== 'read') throw new Error(result.result.status === 'unknown' || result.result.status === 'error' ? result.result.message : `引用原文件状态：${result.result.status}`)
    const document = result.result.document
    const parsed = readNoteDocument(document.content)
    if (parsed.status !== 'valid' || parsed.note.noteId !== target.noteId) throw new Error('所选原文件不是此引用的 Note；原引用与正文保留，请选择准确文件')
    setDocuments(previous => [...previous.filter(value => !(value.location.workspaceId === scope.expectedResource.workspaceId && value.location.path === document.path)), { location: { workspaceId: scope.expectedResource.workspaceId, path: document.path }, document }])
    setReference(null); setCandidates([]); setIssue('')
  }
  async function discover(target: NoteBlockTarget) {
    if (!visible) return
    const token = ++intent.current
    setReference(target); setIssue('正在确认引用原文件…')
    try {
      let pages: import('@agentmux/core/notebook-catalog').NotebookPage[] = []
      let indexIssue = ''
      try {
        const notebook = await rpc('notebook.inspect', { noteId: target.noteId })
        if (token !== intent.current) return
        pages = notebook.pages.filter(page => page.noteId === target.noteId)
      } catch (error) { indexIssue = `原笔记目录暂不可读：${error instanceof Error ? error.message : String(error)}。` }
      if (token !== intent.current) return
      if (pages.length === 1) {
        const page = pages[0]!, resource = page.resource
        const sameResource = resource.hostId === params.expectedResource.hostId && resource.workspaceId === params.expectedResource.workspaceId && resource.workspacePath === params.expectedResource.workspacePath
        let scope: FileReadParams | null = page.workface ? { zoneId: page.workface.zoneId, path: '.', expectedResource: { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath } } : sameResource ? params : null
        if (scope) {
          try {
            const mapping = await rpc('file.list', { ...fileScope(scope), path: '.' })
            if (token !== intent.current) return
            if (!mapping.resource) throw new Error('原引用的 Zone 文件映射未确认')
            const path = relativePath(mapping.resource, resource.path)
            if (path === null) throw new Error('原引用文件不在已确认的原 Zone 范围中')
            await readCandidate(target, path, token, scope); return
          } catch (error) { indexIssue += `原目录映射读取未确认：${error instanceof Error ? error.message : String(error)}。` }
        } else indexIssue += '原笔记资源已确认，但原 Zone 引用尚不可读。'
      } else if (pages.length > 1) indexIssue += '原 Note 身份对应多个文件，须先确认准确来源。'
      // Names only; standalone Note IDs are not encoded in filenames. The user chooses the exact source before its body is read.
      const directory = '.'
      if (token !== intent.current) return
      const listing = await rpc('file.list', { ...fileScope(params), path: directory })
      if (token !== intent.current) return
      if (listing.result.status === 'unknown') throw new Error(listing.result.message)
      setCandidates(listing.result.files.filter(path => path.endsWith('.note.json')).map(path => ({ path: directory === '.' ? path : directory + '/' + path, params })))
      setIssue(`${indexIssue}请为此原块引用选择当前范围中的准确 Note 文件。${!listing.result.complete ? '原文件列表尚不完整，可刷新重试。' : ''}`)
    } catch (error) { if (token === intent.current) setIssue(`引用读取未确认：${error instanceof Error ? error.message : String(error)}。原引用保留，可重试。`) }
  }
  if (read.result.status !== 'read') return null
  const document = read.result.document
  return <>
    {draft.issue && <p role="status">{draft.issue}</p>}
    <NoteReader content={document.content} path={document.path} workspaceId={params.expectedResource.workspaceId} revision={document.revision} documents={documents} target={target}
      readReference={target => { void discover(target) }} editing={read.resource ? { initial: draft.initial, subscribe: draft.subscribe, readDeviceDraft: draft.readDevice, adoptDeviceDraft: draft.adoptDevice,
        onDraft: value => { try { draft.save(value) } catch (error) { setIssue(error instanceof Error ? error.message : String(error)); throw error } },
        save: async (content, expectedRevision) => draft.send(content, expectedRevision, async () => {
          try { return (await rpc('file.write', { ...fileScope(params), expectedResource: read.resource!, content, expectedRevision })).result }
          catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'FILE_RESOURCE_MISMATCH') return { status: 'error', code: error.code, message: error instanceof Error ? error.message : String(error) }
            throw error
          }
        }),
        readCurrent: async () => {
          const result = await rpc('file.read', params)
          if (result.resource && ['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'].some(key => result.resource![key as keyof FileReadResource] !== read.resource![key as keyof FileReadResource])) throw new Error('原文件映射已改变；本次读取不是待确认保存的原文件，草稿与原保存记录保留')
          return result
        } } : undefined} />
    {issue && <p role="status">{issue}</p>}
    {reference && <section aria-label="引用原文件选择"><button type="button" onClick={() => { void discover(reference) }}>刷新引用来源</button><ul>{candidates.map(({ path, params: scope }) => <li key={JSON.stringify([scope, path])}><button type="button" onClick={() => { const token = ++intent.current; void readCandidate(reference, path, token, scope).catch(error => { if (token === intent.current) setIssue(error instanceof Error ? error.message : String(error)) }) }}>{path.split('/').at(-1)}</button></li>)}</ul></section>}
  </>
}
