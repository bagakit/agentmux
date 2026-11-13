import { afterEach, expect, it } from 'vitest'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundInheritedOutput } from '../src/output-retention.js'

/**
 * launchd appends the Host's stdout and stderr to one file and never rotates it. At startup the Host
 * cuts an oversized inherited output file back to its newest whole lines, and leaves everything else
 * (small files, pipes, descriptors it cannot read) as it is.
 */
const roots: string[] = [], fds: number[] = []
afterEach(() => {
  for (const fd of fds.splice(0)) closeSync(fd)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function output(content: string, flags = 'a+') {
  const root = mkdtempSync(join(tmpdir(), 'amx-host-output-')); roots.push(root)
  const path = join(root, 'host.log'); writeFileSync(path, content)
  // Same flags launchd uses for StandardOutPath/StandardErrorPath: read, write, append.
  const fd = openSync(path, flags); fds.push(fd)
  return { path, fd }
}
const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `line ${String(from + index).padStart(4, '0')}\n`).join('')

it('keeps only the newest whole lines of an oversized output file, and later writes follow them', () => {
  const { path, fd } = output(lines(0, 1000))
  // Each line is 10 bytes; keeping 95 bytes cuts mid-line and must start at the next whole one.
  boundInheritedOutput([fd, fd], 5000, 95)
  expect(readFileSync(path, 'utf8')).toBe(lines(991, 1000))
  writeSync(fd, 'next start\n')
  expect(readFileSync(path, 'utf8')).toBe(lines(991, 1000) + 'next start\n')
})

it('leaves a file within the limit, and a descriptor it cannot read, as they are', () => {
  const small = output(lines(0, 10))
  boundInheritedOutput([small.fd], 5000, 95)
  expect(readFileSync(small.path, 'utf8')).toBe(lines(0, 10))
  const writeOnly = output(lines(0, 1000), 'a')
  boundInheritedOutput([writeOnly.fd], 5000, 95)
  expect(readFileSync(writeOnly.path, 'utf8')).toBe(lines(0, 1000))
})
