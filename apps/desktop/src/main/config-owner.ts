import type { AppConfig } from '../shared/contracts.js'
import { applyConfigEdit } from '../shared/config-edit.js'

/** One commit queue around the existing Main fact; long host/Git/dialog work is never an updater. */
export class ConfigOwner {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly ports: {
    read(): AppConfig
    prepare?(current: AppConfig, next: AppConfig): AppConfig | Promise<AppConfig>
    save(next: AppConfig): Promise<AppConfig>
    publish(saved: AppConfig): void
  }) {}

  get current(): AppConfig { return this.ports.read() }

  /** Capture current configuration and reserve admission after all prior saves, without holding the queue during execution. */
  inspect<T>(capture: (current: AppConfig) => T): Promise<T> {
    return this.enqueue(() => capture(this.ports.read()))
  }

  private enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const operation = this.tail.then(work)
    this.tail = operation.then(() => {}, () => {})
    return operation
  }

  edit(before: AppConfig, after: AppConfig): Promise<AppConfig> {
    return this.update((current) => applyConfigEdit(current, before, after))
  }

  update(apply: (current: AppConfig) => AppConfig): Promise<AppConfig> {
    return this.enqueue(async () => {
      const current = this.ports.read()
      const requested = apply(current)
      const next = this.ports.prepare ? await this.ports.prepare(current, requested) : requested
      if (JSON.stringify(next) === JSON.stringify(current)) return current
      const saved = await this.ports.save(next)
      this.ports.publish(saved)
      return saved
    })
  }
}
