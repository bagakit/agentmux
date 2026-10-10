import { computeNoteSnapshot } from '@agentmux/client-ui/note/note-snapshot.worker'
import type { NoteSnapshotRequest, NoteSnapshotReply } from '@agentmux/client-ui/note/note-snapshot-sync'

/** Deterministic browser-worker test double. Actual separate-thread loading is browser-probed. */
export class NoteSnapshotTestWorker {
  onmessage: ((event: MessageEvent<NoteSnapshotReply>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  private terminated = false
  postMessage(request: NoteSnapshotRequest) { queueMicrotask(() => { if (!this.terminated) this.onmessage?.({ data: computeNoteSnapshot(request) } as MessageEvent<NoteSnapshotReply>) }) }
  terminate() { this.terminated = true }
}
