import type { AppConfig } from '../shared/contracts.js'
import { validateThemeConfigEdit } from './theme-config.js'
import { applyConfigEdit } from '../shared/config-edit.js'
import { configNameChanges, configNameValue, type NamedChange, type NameChangeAudit } from './name-change-audit.js'

/** One commit queue around the existing Main fact; long host/Git/dialog work is never an updater. */
export class ConfigOwner {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly ports: {
    read(): AppConfig
    prepare?(current: AppConfig, next: AppConfig): AppConfig | Promise<AppConfig>
    save(next: AppConfig): Promise<AppConfig>
    publish(saved: AppConfig): void
    nameAudit?: NameChangeAudit
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
    return this.update((current) => applyConfigEdit(current, before, after), configNameChanges(before, after))
  }

  update(apply: (current: AppConfig) => AppConfig, nameIntents: readonly Pick<NamedChange, 'target' | 'requested'>[] = []): Promise<AppConfig> {
    const capturedIntents = structuredClone(nameIntents)
    return this.enqueue(async () => {
      const current = this.ports.read()
      const intended = capturedIntents.map(intent => ({ ...intent, before: configNameValue(current, intent.target) }))
      let next: AppConfig
      try {
        const requested = apply(current)
        validateThemeConfigEdit(current, requested)
        next = this.ports.prepare ? await this.ports.prepare(current, requested) : requested
      } catch (cause) {
        if (this.ports.nameAudit && intended.length) return await this.ports.nameAudit.run(intended,
          async () => { throw cause }, undefined, () => 'failed')
        throw cause
      }
      const changes = configNameChanges(current, next).filter(change => !intended.some(intent =>
        intent.target.kind === change.target.kind && intent.target.id === change.target.id)).concat(intended)
      const unchanged = JSON.stringify(next) === JSON.stringify(current)
      if (unchanged && changes.length === 0) return current
      const commitPrepared = async (): Promise<AppConfig> => {
        if (unchanged) return current
        const saved = await this.ports.save(next)
        this.ports.publish(saved)
        return saved
      }
      return this.ports.nameAudit
        ? await this.ports.nameAudit.run(changes, commitPrepared, (saved, change) => ({
          actual: configNameValue(saved, change.target),
          reason: configNameValue(saved, change.target) === change.before ? 'unchanged' : null
        }))
        : await commitPrepared()
    })
  }
}
