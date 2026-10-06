import { AgentMuxError, parseNoteContentObservation, parseNotebookObservationParams, type NotebookObservationPort } from '@agentmux/core'
import { notebookFingerprint } from '@agentmux/core/notebook-catalog'
import type { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import type { WebContentsDidStartNavigationEventParams } from 'electron'
import { parseNotebookGraphSnapshot, type NotebookGraphSnapshot } from '../shared/notebook-observation.js'
import { NotebookObservationOwner } from './notebook-observation-owner.js'
import { parseNotebookResolveParams, parseNotebookResolveResult, type NotebookResolveResult } from '@agentmux/core/note-links'

export type NotebookObservationSender = {
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  on(event: 'did-start-navigation', listener: (details: WebContentsDidStartNavigationEventParams) => void): unknown
  removeListener(event: 'destroyed' | 'did-start-navigation', listener: (...args: any[]) => void): unknown
}
type Job = { controller: AbortController }
type SenderJobs = { jobs: Map<string, Job>; destroyed(): void; navigation(details: WebContentsDidStartNavigationEventParams): void }
const invalid = (message: string): never => { throw new AgentMuxError(message, 'INVALID_CONTROL_REQUEST') }
function request(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) invalid('Unexpected Note observation request fields.')
  return value as Record<string, unknown>
}
function requestId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) invalid('An exact Note observation request ID is required.')
  return value as string
}

/** Only pending read resources live here. Cancel never writes Note, catalog, layout or Agent state. */
export class NotebookObservationRequests {
  private readonly senders = new Map<NotebookObservationSender, SenderJobs>()
  constructor(private readonly store: Pick<AgentMuxNotebookStore, 'read'>, private readonly owner: NotebookObservationPort,
    private readonly ready: () => Promise<unknown> = async () => {}) {}
  resolve(sender: NotebookObservationSender, input: unknown): Promise<NotebookResolveResult> {
    const original = request(input, ['requestId', 'params']), params = parseNotebookResolveParams(original.params)
    return this.read(sender, requestId(original.requestId), async signal => {
      const catalog = await this.store.read(); signal.throwIfAborted()
      const result = parseNotebookResolveResult(await this.owner.resolve(catalog, params, { signal }), params)
      if (result.catalogRevision !== catalog.revision || result.candidates.some(candidate => {
        const page = catalog.pages[candidate.noteId]
        return !page || candidate.title !== page.title || candidate.notebookId !== page.notebookId || notebookFingerprint(candidate.resource) !== notebookFingerprint(page.resource)
      })) throw new AgentMuxError('The original resolver returned another directory snapshot.', 'CONTROL_PROTOCOL_ERROR')
      return result
    })
  }

  graph(sender: NotebookObservationSender, input: unknown): Promise<NotebookGraphSnapshot> {
    const original = request(input, ['requestId', 'params']), params = parseNotebookObservationParams(original.params)
    return this.read(sender, requestId(original.requestId), async signal => {
      const catalog = await this.store.read()
      signal.throwIfAborted()
      const graph = await this.owner.graph(catalog, params, { signal })
      return parseNotebookGraphSnapshot({ catalog, graph }, params)
    })
  }
  content(sender: NotebookObservationSender, input: unknown): Promise<import('@agentmux/core').NoteContentObservation> {
    const original = request(input, ['requestId', 'noteId', 'maxBytes'])
    const params = parseNotebookObservationParams({ noteId: original.noteId, content: true, ...(original.maxBytes === undefined ? {} : { maxBytes: original.maxBytes }) }, true)
    if (!params.noteId) invalid('An exact Note ID is required for content observation.')
    return this.read(sender, requestId(original.requestId), async signal => {
      const catalog = await this.store.read()
      signal.throwIfAborted()
      const result = parseNoteContentObservation(await this.owner.content(catalog, params.noteId!, { signal, ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }) }))
      if (result.noteId !== params.noteId || !catalog.pages[params.noteId!] || notebookFingerprint(result.resource) !== notebookFingerprint(catalog.pages[params.noteId!]!.resource)) throw new AgentMuxError('The original reader returned another Note or resource.', 'CONTROL_PROTOCOL_ERROR')
      return result
    })
  }
  cancel(sender: NotebookObservationSender, id: unknown): void {
    this.senders.get(sender)?.jobs.get(requestId(id))?.controller.abort(new DOMException('The Note observation was cancelled. Original files and Agents are unchanged.', 'AbortError'))
  }
  private async read<T>(sender: NotebookObservationSender, id: string, observe: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let group = this.senders.get(sender)
    if (!group) {
      group = { jobs: new Map(), destroyed: () => this.cancelSender(sender), navigation: details => {
        if (details.isMainFrame && !details.isSameDocument) this.cancelSender(sender)
      } }
      this.senders.set(sender, group)
      sender.once('destroyed', group.destroyed)
      sender.on('did-start-navigation', group.navigation)
    }
    if (group.jobs.has(id)) invalid('This Note observation request is already active. Keep its original reader or cancel that exact request.')
    const job: Job = { controller: new AbortController() }
    group.jobs.set(id, job)
    if (sender.isDestroyed()) this.cancel(sender, id)
    try {
      job.controller.signal.throwIfAborted()
      await this.ready()
      job.controller.signal.throwIfAborted()
      const result = await observe(job.controller.signal)
      job.controller.signal.throwIfAborted()
      return result
    } finally {
      if (group.jobs.get(id) === job) group.jobs.delete(id)
      if (group.jobs.size === 0 && this.senders.get(sender) === group) {
        sender.removeListener('destroyed', group.destroyed)
        sender.removeListener('did-start-navigation', group.navigation)
        this.senders.delete(sender)
      }
    }
  }
  private cancelSender(sender: NotebookObservationSender): void {
    for (const job of this.senders.get(sender)?.jobs.values() ?? []) job.controller.abort(new DOMException('The Note observation presentation left. Original content is retained.', 'AbortError'))
  }
  dispose(): void { for (const sender of this.senders.keys()) this.cancelSender(sender) }
}

/** Production creates exactly one semantic file reader for public RPC and GUI readers. */
export function createNotebookObservationServices(store: Pick<AgentMuxNotebookStore, 'read'> & Partial<Pick<AgentMuxNotebookStore, 'readProvenance'>>,
  ports: ConstructorParameters<typeof NotebookObservationOwner>[0], ready?: () => Promise<unknown>) {
  const owner = new NotebookObservationOwner({ ...ports, ...(store.readProvenance ? { metadata: { readProvenance: store.readProvenance.bind(store) } } : {}) })
  return { owner, requests: new NotebookObservationRequests(store, owner, ready) }
}
