export declare function listProbeProcesses(groupId: number | undefined, temporaryRoot: string): Promise<number[]>
export declare function signalOwnedProbeProcess(pid: number, temporaryRoot: string, name: string, groupId?: number): Promise<boolean>
export declare function stopProbeProcesses(groupId: number | undefined, temporaryRoot: string, graceMs?: number): Promise<void>
export declare function runProbeProcess(executable: string, args: string[], options: Record<string, unknown>): Promise<unknown>
