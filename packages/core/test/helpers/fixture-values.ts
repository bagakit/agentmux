import { tmpdir } from 'node:os'
import { join, parse, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const fixtureRoot = join(tmpdir(), 'agentmux-fixtures')
const dayMilliseconds = 24 * 60 * 60 * 1_000

/** Preserve lexical path cases while deriving the absolute root from this Host. */
export function fixturePath(relative: string): string {
  const temporary = relative.replace(/^(?:private\/)?tmp\//u, '')
  const base = temporary === relative ? fixtureRoot : tmpdir()
  return base + sep + temporary.replaceAll('/', sep)
}

/** Deterministic time from Unix zero and explicit relative units. */
export function fixtureEpoch(days: number, seconds = 0, milliseconds = 0): number {
  return days * dayMilliseconds + seconds * 1_000 + milliseconds
}

export function fixtureDay(days: number, separator = '-'): string {
  return new Date(fixtureEpoch(days)).toISOString().slice(0, 10).replaceAll('-', separator)
}

export function fixtureClock(hour: number, minute: number, second?: number, milliseconds?: string): string {
  const units = second === undefined ? [hour, minute] : [hour, minute, second]
  const clock = units.map(value => String(value).padStart(2, '0')).join(':')
  return milliseconds === undefined ? clock : clock + '.' + milliseconds
}

export function fixtureFileUrl(relative: string): string {
  return pathToFileURL(fixturePath(relative)).href
}

/** A short Host-rooted display path keeps captured terminal rows within their viewport. */
export function fixtureDisplayPath(relative: string): string {
  return join(parse(tmpdir()).root, relative)
}
