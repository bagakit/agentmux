import { createHash } from 'node:crypto'
import { mkdir, open, access } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { AgentMuxError } from './errors.js'
const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
/** Empty stable per-key coordination only. Roles remain in the original Agent Store. */
export class NativeCreationAdmission {
  private readonly observedRetirements = new Set<string>()
  constructor(readonly directory: string, private readonly memberDirectory = join(directory, 'terminal-recoveries')) {}
  noteRetirement(key: string): void { this.observedRetirements.add(key) }
  retirementMemberPath(key: string): string { return join(this.memberDirectory, createHash('sha256').update(key).digest('hex') + '.retirement.json') }
  retirementPath(key: string): string { return join(this.directory, `terminal-retirement-admission-${createHash('sha256').update(key).digest('hex')}.claim`) }
  async hasRetirement(key: string): Promise<boolean> {
    if (this.observedRetirements.has(key)) return true
    for (const path of [this.retirementPath(key), this.retirementMemberPath(key)]) {
      try { await access(path); this.noteRetirement(key); return true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return false
  }
  async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    await mkdir(this.directory,{recursive:true,mode:0o700})
    const handle=await open(join(this.directory,`native-creation-admission-${createHash('sha256').update(key).digest('hex')}.lock`),'a+',0o600)
    try {
      const deadline=Date.now()+5000
      while(!native.tryLock(handle.fd)) {
        if(Date.now()>deadline) throw new AgentMuxError('This original creation key is completing admission. Its existing Runs and input remain available.','NATIVE_CREATION_ADMISSION_UNCONFIRMED')
        await delay(10)
      }
      return await work()
    } finally {await handle.close()}
  }
}
