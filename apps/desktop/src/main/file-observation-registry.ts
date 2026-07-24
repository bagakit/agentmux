type DisposeObservation = () => Promise<void>

export class FileObservationRegistry {
  private readonly observations = new Map<string, Promise<DisposeObservation>>()
  private readonly observationDisposals = new Map<Promise<DisposeObservation>, Promise<void>>()
  private disposed = false
  private disposal: Promise<void> | undefined

  private disposeObservation(observation: Promise<DisposeObservation>): Promise<void> {
    let disposal = this.observationDisposals.get(observation)
    if (!disposal) {
      disposal = observation.then(async (dispose) => await dispose())
      this.observationDisposals.set(observation, disposal)
      void disposal.finally(() => this.observationDisposals.delete(observation)).catch(() => {})
    }
    return disposal
  }

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
    await this.disposeObservation(observation)
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true
      const observations = [...this.observations.values()]
      this.observations.clear()
      this.disposal = Promise.allSettled([
        ...this.observationDisposals.values(),
        ...observations.map((observation) => this.disposeObservation(observation))
      ]).then(() => {})
    }
    return this.disposal
  }
}
