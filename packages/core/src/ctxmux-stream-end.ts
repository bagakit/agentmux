/** An Attachment has its own socket. Its end alone says nothing about other readers or Runs. */
export type CtxmuxStreamEndKind = 'detached' | 'run-exited' | 'observation-unavailable'

export type CtxmuxStreamEndObservation = {
  /** 这条流在收尾前是否发过终结事件（exited/interrupted）。 */
  sawTerminalEvent: boolean
  /** 收尾时 attachment map 是否仍是我们这一次（token 未被换/删）。false = 我们自己 detach 的。 */
  stillOwned: boolean
}

export function classifyStreamEnd(observation: CtxmuxStreamEndObservation): CtxmuxStreamEndKind {
  if (!observation.stillOwned) return 'detached'
  return observation.sawTerminalEvent ? 'run-exited' : 'observation-unavailable'
}
