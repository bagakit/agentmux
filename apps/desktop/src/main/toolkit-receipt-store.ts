import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AgentMuxError, durableWriteFile } from '@agentmux/core'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, TOOLKIT_MAX_USER_TOOLS } from '@agentmux/core/control'

/** Latest facts only, in the existing durable writer; never an output log or Run registry. */
export class ToolkitReceiptStore {
  private tail: Promise<void> = Promise.resolve()
  private loaded: Promise<void> | null = null
  private values: Record<string, unknown> = {}
  constructor(private readonly path: string, private readonly configuredIds: () => string[]) {}

  private async load(): Promise<void> {
    if (!this.loaded) this.loaded = (async () => {
      let text: string
      try {
        if ((await stat(this.path)).size > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES * TOOLKIT_MAX_USER_TOOLS) {
          throw new AgentMuxError('Toolkit receipt storage exceeds its budget.', 'CONTROL_PROTOCOL_ERROR')
        }
        text = await readFile(this.path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      const value = JSON.parse(text)
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 'agentmux.toolkit.receipts.v1' ||
        Object.keys(value).length !== 2 || !value.tools || typeof value.tools !== 'object' || Array.isArray(value.tools) ||
        Object.keys(value.tools).length > TOOLKIT_MAX_USER_TOOLS) throw new AgentMuxError('Toolkit receipt storage is invalid.', 'CONTROL_PROTOCOL_ERROR')
      this.values = value.tools
    })()
    return await this.loaded
  }

  async read(toolId: string): Promise<unknown | null> {
    await this.load()
    return Object.hasOwn(this.values, toolId) ? structuredClone(this.values[toolId]) : null
  }

  async save(toolId: string, receipt: unknown): Promise<void> {
    const captured = structuredClone(receipt)
    const work = this.tail.then(async () => {
      await this.load()
      const next: Record<string, unknown> = {}
      for (const id of this.configuredIds()) {
        if (Object.hasOwn(this.values, id)) Object.defineProperty(next, id, { value: this.values[id], enumerable: true, writable: true, configurable: true })
      }
      Object.defineProperty(next, toolId, { value: captured, enumerable: true, writable: true, configurable: true })
      if (Object.keys(next).length > TOOLKIT_MAX_USER_TOOLS) throw new AgentMuxError('Toolkit receipt count exceeds its budget.', 'CONTROL_PROTOCOL_ERROR')
      await mkdir(dirname(this.path), { recursive: true })
      await durableWriteFile(this.path, JSON.stringify({ schema: 'agentmux.toolkit.receipts.v1', tools: next }) + '\n')
      this.values = next
    })
    this.tail = work.then(() => {}, () => {})
    return await work
  }
}
