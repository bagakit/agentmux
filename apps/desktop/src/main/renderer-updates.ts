import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateRendererRelease, type RendererRelease } from './renderer-release.js'

export type RendererPointer = { current: string | null; previous: string | null }
function releaseId(value: unknown): value is string | null { return value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
function bundledReleaseId(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }

/** Versioned presentation only. The host, IPC owners and Run clients never unload here. */
export class RendererUpdates {
  private watcher: FSWatcher | undefined
  private tail = Promise.resolve()
  private current: string | null = null
  private identity!: RendererRelease['identity']
  constructor(private readonly options: {
    directory: string
    bundled: string
    prepare(): Promise<void>
    load(file: string): Promise<void>
    report(error: unknown): void
  }) {}

  async initialize(): Promise<void> {
    const bundledRelease = JSON.parse(await readFile(join(this.options.bundled, 'release.json'), 'utf8')) as RendererRelease
    if (!bundledReleaseId(bundledRelease.id)) throw new Error('Bundled Renderer release identity is invalid')
    this.identity = bundledRelease.identity
    await mkdir(this.options.directory, { recursive: true })
    let pointer: RendererPointer = { current: null, previous: null }
    const marker = await this.bundledMarker()
    const bundledChanged = marker !== bundledRelease.id
    try {
      try { pointer = await this.pointer() }
      catch (error) {
        await this.options.load(await this.resolve(null))
        await this.publish(pointer)
        await this.writeBundledMarker(bundledRelease.id)
        this.options.report(error)
        return
      }
      if (bundledChanged) {
        pointer = { current: null, previous: null }
        await this.publish(pointer)
      }
      await this.options.load(await this.resolve(pointer.current))
      this.current = pointer.current
      await this.writeBundledMarker(bundledRelease.id)
      await this.recordOutcome(pointer.current).catch(this.options.report)
    } catch (error) {
      // A staged page can fail on cold start too. Recover before announcing readiness.
      if (pointer.current === null) throw error
      let restored = pointer.previous
      let file: string
      try { file = await this.resolve(restored) }
      catch { restored = null; file = await this.resolve(null) }
      await this.options.load(file)
      this.current = restored
      await this.publish({ current: restored, previous: pointer.current })
      await this.writeBundledMarker(bundledRelease.id)
      this.options.report(error)
    }
  }
  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.tail.then(action)
    this.tail = result.catch(() => {})
    return result
  }
  start(): void {
    this.watcher = watch(this.options.directory, (_event, name) => {
      if (name !== 'active.json') return
      void this.apply().catch(this.options.report)
    })
    this.watcher.on('error', this.options.report)
  }
  dispose(): void { this.watcher?.close() }
  private async pointer(): Promise<RendererPointer> {
    const value = await readFile(join(this.options.directory, 'active.json'), 'utf8').then(JSON.parse).catch((error) => {
      if (error.code === 'ENOENT') return { current: null, previous: null }
      throw error
    })
    if (!releaseId(value.current) || !releaseId(value.previous)) throw new Error('Invalid renderer version pointer')
    return value
  }
  private async bundledMarker(): Promise<string | null> {
    try {
      const value = JSON.parse(await readFile(join(this.options.directory, 'bundled.json'), 'utf8'))
      return bundledReleaseId(value?.id) ? value.id : null
    } catch {
      return null
    }
  }
  private async writeBundledMarker(id: string): Promise<void> {
    const temporary = join(this.options.directory, `.bundled-${randomUUID()}.json`)
    await writeFile(temporary, JSON.stringify({ schema: 1, id }), { mode: 0o600 })
    await rename(temporary, join(this.options.directory, 'bundled.json'))
  }
  private async resolve(id: string | null): Promise<string> {
    if (id === null) return join(this.options.bundled, 'index.html')
    const directory = join(this.options.directory, id)
    const release = await validateRendererRelease(directory, this.identity)
    if (release.id !== id) throw new Error('Renderer release identity mismatch')
    return join(directory, 'index.html')
  }
  private async recordOutcome(requested: string | null, error?: unknown): Promise<void> {
    const temporary = join(this.options.directory, `.status-${randomUUID()}.json`)
    await writeFile(temporary, JSON.stringify({ requested, current: this.current,
      outcome: error === undefined ? 'applied' : 'rejected', at: Date.now(),
      ...(error === undefined ? {} : { message: error instanceof Error ? error.message : String(error) })
    }), { mode: 0o600 })
    await rename(temporary, join(this.options.directory, 'status.json'))
  }
  private async publish(pointer: RendererPointer): Promise<void> {
    const temporary = join(this.options.directory, `.active-${randomUUID()}.json`)
    await writeFile(temporary, JSON.stringify(pointer), { mode: 0o600 })
    await rename(temporary, join(this.options.directory, 'active.json'))
  }
  private async publishResult(expected: RendererPointer, result: RendererPointer): Promise<void> {
    const latest = await this.pointer()
    // A request staged while load was in flight belongs to the next queued operation.
    if (latest.current === expected.current && latest.previous === expected.previous) await this.publish(result)
  }
  apply(): Promise<void> { return this.enqueue(() => this.applyPointer()) }
  private async applyPointer(): Promise<void> {
    const next = await this.pointer()
    if (next.current === this.current) { await this.recordOutcome(next.current); return }
    let file: string
    try {
      file = await this.resolve(next.current)
      await this.options.prepare()
    } catch (error) {
      await this.publishResult(next, { current: this.current, previous: next.current })
      await this.recordOutcome(next.current, error)
      throw error
    }
    const previous = this.current
    try {
      await this.options.load(file)
    } catch (error) {
      await this.options.load(await this.resolve(previous))
      await this.publishResult(next, { current: previous, previous: next.current })
      await this.recordOutcome(next.current, error)
      throw new Error(`Frontend update failed; restored the previous interface. ${error instanceof Error ? error.message : String(error)}`)
    }
    this.current = next.current
    await this.publishResult(next, { current: this.current, previous })
    await this.recordOutcome(next.current)
  }
  rollback(): Promise<void> {
    return this.enqueue(async () => {
      const pointer = await this.pointer()
      await this.publish({ current: pointer.previous, previous: this.current })
      await this.applyPointer()
    })
  }
}
