export type DeviceHomeStep = 'read' | 'register' | 'open'

/** The original cause stays available for diagnostics; product copy uses machine fields only. */
export class DeviceHomeError extends Error {
  constructor(readonly step: DeviceHomeStep, cause: unknown) {
    super('Device home could not be opened.', { cause })
    this.name = 'DeviceHomeError'
  }
}

export function deviceHomeFailureDetail(error: unknown): string {
  const step = error instanceof DeviceHomeError ? error.step : 'read'
  const cause = error instanceof DeviceHomeError ? error.cause : error
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
  const stage = step === 'register' ? 'Saving the home directory was not confirmed.'
    : step === 'open' ? 'Opening the home workface was not confirmed.' : 'Reading this device’s home directory was not confirmed.'
  const reason = code === 'REMOTE_CORE_UPGRADE_REQUIRED' ? 'Remote Core update required. Its protocol is older than this client supports.'
    : code === 'CONTROL_PROTOCOL_ERROR' ? 'The device did not confirm a valid Runtime response.'
    : code === 'DEVICE_HOME_TARGET_CHANGED' ? 'The device configuration changed. Use its current entry.'
      : code === 'DEVICE_HOME_TARGET_MISMATCH' ? 'The response did not identify this device.'
        : code === 'CONTROL_TIMEOUT' ? 'The original request did not confirm a result in time.'
          : code === 'CONTROL_UNAVAILABLE' || code === 'RUNTIME_UNAVAILABLE' ? 'The original Core connection could not confirm this read.' : ''
  return [stage, reason, 'Retry opens home on this device. Existing work and Agents are retained.'].filter(Boolean).join('\n')
}
