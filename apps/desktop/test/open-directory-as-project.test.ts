import { describe, expect, it } from 'vitest'
import { createDirectoryProjectInput } from '../src/renderer/src/lib/open-directory-as-project.js'

describe('createDirectoryProjectInput', () => {
  const workspace = { hostId: 'local', path: '/repo' } as const

  it('binds a directory to the same host and its absolute nested path', () => {
    expect(createDirectoryProjectInput({
      workspace,
      relativePath: 'packages/core',
      name: 'core',
      isDirectory: true
    })).toEqual({ hostId: 'local', path: '/repo/packages/core', name: 'core' })
  })

  it('supports a workspace-root directory path without a trailing separator', () => {
    expect(createDirectoryProjectInput({
      workspace,
      relativePath: '',
      name: 'repo',
      isDirectory: true
    })).toEqual({ hostId: 'local', path: '/repo', name: 'repo' })
  })

  it('does not produce a project request for a file', () => {
    expect(createDirectoryProjectInput({
      workspace,
      relativePath: 'README.md',
      name: 'README.md',
      isDirectory: false
    })).toBeNull()
  })
})

