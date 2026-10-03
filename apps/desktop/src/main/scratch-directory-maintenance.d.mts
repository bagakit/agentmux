import type { ChildProcess } from 'node:child_process'
export type DirectoryMaintenanceOptions = {
  home?: string; scratchRoot?: string; execute?: boolean; motesOnly?: boolean; helperPath?: string
  nativeOptions?: { beforeSwap?: (child: ChildProcess) => void | Promise<void>; afterSwap?: (child: ChildProcess) => void | Promise<void>
    afterStageCreate?: (child: ChildProcess) => void | Promise<void>; afterWitness?: (child: ChildProcess) => void | Promise<void>
    beforeFinalize?: (child: ChildProcess) => void | Promise<void>; lastSwap?: (child: ChildProcess) => void | Promise<void>
    syncFault?: 'source' | 'destination' }
}
export type DirectoryMaintenanceReport = { version: number; mode: string; legacyRoot: string; success: boolean;
  objects: { id: string; sourcePath: string; identityDirectoryPath: string; destinationPath?: string; kind?: 'mote' | 'topic'; state: string;
    issue?: { code: string; message: string } }[]; looseEntries: string[]; issues: { code: string; message: string }[] }
export function migrateTopicDirectories(options?: DirectoryMaintenanceOptions): Promise<DirectoryMaintenanceReport>
