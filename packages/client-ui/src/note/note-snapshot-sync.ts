import type { Editor, JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode, Schema, SchemaSpec, NodeSpec, MarkSpec } from '@tiptap/pm/model'
import { noteSnapshotSteps } from './note-snapshot-transaction.js'

/** Only PM's pure model fields cross the worker boundary; DOM/render/plugin code stays in its owner. */
export function noteSnapshotSchema(schema: Schema): SchemaSpec {
  const nodes: Record<string, NodeSpec> = {}, marks: Record<string, MarkSpec> = {}
  const nodeFields = ['content', 'marks', 'group', 'inline', 'atom', 'selectable', 'draggable', 'code', 'whitespace', 'definingAsContext', 'definingForContent', 'defining', 'isolating', 'linebreakReplacement'] as const
  const markFields = ['inclusive', 'excludes', 'group', 'spanning', 'code'] as const
  for (const [name, type] of Object.entries(schema.nodes)) {
    const spec: Record<string, unknown> = {}
    for (const key of nodeFields) if (type.spec[key] !== undefined) spec[key] = type.spec[key]
    if (type.spec.attrs) spec.attrs = Object.fromEntries(Object.entries(type.spec.attrs).map(([key, attr]) => [key, Object.hasOwn(attr, 'default') ? { default: attr.default } : {}]))
    nodes[name] = spec
  }
  for (const [name, type] of Object.entries(schema.marks)) {
    const spec: Record<string, unknown> = {}
    for (const key of markFields) if (type.spec[key] !== undefined) spec[key] = type.spec[key]
    if (type.spec.attrs) spec.attrs = Object.fromEntries(Object.entries(type.spec.attrs).map(([key, attr]) => [key, Object.hasOwn(attr, 'default') ? { default: attr.default } : {}]))
    marks[name] = spec
  }
  return { nodes, marks, topNode: schema.topNodeType.name }
}
export type NoteSnapshotRequest = { generation: number; schema: SchemaSpec; before: JSONContent; target: JSONContent }
export type NoteSnapshotReply = { generation: number; status: 'ready'; steps: unknown[] } | { generation: number; status: 'failed'; message: string }
export type NoteSnapshotPair = { displayed: JSONContent; incoming: JSONContent }
export interface NoteSnapshotWorker {
  postMessage(request: NoteSnapshotRequest): void
  terminate(): void
  onmessage: ((event: MessageEvent<NoteSnapshotReply>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}
const pendingMessage = (message: string) => 'The incoming update is waiting; your current input is kept. ' + message

/** One view's transient computation, not another document or save owner. */
export class NoteSnapshotSync {
  private worker: NoteSnapshotWorker | null = null
  private generation = 0
  private failed = false
  private pending: { generation: number; before: ProseMirrorNode; target: ProseMirrorNode } | null = null
  private desired: JSONContent | null = null
  private schema: { source: Schema; spec: SchemaSpec } | null = null
  constructor(private readonly editor: Editor, private readonly composing: () => boolean, private readonly issue: (message: string | null, pair?: NoteSnapshotPair) => void,
    private readonly createWorker: () => NoteSnapshotWorker = () => new Worker(new URL('./note-snapshot.worker.js', import.meta.url), { type: 'module' })) {
    editor.on('transaction', this.localTransaction)
    editor.on('mount', this.mount).on('unmount', this.unmount)
  }
  // React can reconnect effects with a destroyed old Editor before useEditor's
  // owner publishes its replacement. Only a live PM view supplies the schema.
  private mount = () => { if (this.desired) this.update(this.desired) }
  private unmount = () => { const desired = this.desired; this.pause(); this.desired = desired }
  private localTransaction = ({ transaction }: { transaction: { docChanged: boolean; getMeta(key: string): unknown } }) => {
    if (transaction.docChanged && !transaction.getMeta('noteRemoteSnapshot')) this.pause()
  }
  /** Composition or a newer local draft invalidates old computation, never that local input. */
  private releaseWorker() { this.worker?.terminate(); this.worker = null }
  private fail(message: string) {
    this.releaseWorker(); this.failed = true
    this.issue(message, !this.editor.isDestroyed && this.desired ? { displayed: this.editor.state.doc.toJSON(), incoming: this.desired } : undefined)
  }
  pause() { this.generation++; this.pending = null; this.desired = null; this.releaseWorker(); if (this.failed) { this.failed = false; this.issue(null) } }
  retry() {
    const pending = this.pending, desired = this.desired
    if (!pending || !desired || this.editor.isDestroyed || !this.editor.state.doc.eq(pending.before)) return false
    // Keep the exact observed snapshot. PM fills default attrs in target JSON;
    // those defaults must not turn a retry into a different source observation.
    this.update(desired); return true
  }
  destroy() { this.pause(); this.editor.off('transaction', this.localTransaction).off('mount', this.mount).off('unmount', this.unmount) }
  update(content: JSONContent) {
    this.pause()
    this.desired = content
    if (this.editor.isDestroyed || this.composing() || this.editor.view.composing) return
    try {
      const schema = this.editor.state.schema
      const target = schema.nodeFromJSON(content); target.check()
      if (this.editor.state.doc.eq(target)) return
      if (this.schema?.source !== schema) this.schema = { source: schema, spec: noteSnapshotSchema(schema) }
      const generation = this.generation
      this.pending = { generation, before: this.editor.state.doc, target }
      this.worker = this.createWorker()
      this.worker.onmessage = event => this.receive(event.data)
      this.worker.onerror = event => { if (this.pending?.generation === generation) this.fail(pendingMessage(event.message || 'The update worker is unavailable.')) }
      this.worker.postMessage({ generation, schema: this.schema.spec, before: this.pending.before.toJSON(), target: target.toJSON() })
    } catch (error) { this.fail(pendingMessage(error instanceof Error ? error.message : String(error))) }
  }
  private receive(reply: NoteSnapshotReply) {
    const pending = this.pending
    if (!pending || reply.generation !== pending.generation || this.editor.isDestroyed || this.composing() || this.editor.view.composing) return
    if (!this.editor.state.doc.eq(pending.before)) { this.pause(); return }
    if (reply.status === 'failed') { this.fail(reply.message); return }
    const result = noteSnapshotSteps(this.editor.state, pending.target, reply.steps)
    if (result.status === 'failed') { this.fail(result.message); return }
    if (result.status === 'ready') this.editor.view.dispatch(result.transaction)
    this.pending = null; this.releaseWorker()
    this.issue(null)
  }
}
