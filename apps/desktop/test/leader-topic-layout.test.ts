import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import {
  SCRATCH_WORKSPACE_ID,
  scratchTopicDirectoryName,
  scratchTopicIdFromDirectoryName,
  scratchTopicIdFromWorkspacePath,
  workspaceOwnsSessionPath
} from '../src/shared/scratch-topics.js'

describe('canonical Scratch Topic layout', () => {
  it('round-trips the fixed Leader Topic directory', () => {
    const directory = scratchTopicDirectoryName('launcher:leader')
    expect(directory).toBe('topic--launcher--leader')
    expect(scratchTopicIdFromDirectoryName(directory)).toBe('launcher:leader')
    expect(scratchTopicIdFromWorkspacePath(_hygiene_fixturePath("scratch"), (_hygiene_fixturePath("scratch/") + (directory) + ""))).toBe('launcher:leader')
  })

  it('assigns Topic sessions to Scratch without claiming another workspace', () => {
    const scratch = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: _hygiene_fixturePath("scratch") }
    const session = { hostId: 'local', workspacePath: _hygiene_fixturePath("scratch/topic--launcher--leader") }
    expect(workspaceOwnsSessionPath(scratch, session)).toBe(true)
    expect(workspaceOwnsSessionPath({ id: 'repo', hostId: 'local', path: _hygiene_fixturePath("repo") }, session)).toBe(false)
  })
})
