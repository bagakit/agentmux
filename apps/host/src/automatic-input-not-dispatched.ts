/** Internal Host evidence: this invocation did not reach the Core input port. */
export class AutomaticInputNotDispatchedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AutomaticInputNotDispatchedError'
  }
}
