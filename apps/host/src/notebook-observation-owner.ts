import { AgentMuxError, type NotebookObservationPort, type NoteContentObservation, type NoteContentMetadata, type NotebookGraph, type NotebookGraphParams } from '@agentmux/core'
import { notebookFingerprint, type NotebookPage, type NotebookState } from '@agentmux/core/notebook-catalog'
import { noteKnowledge, parseNoteFile, resolveNoteBlock, type NoteFileDocument } from '@agentmux/client-ui/note/note-knowledge'
import type { WorkspaceRecord } from './content-types.js'
import { WORKSPACE_FILE_MAX_BYTES } from './workspace-file-bytes.js'
import type { WorkspaceFiles } from './content-types.js'
import { matchingNoteLinkBlocks, normalizeNoteLinkName, parseNotebookResolveParams, parseNotebookResolveResult, parseNoteWikiQuery, type NoteLinkTarget, type NotebookResolveParams, type NotebookResolveResult } from '@agentmux/core/note-links'
import type { PendingNoteWikiLink } from '@agentmux/client-ui/note/note-wikilinks'
import type { NoteCorpusParams, NoteCorpusResult } from '@agentmux/core'
import { readNoteCorpus, readNoteCorpusSources } from './note-corpus-reader.js'
import type { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { resolve as resolvePath } from 'node:path'

const physicalScopeKey = (resource: { hostId: string; workspacePath: string }) => JSON.stringify([resource.hostId, resource.workspacePath])
const physicalFileKey = (resource: NotebookPage['resource']) => JSON.stringify([resource.hostId, resolvePath(resource.workspacePath, resource.path)])

/** Exact durable resources, including closed pages, through the original Files owner. */
export class NotebookObservationOwner implements NotebookObservationPort {
  /** Hints from the latest in-call file graph, revalidated by Files on every content read. */
  private sharedResources = new Map<string, NoteContentMetadata[]>()
  private incompleteSharedScopes = new Set<string>()
  private cachedDocuments = new Map<string, NoteFileDocument>()
  constructor(private readonly ports: { workspace(id: string): WorkspaceRecord | undefined; files: Pick<WorkspaceFiles, 'read'> & Partial<Pick<WorkspaceFiles, 'readDirectory'>>; metadata?: Pick<AgentMuxNotebookStore, 'readProvenance'> }) {}
  /** Explicit projection of original files; never a catalog recovery or registration. */
  scan(params: NoteCorpusParams, options?: { signal?: AbortSignal }): Promise<NoteCorpusResult> {
    return readNoteCorpus(this.ports, params, options)
  }
  private canonicalDocument(resource: NotebookPage['resource'], document: NoteFileDocument): NoteFileDocument {
    if (document.noteProvenance) return document
    const key = physicalFileKey(resource), cached = this.cachedDocuments.get(key)
    if (cached && cached.path === document.path && cached.revision === document.revision && cached.content === document.content) return cached
    this.cachedDocuments.set(key, document)
    return document
  }
  private async read(page: Pick<NotebookPage, 'noteId' | 'resource'>, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<{ observation: NoteContentObservation; document?: NoteFileDocument }> {
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
      const document = this.canonicalDocument(original, result.document), parsed = parseNoteFile(document)
      if (parsed.status === 'invalid') return { observation: { ...base, status: 'invalid', revision: document.revision, message: parsed.message } }
      if (parsed.note.noteId !== page.noteId) return { observation: { ...base, status: 'identity-mismatch', revision: document.revision, actualNoteId: parsed.note.noteId, message: 'The original file contains another Note identity. Both identities and bytes are retained; inspect its source before editing.' } }
      const knowledge = noteKnowledge([{ location: { workspaceId: original.workspaceId, path: original.path }, document }])
      return { document, observation: { ...base, ...(parsed.note.kind ? { kind: parsed.note.kind } : {}), status: 'read', revision: document.revision, content: document.content, actualNoteId: parsed.note.noteId, unanchoredBlockCount: parsed.unanchoredBlockCount, blockIds: [...knowledge.sources[0]!.blocks.keys()], ...(knowledge.sources[0]!.blockForwardings.length ? { blockForwardings: [...knowledge.sources[0]!.blockForwardings] } : {}) } }
    } catch (error) { options?.signal?.throwIfAborted(); return unknown(error instanceof Error ? error.message : String(error)) }
  }
  async content(state: NotebookState, noteId: string, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<NoteContentObservation> {
    let page: Pick<NotebookPage, 'noteId' | 'resource'> | undefined = state.pages[noteId]
    if (!page) {
      if (!this.sharedResources.has(noteId)) await this.graph(state, {}, options?.signal ? { signal: options.signal } : undefined)
      const originals = this.sharedResources.get(noteId)
      if (!originals?.length) throw new AgentMuxError('The original shared Markdown file is not confirmed in this scope. Scan its original Workspace; no alternative file was selected.', 'NOTEBOOK_INPUT_INVALID')
      if (originals.length !== 1) return { noteId, resource: originals[0]!.resource, status: 'unknown', message: 'This shared identity exists in multiple original files. Resolve that ambiguity before reading one as the shared original.' }
      if (this.incompleteSharedScopes.size > 0 || originals[0]!.fileIdentity !== 'confirmed') return { noteId, resource: originals[0]!.resource, status: 'unknown', message: 'The original file scan was incomplete. Refresh that scope to confirm this shared identity; ordinary Files reads remain available.' }
      page = { noteId, resource: originals[0]!.resource }
    }
    const observation = (await this.read(page, options)).observation
    if (observation.status !== 'read') return observation
    if (!state.pages[noteId] && observation.kind !== 'shared-block') return { noteId, resource: observation.resource, status: 'unknown', revision: observation.revision, message: 'This original file no longer declares shared content. Its bytes are retained; inspect the header before using this include.' }
    const query = { noteId, resource: observation.resource, revision: observation.revision, blockIds: observation.blockIds }
    try {
      if (!this.ports.metadata) throw new Error('The original Note metadata owner is unavailable.')
      const noteProvenance = await this.ports.metadata.readProvenance(query)
      options?.signal?.throwIfAborted()
      return { ...observation, noteProvenance }
    } catch (error) {
      options?.signal?.throwIfAborted()
      return { ...observation, noteProvenance: { noteId, resource: query.resource, revision: query.revision, blocks: Object.fromEntries(query.blockIds.map(id => [id, { created: null, lastEdited: null }])), status: 'unconfirmed', reason: error instanceof Error ? error.message : String(error) } }
    }
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
          promise = parsed.status === 'valid' && parsed.note.noteId === page.noteId ? Promise.resolve({ document: source.document, observation: { status: 'read' as const, noteId: page.noteId, resource: page.resource, revision: source.document.revision, content: source.document.content, actualNoteId: page.noteId, unanchoredBlockCount: parsed.unanchoredBlockCount, blockIds: [...knowledge.sources[0]!.blocks.keys()], ...(knowledge.sources[0]!.blockForwardings.length ? { blockForwardings: [...knowledge.sources[0]!.blockForwardings] } : {}) } }) : this.read(page)
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
    if (!params.select?.blockId && parsed.query.fragment.kind !== 'block' && (observation.unanchoredBlockCount ?? 0) > 0) return { ...resultBase, result: { status: 'unknown', stage: 'fragment', message: 'Some original blocks have no persisted identity. Save the original Markdown to assign their IDs before confirming a unique heading.' } }
    const matches = params.select?.blockId ? blocks.filter(block => block.blockId === params.select!.blockId) : matchingNoteLinkBlocks(blocks, parsed.query.fragment)
    if (matches.length !== 1) return { ...resultBase, result: { status: matches.length ? 'ambiguous' : 'missing', stage: 'fragment', message: matches.length ? 'Several original blocks match. Choose their exact Block ID; no first match was selected.' : 'This heading or block is absent from the confirmed original. The query is retained.' } }
    return { ...resultBase, result: { status: 'resolved', target: { noteId: selected.noteId, blockId: matches[0]!.blockId } } }
  }
  async graph(state: NotebookState, params: NotebookGraphParams, options?: { signal?: AbortSignal }): Promise<NotebookGraph> {
    if (params.notebookId && !state.notebooks[params.notebookId]) throw new AgentMuxError('The requested original Note or Notebook is absent from this durable catalog. Refresh its directory.', 'NOTEBOOK_INPUT_INVALID')
    const selected = new Set(Object.values(state.pages).filter(p => params.noteId ? p.noteId === params.noteId : params.notebookId ? p.notebookId === params.notebookId : true).map(p => p.noteId))
    const observations: NotebookGraph['observations'] = [], documents: { location: { workspaceId: string; path: string }; document: NoteFileDocument }[] = []
    const observedReads = new Map<string, Awaited<ReturnType<NotebookObservationOwner['read']>>>()
    const resources = new Map<string, NotebookPage['resource']>()
    // Per-file reads/revisions are not a cross-file atomic content snapshot.
    for (const page of Object.values(state.pages)) {
      options?.signal?.throwIfAborted()
      const read = await this.read(page, { ...options, ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }) })
      observedReads.set(page.noteId, read)
      const { observation, document } = read
      const { content: _body, ...metadata } = observation as NoteContentObservation & { content?: string }
      observations.push(metadata)
      if (document) { const location = { workspaceId: page.resource.workspaceId, path: page.resource.path }; documents.push({ location, document }); resources.set(JSON.stringify([location.workspaceId, location.path]), page.resource) }
    }
    // A graph request discovers shared files only in Workspaces whose observed originals
    // actually include a file. The same bounded scan supplies bytes and duplicate evidence.
    const includeWorkspaces = new Set<string>()
    const includeScopes = (content: import('@agentmux/client-ui/note/note-document').NoteDocument['content'], workspaceId: string) => {
      const visit = (node: import('@agentmux/client-ui/note/note-document').NoteDocument['content']) => { if (node.type === 'noteInclude') { includeWorkspaces.add(workspaceId); if (typeof node.attrs?.workspaceId === 'string') includeWorkspaces.add(node.attrs.workspaceId) }; node.content?.forEach(visit) }
      visit(content)
    }
    for (const original of documents) {
      const parsed = parseNoteFile(original.document)
      if (parsed.status === 'valid') includeScopes(parsed.note.content, original.location.workspaceId)
    }
    const scannedScopes = new Set<string>(), incompleteSharedScopes = new Set<string>()
    const observedFiles = new Set(observations.map(item => physicalFileKey(item.resource)))
    // Set iteration includes Workspaces discovered from newly read shared originals.
    // Each original physical scope is scanned once, including aliases and cycles.
    for (const workspaceId of includeWorkspaces) {
      options?.signal?.throwIfAborted()
      const workspace = this.ports.workspace(workspaceId)
      // A stale App-specific hint does not invalidate a file found by ID in the original physical scope.
      if (!workspace) continue
      const scopeKey = physicalScopeKey({ hostId: workspace.hostId, workspacePath: workspace.path })
      if (scannedScopes.has(scopeKey)) continue
      scannedScopes.add(scopeKey)
      const known = new Map(documents.filter(item => {
        const resource = resources.get(JSON.stringify([item.location.workspaceId, item.location.path]))
        return resource?.hostId === workspace.hostId && resource.workspacePath === workspace.path
      }).map(item => [item.location.path, item.document]))
      const scanned = await readNoteCorpusSources({ ...this.ports, files: { ...this.ports.files,
        ...(this.ports.files.readDirectory ? { readDirectory: this.ports.files.readDirectory.bind(this.ports.files) } : {}),
        read: async (owner, path, budget) => {
          const maxFileBytes = Math.min(budget?.maxFileBytes ?? WORKSPACE_FILE_MAX_BYTES, params.maxBytes ?? WORKSPACE_FILE_MAX_BYTES)
          const original = known.get(path)
          if (original && new TextEncoder().encode(original.content).byteLength <= maxFileBytes) return { status: 'read' as const, document: original }
          return this.ports.files.read(owner, path, { ...budget, maxFileBytes })
        }
      } }, { workspaceId, path: '.', maxFiles: 20000, maxDirectories: 20000, maxBytes: 64 * 1024 * 1024 }, options)
      // Missing paragraph anchors/titles do not invalidate a whole file's stable identity.
      if (scanned.result.coverage.limited || scanned.result.coverage.issues.length) incompleteSharedScopes.add(scopeKey)
      const sharedIds = new Set(scanned.result.pages.filter(page => page.kind === 'shared-block').map(page => page.noteId))
      for (const original of scanned.documents) {
        const parsed = parseNoteFile(original.document)
        if (parsed.status !== 'valid' || parsed.note.kind !== 'shared-block' && !sharedIds.has(parsed.note.noteId)) continue
        const resourceKey = physicalFileKey(original.resource)
        if (observedFiles.has(resourceKey)) continue
        observedFiles.add(resourceKey)
        const indexed = noteKnowledge([{ location: { workspaceId, path: original.resource.path }, document: original.document }])
        observations.push({ status: 'read', noteId: parsed.note.noteId, actualNoteId: parsed.note.noteId, resource: original.resource,
          ...(parsed.note.kind ? { kind: parsed.note.kind } : {}), revision: original.document.revision, blockIds: [...indexed.sources[0]!.blocks.keys()], ...(indexed.sources[0]!.blockForwardings.length ? { blockForwardings: [...indexed.sources[0]!.blockForwardings] } : {}), unanchoredBlockCount: parsed.unanchoredBlockCount })
        const location = { workspaceId, path: original.resource.path }
        documents.push({ location, document: original.document }); resources.set(JSON.stringify([location.workspaceId, location.path]), original.resource)
        includeScopes(parsed.note.content, workspaceId)
      }
    }
    if (params.noteId && !observations.some(item => item.noteId === params.noteId)) throw new AgentMuxError('The requested original Note or shared file is not confirmed in this scope. Its files are retained; scan the original Workspace to inspect it.', 'NOTEBOOK_INPUT_INVALID')
    if (!params.noteId && !params.notebookId) observations.forEach(item => selected.add(item.noteId))
    else if (params.noteId) selected.add(params.noteId)
    else {
      // Included shared files belong to the visible neighborhood, without a catalog registration.
      const sourceKnowledge = noteKnowledge(documents)
      let changed = true
      while (changed) {
        changed = false
        for (const ref of sourceKnowledge.references) if (selected.has(ref.source.note.noteId) && ref.mode === 'embed' && ref.target.kind === 'page' && !selected.has(ref.target.noteId)) { selected.add(ref.target.noteId); changed = true }
      }
    }
    const readable = observations.filter(o => o.status === 'read').length
    const knowledge = noteKnowledge(documents, readable === observations.length ? 'complete' : readable === 0 ? 'unknown' : 'partial')
    const identities = new Map<string, Set<string>>()
    for (const observed of observations) if ('actualNoteId' in observed && observed.actualNoteId) {
      const locations = identities.get(observed.actualNoteId) ?? new Set<string>()
      locations.add(JSON.stringify(observed.resource)); identities.set(observed.actualNoteId, locations)
    }
    const duplicateNoteIds = [...identities].filter(([, locations]) => locations.size > 1).map(([id]) => id)
    for (const observed of observations) if (observed.status === 'read' && observed.kind === 'shared-block') observed.fileIdentity = duplicateNoteIds.includes(observed.noteId) ? 'ambiguous' : scannedScopes.has(physicalScopeKey(observed.resource)) && incompleteSharedScopes.size === 0 ? 'confirmed' : 'unknown'
    const observedIds = new Set(observations.map(item => item.noteId))
    const hasExternalTargets = knowledge.references.some(r => r.target.kind !== 'unbound' && !observedIds.has(r.target.noteId))
    const graphKnowledge = { ...knowledge, ...(hasExternalTargets ? { scope: 'partial' as const } : {}), ...(incompleteSharedScopes.size ? { fileScope: 'partial' as const } : {}), confirmedIncludes: observations.flatMap(item => item.status === 'read' && item.kind === 'shared-block' && item.fileIdentity === 'confirmed' ? [{ noteId: item.noteId, workspaceId: item.resource.workspaceId, path: item.resource.path, revision: item.revision }] : []) }
    const observedByNoteId = new Map(observations.filter(o => !duplicateNoteIds.includes(o.noteId)).map(o => [o.noteId, o]))
    // Query targets are an observation of these exact saved revisions, never a file binding.
    // Reuse the same resolver and already-read originals; no second scan, write or minted ID.
    const queryResults = new Map<string, NotebookResolveResult>()
    const references: NotebookGraph['references'] = []
    for (const reference of knowledge.references) {
      options?.signal?.throwIfAborted()
      let target = reference.target, resolution: NotebookGraph['references'][number]['resolution']
      const query = target.kind === 'unbound' ? target.text : undefined
      if (query !== undefined) {
        let result = queryResults.get(query)
        if (!result) {
          result = await this.resolveUsing(state, { mode: 'resolve', text: query }, async page => observedReads.get(page.noteId)!)
          queryResults.set(query, result)
        }
        if (result.mode === 'resolve' && result.result.status === 'resolved') {
          if (duplicateNoteIds.includes(result.result.target.noteId)) resolution = 'ambiguous'
          else { const confirmed = result.result.target; target = confirmed.blockId ? { kind: 'block', noteId: confirmed.noteId, blockId: confirmed.blockId } : { kind: 'page', noteId: confirmed.noteId }; resolution = 'resolved' }
        } else resolution = result.mode === 'resolve' ? result.result.status : 'unknown'
      } else resolution = target.kind === 'unbound' ? 'unbound' : duplicateNoteIds.includes(target.noteId) ? 'ambiguous' : observedByNoteId.get(target.noteId)?.status === 'missing' ? 'missing' : target.kind === 'block' ? resolveNoteBlock(graphKnowledge, target).status : observedByNoteId.get(target.noteId)?.status === 'read' ? 'resolved' : 'unknown'
      if (reference.mode === 'embed' && target.kind === 'page' && !duplicateNoteIds.includes(target.noteId) && (incompleteSharedScopes.size > 0 || observedByNoteId.get(target.noteId)?.kind !== 'shared-block')) resolution = 'unknown'
      references.push({ source: { noteId: reference.source.note.noteId, blockId: reference.blockId }, sourceResource: resources.get(JSON.stringify([reference.source.location.workspaceId, reference.source.location.path]))!, target, occurrence: reference.occurrence, mode: reference.mode, resolution, ...(query === undefined ? {} : { query }) })
    }
    const hasUnbound = references.some(reference => reference.target.kind === 'unbound')
    const completeness = observations.every(o => o.status === 'read' && (o.unanchoredBlockCount ?? 0) === 0) && duplicateNoteIds.length === 0 && !hasExternalTargets && !hasUnbound && !references.some(item => item.resolution === 'ambiguous' || item.resolution === 'unknown') && incompleteSharedScopes.size === 0 ? 'complete' : knowledge.sources.length === 0 && observations.length > 0 ? 'unknown' : 'partial'
    const sharedResources = new Map<string, NoteContentMetadata[]>(), sharedIds = new Set(observations.filter(item => item.kind === 'shared-block').map(item => item.noteId))
    for (const item of observations) if (sharedIds.has(item.noteId)) { const list = sharedResources.get(item.noteId) ?? []; list.push(item); sharedResources.set(item.noteId, list) }
    this.sharedResources = sharedResources
    this.incompleteSharedScopes = incompleteSharedScopes
    return {
      catalogRevision: state.revision, scope: params.noteId ? { kind: 'note', noteId: params.noteId } : params.notebookId ? { kind: 'notebook', notebookId: params.notebookId } : { kind: 'catalog' }, scannedScope: 'catalog', completeness, observations, duplicateNoteIds,
      hierarchy: Object.values(state.pages).filter(p => p.parentNoteId && (selected.has(p.noteId) || selected.has(p.parentNoteId))).map(p => ({ parentNoteId: p.parentNoteId!, noteId: p.noteId })),
      references: references.filter(reference => reference.target.kind === 'unbound' || selected.has(reference.source.noteId) || selected.has(reference.target.noteId))
    }
  }
}
