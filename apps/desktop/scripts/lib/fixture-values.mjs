/** Short POSIX absolute-path fixtures derived from this module's filesystem root.
 * Relative arguments are explicit test slugs, shared by Main and Renderer.
 * Preserve directory and adjacent-prefix relationships without a machine path. */
const moduleLocation = new URL(import.meta.url)
const filesystemLocation = new URL('/', moduleLocation)
const filesystemRoot = decodeURIComponent(filesystemLocation.pathname)
// Native Unix sockets need the short system temporary root on Darwin. The
// per-user temporary directory can exceed sockaddr_un after nested fixture roots.
const temporaryRoot = typeof process !== 'undefined' && process.platform === 'darwin'
  ? decodeURIComponent(new URL('tmp/', filesystemLocation).pathname)
  : typeof process !== 'undefined' && (process.env.TMPDIR || process.env.TEMP || process.env.TMP) || filesystemRoot + 'tmp'
export function fixturePath(relative = '') {
  if (relative === 'private/tmp' || relative.startsWith('private/tmp/')) relative = relative.slice('private/'.length)
  if (relative === 'tmp' || relative.startsWith('tmp/')) return `${temporaryRoot.replace(/\/$/, '')}${relative.length > 3 ? '/' + relative.slice(4) : ''}`
  return relative ? `${filesystemRoot}${relative}` : filesystemRoot
}
export function fixtureFileUrl(relative = '') { const url = new URL(relative, new URL('file:' + filesystemRoot)); url.pathname = fixturePath(url.pathname.replace(/^\/+/, '')); return url.href }

// Schedules use a non-leap calendar whose New Year is Thursday. Selecting it from
// the current year preserves weekday, month-end and DST boundary tests over time.
let calendarYear = new Date().getUTCFullYear()
while (new Date(Date.UTC(calendarYear, 0, 1)).getUTCDay() !== 4 || new Date(Date.UTC(calendarYear, 1, 29)).getUTCMonth() === 1 || new Date(Date.UTC(calendarYear + 2, 1, 29)).getUTCMonth() !== 1) calendarYear++
export const fixtureYear = calendarYear
export function fixtureCivil(month, day, yearDelta = 0) { return `${fixtureYear + yearDelta}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` }
const fixtureOrigin = Date.UTC(fixtureYear, 0, 1)
export function fixtureTime(offset = 0) { return fixtureOrigin + offset }
export function fixtureIso(offset = 0, shape = 'full', zoneMinutes = 0) {
  const value = new Date(fixtureTime(offset) + zoneMinutes * 60_000).toISOString()
  if (shape === 'date') return value.slice(0, 10)
  if (shape === 'local-minute') return value.slice(0, 16)
  if (shape === 'minute') return value.slice(0, 16) + 'Z'
  if (shape === 'second') return value.slice(0, 19) + 'Z'
  if (shape === 'zone-second' || shape === 'zone-minute') {
    const sign = zoneMinutes < 0 ? '-' : '+'
    const minutes = Math.abs(zoneMinutes)
    return value.slice(0, shape === 'zone-second' ? 19 : 16) + sign + String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0')
  }
  return value
}

/** Serialized fixtures store relative clocks/paths; resolve before protocol parsing. */
export function fixtureData(value) {
  if (Array.isArray(value)) return value.map(fixtureData)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [fixtureData(key), fixtureData(item)]))
  if (typeof value !== 'string') return value
  if (/^[{[]/.test(value)) return value
    .replace(/"relative-time:(-?\d+)"/g, (_match, offset) => String(fixtureTime(Number(offset))))
    .replace(/relative-iso:(-?\d+)/g, (_match, offset) => fixtureIso(Number(offset)))
    .replace(/fixture-path:((?:\\.|[^"\\])*)/g, (_match, relative) => JSON.stringify(fixturePath(JSON.parse('"' + relative + '"'))).slice(1, -1))
  const time = /^relative-time:(-?\d+)$/.exec(value)
  if (time) return fixtureTime(Number(time[1]))
  const iso = /^relative-iso:(-?\d+)$/.exec(value)
  if (iso) return fixtureIso(Number(iso[1]))
  if (value.startsWith('fixture-path:')) return fixturePath(value.slice('fixture-path:'.length))
  return value
}

/** Native ps lstart syntax, with a relative clock rather than one recorded birth. */
export function fixturePsBirth(offset = 0) {
  const value = new Date(fixtureTime(offset))
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', timeZone: 'UTC' }).formatToParts(value).map(part => [part.type, part.value]))
  const clock = [value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds()].map(part => String(part).padStart(2, '0')).join(':')
  return `${parts.weekday} ${parts.month} ${value.getUTCDate()} ${clock} ${value.getUTCFullYear()}`
}

/** A civil clock fixture: explicit hour/minute meaning, without a recorded time. */
export function fixtureClock(hour, minute = 0, second, fraction, precision = 0) {
  const clock = new Date(fixtureTime((hour * 3600 + minute * 60 + (second ?? 0)) * 1000)).toISOString().slice(11, second === undefined ? 16 : 19)
  return precision ? clock + '.' + String(fraction).padStart(precision, '0') : clock
}
