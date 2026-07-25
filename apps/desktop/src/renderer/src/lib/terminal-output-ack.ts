export class LatestTerminalOutputAcknowledger {
  private requestedThroughByte = 0
  private attemptedThroughByte = 0
  private draining = false
  private disposed = false

  constructor(
    private readonly acknowledge: (throughByte: number) => Promise<void>,
    private readonly onError: (error: unknown) => void = () => {}
  ) {}

  queue(throughByte: number): void {
    if (this.disposed || throughByte <= this.requestedThroughByte) return
    this.requestedThroughByte = throughByte
    if (this.draining) return
    this.draining = true
    void this.drain()
  }

  dispose(): void {
    this.disposed = true
  }

  private async drain(): Promise<void> {
    while (!this.disposed && this.attemptedThroughByte < this.requestedThroughByte) {
      const throughByte = this.requestedThroughByte
      this.attemptedThroughByte = throughByte
      try {
        await this.acknowledge(throughByte)
      } catch (error) {
        this.onError(error)
      }
    }
    this.draining = false
  }
}
