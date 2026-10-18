/** Exact presentation of an already validated duration; never a scheduling policy. */
export function readableSettingsDuration(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return 'Enter a valid duration'
  if (value === 0) return 'No delay'
  const hours = Math.floor(value / 3_600_000), minutes = Math.floor((value % 3_600_000) / 60_000), remainder = value % 60_000
  return [hours ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : '', minutes ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : '', remainder ? `${settingsDurationSeconds(remainder)} ${remainder === 1000 ? 'second' : 'seconds'}` : ''].filter(Boolean).join(' ')
}
export function settingsDurationSeconds(milliseconds: number): string {
  const fraction = String(milliseconds % 1000).padStart(3, '0').replace(/0+$/, '')
  return `${Math.floor(milliseconds / 1000)}${fraction ? `.${fraction}` : ''}`
}
