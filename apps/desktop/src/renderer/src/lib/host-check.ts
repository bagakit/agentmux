import type { HostConfig } from '../../../shared/contracts'
import { configValuesEqual } from '../../../shared/config-edit'
import type { HostCheckState } from '../store'

/** A diagnostic describes its captured input, not every later object with the same ID. */
export function currentHostCheck(check: HostCheckState | undefined, host: HostConfig): HostCheckState | undefined {
  if (!check || check.state === 'idle') return check
  return check.input && configValuesEqual(check.input, host) ? check : { state: 'idle' }
}

export function hostCheckLabel(check: HostCheckState): string {
  if (check.state === 'ready') return 'Ready'
  if (check.state === 'checking') return 'Testing'
  if (check.state === 'idle') return 'Not tested'
  return check.result?.outcome === 'unsupported' ? 'Not supported' : 'Check failed'
}
