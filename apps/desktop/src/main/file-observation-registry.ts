type DisposeObservation = () => void

export class FileObservationRegistry {
  private readonly observations = new Map<string, Promise<DisposeObservation>>()
  private disposed = false

  async observe(key: string, start: () => Promise<DisposeObservation>): Promise<void> {
    if (this.disposed) throw new Error('File observation registry is disposed')
    let observation = this.observations.get(key)
    if (!observation) {
      observation = start()
      this.observations.set(key, observation)
    }
    try {
      await observation
    } catch (error) {
      if (this.observations.get(key) === observation) this.observations.delete(key)
      throw error
    }
  }

  async unobserve(key: string): Promise<void> {
    const observation = this.observations.get(key)
    if (!observation) return
    this.observations.delete(key)
    const dispose = await observation
    dispose()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const observations = [...this.observations.values()]
    this.observations.clear()
    const settled = await Promise.allSettled(observations)
    for (const result of settled) {
      if (result.status === 'fulfilled') result.value()
    }
  }
}
