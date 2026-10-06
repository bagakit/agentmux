import { AgentMuxError, type NotebookObservationPort, type NoteContentObservation, type NotebookGraph, type NotebookGraphParams } from '@agentmux/core'
import { notebookFingerprint, type NotebookPage, type NotebookState } from '@agentmux/core/notebook-catalog'
import { noteKnowledge, parseNoteFile, resolveNoteBlock, type NoteFileDocument } from '@agentmux/client-ui/note/note-knowledge'
import type { WorkspaceRecord } from '../shared/contracts.js'
import { WORKSPACE_FILE_MAX_BYTES } from '../shared/workspace-file-bytes.js'
import type { WorkspaceFiles } from './workspace-files.js'
import { matchingNoteLinkBlocks, normalizeNoteLinkName, parseNotebookResolveParams, parseNotebookResolveResult, parseNoteWikiQuery, type NoteLinkTarget, type NotebookResolveParams, type NotebookResolveResult } from '@agentmux/core/note-links'
import type { PendingNoteWikiLink } from '@agentmux/client-ui/note/note-wikilinks'

/** Exact durable resources, including closed pages, through the original Files owner. */
export class NotebookObservationOwner implements NotebookObservationPort {
  constructor(private readonly ports: { workspace(id: string): WorkspaceRecord | undefined; files: Pick<WorkspaceFiles, 'read'> }) {}
  private async read(page: NotebookPage, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<{ observation: NoteContentObservation; document?: NoteFileDocument }> {
    const base = { noteId: page.noteId, resource: structuredClone(page.resource) }, original = page.resource
    const workspace = this.ports.workspace(original.workspaceId)
    const unknown = (message: string) => ({ observation: { ...base, status: 'unknown' as const, message } })
    if (!workspace || workspace.hostId !== original.hostId || workspace.path !== original.workspacePath) return unknown('The catalog resource no longer matches the original Host and Workspace. Refresh that mapping before reading; no alternative file was used.')
    try {
      options?.signal?.throwIfAborted()
      const budget = options?.maxBytes === undefined && options?.signal === undefined ? undefined : { maxFileBytes: options.maxBytes ?? WORKSPACE_FILE_MAX_BYTES, ...(options.signal ? { signal: options.signal } : {}) }
      const result = await this.ports.files.read({ ...workspace }, original.path, budget)
      const current = this.ports.workspace(original.workspaceId)
      if (!current || current.hostId !== original.hostId || current.path !== original.workspacePath) return unknown('The original Host or Workspace changed while reading. Retry the exact catalog resource; no body was substituted.')
      if (result.status === 'deleted') return { observation: { ...base, status: 'missing', message: 'The original file owner confirmed this Note file is missing. Its catalog identity is retained.' } }
      if (result.status !== 'read') return unknown(result.status === 'error' ? result.code + ': ' + result.message : 'The original Note resource is ' + result.status + ', not a readable Note body.')
      if (result.document.path !== original.path) return unknown('The file owner returned another resource path. No body was substituted.')
      const document = result.document, parsed = parseNoteFile(document)
      if (parsed.status === 'invalid') return { observation: { ...base, status: 'invalid', revision: document.revision, message: parsed.message } }
      if (parsed.note.noteId !== page.noteId) return { observation: { ...base, status: 'identity-mismatch', revision: document.revision, actualNoteId: parsed.note.noteId, message: 'The original file contains another Note identity. Both identities and bytes are retained; inspect its source before editing.' } }
      const knowledge = noteKnowledge([{ location: { workspaceId: original.workspaceId, path: original.path }, document }])
      return { document, observation: { ...base, status: 'read', revision: document.revision, content: document.content, actualNoteId: parsed.note.noteId, blockIds: [...knowledge.sources[0]!.blocks.keys()] } }
    } catch (error) { options?.signal?.throwIfAborted(); return unknown(error instanceof Error ? error.message : String(error)) }
  }
  async content(state: NotebookState, noteId: string, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<NoteContentObservation> {
    const page = state.pages[noteId]
    if (!page) throw new AgentMuxError('The exact Note is absent from this durable catalog. Refresh the directory without replacing its original file.', 'NOTEBOOK_INPUT_INVALID')
    return (await this.read(page, options)).observation
  }
  async resolve(state: NotebookState, params: NotebookResolveParams, options?: { signal?: AbortSignal }): Promise<NotebookResolveResult> {
    const input = parseNotebookResolveParams(params)
    return parseNotebookResolveResult(await this.resolveUsing(state, input, page => this.read(page, { ...options, ...(input.mode === 'resolve' && input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}) })), input)
  }
  /** One write batch memoizes only its actual candidates; no graph scan or persistent relation cache. */
  async resolvePending(state: NotebookState, pending: readonly PendingNoteWikiLink[], source?: { resource: NotebookPage['resource']; document: NoteFileDocument }): Promise<ReadonlyMap<string, NoteLinkTarget>> {
    const reads = new Map<string, ReturnType<NotebookObservationOwner['read']>>()
    const read = (page: NotebookPage) => {
      const key = notebookFingerprint(page.resource)
      let promise = reads.get(key)
      if (!promise) {
        if (source && notebookFingerprint(source.resource) === key) {
          const parsed = parseNoteFile(source.document), knowledge = noteKnowledge([{ location: { workspaceId: page.resource.workspaceId, path: page.resource.path }, document: source.document }])
          promise = parsed.status === 'valid' && parsed.note.noteId === page.noteId ? Promise.resolve({ document: source.document, observation: { status: 'read' as const, noteId: page.noteId, resource: page.resource, revision: source.document.revision, content: source.document.content, actualNoteId: page.noteId, blockIds: [...knowledge.sources[0]!.blocks.keys()] } }) : this.read(page)
        } else promise = this.read(page)
        reads.set(key, promise)
      }
      return promise
    }
    const targets = new Map<string, NoteLinkTarget>()
    for (const link of pending) {
      const result = await this.resolveUsing(state, { mode: 'resolve', text: link.text }, read)
      if (result.mode === 'resolve' && result.result.status === 'resolved') targets.set(link.referenceId, result.result.target)
    }
    return targets
  }
  private async resolveUsing(state: NotebookState, params: NotebookResolveParams, read: (page: NotebookPage) => ReturnType<NotebookObservationOwner['read']>): Promise<NotebookResolveResult> {
    const pages = Object.values(state.pages), candidate = (page: NotebookPage) => ({ noteId: page.noteId, notebookId: page.notebookId, title: page.title, resource: structuredClone(page.resource) })
    if (params.mode === 'search') {
      const query = normalizeNoteLinkName(params.query).toLowerCase(), all = pages.filter(page => normalizeNoteLinkName(page.title).toLowerCase().includes(query))
      const candidates = all.slice(0, params.limit ?? 20).map(candidate)
      return { mode: 'search', catalogRevision: state.revision, query: params.query, candidates, total: all.length, truncated: all.length > candidates.length }
    }
    const parsed = parseNoteWikiQuery(params.text)
    if (parsed.status !== 'valid') throw new AgentMuxError(parsed.message, 'INVALID_CONTROL_REQUEST')
    const matching = pages.filter(page => normalizeNoteLinkName(page.title) === parsed.query.page), candidates = matching.map(candidate)
    const base = { mode: 'resolve' as const, catalogRevision: state.revision, text: params.text, query: parsed.query, candidates }
    const unavailable = (status: 'ambiguous' | 'missing' | 'unknown', stage: 'page' | 'original' | 'fragment', message: string): NotebookResolveResult => ({ ...base, blocks: [], observation: null, result: { status, stage, message } })
    const selected = params.select ? matching.find(page => page.noteId === params.select!.noteId) : matching.length === 1 ? matching[0] : undefined
    if (!selected) return unavailable(matching.length > 1 ? 'ambiguous' : matching.length === 0 ? 'missing' : 'unknown', 'page', matching.length > 1 ? 'Several original pages have this title. Choose an exact Note ID; no first match was selected.' : 'This page query or selected identity is not confirmed in this catalog. Its original text is retained.')
    const { observation, document } = await read(selected), { content: _content, ...metadata } = observation as NoteContentObservation & { content?: string }
    if (observation.status !== 'read' || !document) return { ...base, blocks: [], observation: metadata, result: { status: observation.status === 'missing' ? 'missing' : 'unknown', stage: 'original', message: 'message' in observation ? observation.message : 'The original file is not confirmed.' } }
    const knowledge = noteKnowledge([{ location: { workspaceId: selected.resource.workspaceId, path: selected.resource.path }, document }])
    const blocks = [...knowledge.sources[0]!.blocks.values()].map(block => ({ blockId: block.blockId, text: block.text, type: block.content.type! }))
    const resultBase = { ...base, blocks, observation: metadata }
    if (!parsed.query.fragment) return { ...resultBase, result: { status: 'resolved', target: { noteId: selected.noteId } } }
    const matches = params.select?.blockId ? blocks.filter(block => block.blockId === params.select!.blockId) : matchingNoteLinkBlocks(blocks, parsed.query.fragment)
    if (matches.length !== 1) return { ...resultBase, result: { status: matches.length ? 'ambiguous' : 'missing', stage: 'fragment', message: matches.length ? 'Several original blocks match. Choose their exact Block ID; no first match was selected.' : 'This heading or block is absent from the confirmed original. The query is retained.' } }
    return { ...resultBase, result: { status: 'resolved', target: { noteId: selected.noteId, blockId: matches[0]!.blockId } } }
  }
  async graph(state: NotebookState, params: NotebookGraphParams, options?: { signal?: AbortSignal }): Promise<NotebookGraph> {
    if (params.noteId && !state.pages[params.noteId] || params.notebookId && !state.notebooks[params.notebookId]) throw new AgentMuxError('The requested original Note or Notebook is absent from this durable catalog. Refresh its directory.', 'NOTEBOOK_INPUT_INVALID')
    const selected = new Set(Object.values(state.pages).filter(p => params.noteId ? p.noteId === params.noteId : params.notebookId ? p.notebookId === params.notebookId : true).map(p => p.noteId))
    const observations: NotebookGraph['observations'] = [], documents: { location: { workspaceId: string; path: string }; document: NoteFileDocument }[] = []
    const resources = new Map<string, NotebookPage['resource']>()
    // Per-file reads/revisions are not a cross-file atomic content snapshot.
    for (const page of Object.values(state.pages)) {
      options?.signal?.throwIfAborted()
      const { observation, document } = await this.read(page, { ...options, ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }) })
      const { content: _body, ...metadata } = observation as NoteContentObservation & { content?: string }
      observations.push(metadata)
      if (document) { const location = { workspaceId: page.resource.workspaceId, path: page.resource.path }; documents.push({ location, document }); resources.set(JSON.stringify([location.workspaceId, location.path]), page.resource) }
    }
    const readable = observations.filter(o => o.status === 'read').length
    const knowledge = noteKnowledge(documents, readable === observations.length ? 'complete' : readable === 0 ? 'unknown' : 'partial')
    const identities = new Map<string, Set<string>>()
    for (const observed of observations) if ('actualNoteId' in observed && observed.actualNoteId) {
      const locations = identities.get(observed.actualNoteId) ?? new Set<string>()
      locations.add(JSON.stringify(observed.resource)); identities.set(observed.actualNoteId, locations)
    }
    const duplicateNoteIds = [...identities].filter(([, locations]) => locations.size > 1).map(([id]) => id)
    const hasUnbound = knowledge.references.some(r => r.target.kind === 'unbound')
    const hasExternalTargets = knowledge.references.some(r => r.target.kind !== 'unbound' && !state.pages[r.target.noteId])
    const graphKnowledge = hasExternalTargets ? { ...knowledge, scope: 'partial' as const } : knowledge
    const observedByNoteId = new Map(observations.map(o => [o.noteId, o]))
    const completeness = observations.every(o => o.status === 'read') && duplicateNoteIds.length === 0 && !hasExternalTargets && !hasUnbound ? 'complete' : knowledge.sources.length === 0 && observations.length > 0 ? 'unknown' : 'partial'
    return {
      catalogRevision: state.revision, scope: params.noteId ? { kind: 'note', noteId: params.noteId } : params.notebookId ? { kind: 'notebook', notebookId: params.notebookId } : { kind: 'catalog' }, scannedScope: 'catalog', completeness, observations, duplicateNoteIds,
      hierarchy: Object.values(state.pages).filter(p => p.parentNoteId && (selected.has(p.noteId) || selected.has(p.parentNoteId))).map(p => ({ parentNoteId: p.parentNoteId!, noteId: p.noteId })),
      references: knowledge.references.filter(r => r.target.kind === 'unbound' || selected.has(r.source.note.noteId) || selected.has(r.target.noteId)).map(r => ({ source: { noteId: r.source.note.noteId, blockId: r.blockId }, sourceResource: resources.get(JSON.stringify([r.source.location.workspaceId, r.source.location.path]))!, target: r.target, occurrence: r.occurrence, mode: r.mode, resolution: r.target.kind === 'unbound' ? 'unbound' : duplicateNoteIds.includes(r.target.noteId) ? 'ambiguous' : observedByNoteId.get(r.target.noteId)?.status === 'missing' ? 'missing' : r.target.kind === 'block' ? resolveNoteBlock(graphKnowledge, r.target).status : observedByNoteId.get(r.target.noteId)?.status === 'read' ? 'resolved' : 'unknown' }))
    }
  }
}
