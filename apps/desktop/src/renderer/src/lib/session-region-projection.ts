export type SessionRegionProjectionPolicy = {
  readOnly: boolean
  interactiveResize: boolean
  acceptsInput: boolean
  allowsRecovery: boolean
}

export function sessionRegionProjectionPolicy(readOnly: boolean): SessionRegionProjectionPolicy {
  return readOnly
    ? { readOnly: true, interactiveResize: false, acceptsInput: false, allowsRecovery: false }
    : { readOnly: false, interactiveResize: true, acceptsInput: true, allowsRecovery: true }
}
