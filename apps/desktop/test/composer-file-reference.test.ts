import { describe, expect, it } from 'vitest'
import {
  appendFileReferences,
  workspaceRelativePath
} from '../src/renderer/src/lib/composer-file-reference.js'

describe('composer file references', () => {
  it('writes paths inside the workspace relative to it', () => {
    // The Agent runs with the workspace as its working directory, so that is the form it can resolve.
    expect(workspaceRelativePath('/repo/src/index.ts', '/repo')).toBe('src/index.ts')
    expect(workspaceRelativePath('/repo/src/index.ts', '/repo/')).toBe('src/index.ts')
  })

  it('leaves paths outside the workspace absolute', () => {
    expect(workspaceRelativePath('/etc/hosts', '/repo')).toBe('/etc/hosts')
    // A sibling directory that merely shares a prefix is still outside.
    expect(workspaceRelativePath('/repo-other/file.ts', '/repo')).toBe('/repo-other/file.ts')
  })

  it('keeps the absolute path when there is no workspace to relativize against', () => {
    expect(workspaceRelativePath('/repo/src/index.ts', undefined)).toBe('/repo/src/index.ts')
  })

  it('appends references with exactly one separating space', () => {
    expect(appendFileReferences('look at', ['/repo/a.ts'], '/repo')).toBe('look at @a.ts ')
    // A draft that already ends in a space must not gain a second one.
    expect(appendFileReferences('look at ', ['/repo/a.ts'], '/repo')).toBe('look at @a.ts ')
    // An empty draft starts clean, with no leading space.
    expect(appendFileReferences('', ['/repo/a.ts'], '/repo')).toBe('@a.ts ')
  })

  it('appends every chosen file in one edit', () => {
    expect(appendFileReferences('diff', ['/repo/a.ts', '/repo/b.ts'], '/repo')).toBe('diff @a.ts @b.ts ')
  })

  it('leaves the draft untouched when the picker was dismissed', () => {
    expect(appendFileReferences('unchanged', [], '/repo')).toBe('unchanged')
  })
})
