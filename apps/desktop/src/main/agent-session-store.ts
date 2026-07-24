import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentMuxAgentSessionStore, AgentMuxStoredAgentSession } from '@agentmux/core'

const MAX_STORE_BYTES = 1024 * 1024

type StoreDocument = {
  version: 1
  sessions: AgentMuxStoredAgentSession[]
}

export class DesktopAgentSessionStore implements AgentMuxAgentSessionStore {
  private sessions: Map<string, AgentMuxStoredAgentSession> | null = null
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async load(): Promise<readonly unknown[]> {
    await this.tail
    await this.ensureLoaded()
    return [...this.sessions!.values()].map((session) => structuredClone(session))
  }

  async put(session: AgentMuxStoredAgentSession): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded()
      const next = new Map(this.sessions)
      next.set(session.agentSessionId, structuredClone(session))
      await this.persist(next)
      this.sessions = next
    })
  }

  async delete(agentSessionId: string): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded()
      const next = new Map(this.sessions)
      next.delete(agentSessionId)
      await this.persist(next)
      this.sessions = next
    })
  }

  private async ensureLoaded(): Promise<void> {
    if (this.sessions) return
    let document: StoreDocument
    try {
      const info = await stat(this.path)
      if (info.size > MAX_STORE_BYTES) throw new Error('Agent Session store exceeds its size limit')
      document = JSON.parse(await readFile(this.path, 'utf8')) as StoreDocument
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      document = { version: 1, sessions: [] }
    }
    if (document.version !== 1 || !Array.isArray(document.sessions)) {
      throw new Error('Agent Session store has an unsupported format')
    }
    this.sessions = new Map(document.sessions.map((session) => [session.agentSessionId, session]))
  }

  private async persist(sessions: ReadonlyMap<string, AgentMuxStoredAgentSession>): Promise<void> {
    const document: StoreDocument = {
      version: 1,
      sessions: [...sessions.values()]
    }
    const content = `${JSON.stringify(document, null, 2)}\n`
    if (Buffer.byteLength(content) > MAX_STORE_BYTES) {
      throw new Error('Agent Session store exceeds its size limit')
    }
    await mkdir(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.${process.pid}.tmp`
    await writeFile(temporaryPath, content, { mode: 0o600 })
    await rename(temporaryPath, this.path)
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const current = this.tail.catch(() => {}).then(operation)
    this.tail = current.then(() => {}, () => {})
    await current
  }
}
