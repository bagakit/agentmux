import { posix } from 'node:path'
import type { CreateWorkspacePathInput, MoveWorkspacePathInput, WorkspaceRecord } from '../shared/contracts.js'
import type { WorkspaceFiles } from './workspace-files.js'

/** File-manager mutations that can change the Note corpus borrow its original lease. */
export class NoteFileMutations {
  constructor(private readonly files: Pick<WorkspaceFiles, 'readDirectory' | 'create' | 'move' | 'delete'>,
    private readonly lease: <T>(work: () => Promise<T>) => Promise<T>) {}
  private async affectsNotes(owner: WorkspaceRecord, path: string): Promise<boolean> {
    if (path.endsWith('.note.md')) return true
    try {
      const entry = (await this.files.readDirectory(owner, posix.dirname(path))).find(item => item.name === posix.basename(path))
      return entry?.isDirectory === true || entry?.isSymlink === true
    } catch { return true } // The original operation remains available; uncertainty only selects its owning lease.
  }
  create(owner: WorkspaceRecord, input: CreateWorkspacePathInput): Promise<void> {
    const run = () => this.files.create(owner, input)
    return input.kind === 'directory' || input.path.endsWith('.note.md') ? this.lease(run) : run()
  }
  async move(source: WorkspaceRecord, destination: WorkspaceRecord, input: MoveWorkspacePathInput) {
    const run = () => this.files.move(source, destination, input)
    return input.destination.path.endsWith('.note.md') || await this.affectsNotes(source, input.source.path) ? this.lease(run) : run()
  }
  async delete(owner: WorkspaceRecord, path: string): Promise<void> {
    const run = () => this.files.delete(owner, path)
    return await this.affectsNotes(owner, path) ? this.lease(run) : run()
  }
}
