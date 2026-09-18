import type { AppConfig } from '../shared/contracts.js'
import { applyConfigEdit } from '../shared/config-edit.js'

/** One commit queue around the existing Main fact; long host/Git/dialog work is never an updater. */
export class ConfigOwner {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly ports: {
    read(): AppConfig
    save(next: AppConfig): Promise<AppConfig>
    publish(saved: AppConfig): void
  }) {}

  get current(): AppConfig { return this.ports.read() }

  edit(before: AppConfig, after: AppConfig): Promise<AppConfig> {
    return this.update((current) => applyConfigEdit(current, before, after))
  }

  update(apply: (current: AppConfig) => AppConfig): Promise<AppConfig> {
    const operation = this.tail.then(async () => {
      const current = this.ports.read()
      const next = apply(current)
      if (JSON.stringify(next) === JSON.stringify(current)) return current
      const saved = await this.ports.save(next)
      this.ports.publish(saved)
      return saved
    })
    this.tail = operation.then(() => {}, () => {})
    return operation
  }
}
