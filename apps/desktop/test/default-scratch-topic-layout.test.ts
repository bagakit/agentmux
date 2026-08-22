import { describe, expect, it } from 'vitest'
import {
  SCRATCH_WORKSPACE_ID,
  scratchTopicDirectoryName,
  scratchTopicIdFromDirectoryName,
  scratchTopicIdFromWorkspacePath,
  workspaceOwnsSessionPath
} from '../src/shared/scratch-topics.js'

describe('canonical Scratch Topic layout', () => {
  it('round-trips the default launcher Topic directory', () => {
    const directory = scratchTopicDirectoryName('launcher:default')
    expect(directory).toBe('topic--launcher--default')
    expect(scratchTopicIdFromDirectoryName(directory)).toBe('launcher:default')
    expect(scratchTopicIdFromWorkspacePath('/scratch', `/scratch/${directory}`)).toBe('launcher:default')
  })

  it('assigns Topic sessions to Scratch without claiming another workspace', () => {
    const scratch = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: '/scratch' }
    const session = { hostId: 'local', workspacePath: '/scratch/topic--launcher--default' }
    expect(workspaceOwnsSessionPath(scratch, session)).toBe(true)
    expect(workspaceOwnsSessionPath({ id: 'repo', hostId: 'local', path: '/repo' }, session)).toBe(false)
  })
})
