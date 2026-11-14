import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const projectBoard = readFileSync(new URL('../src/renderer/src/lib/project-board.ts', import.meta.url), 'utf8')

describe('shared project activity model', () => {
  it('keeps one definition of the columns and one status mapping', () => {
    expect(projectBoard.match(/export const PROJECT_BOARD_COLUMNS/g)).toHaveLength(1)
    expect(projectBoard.match(/export function sessionBoardColumn/g)).toHaveLength(1)
    // 两种行来源都经同一个投影函数产出 runsByColumn。
    expect(projectBoard.match(/boardRowProjection\(\{/g)).toHaveLength(2)
  })

  it('reuses the shared Topic ownership judgement instead of a second derivation', () => {
    expect(projectBoard).toContain('scratchTopicIdFromWorkspacePath(scratch.path, session.workspacePath, topics)')
    expect(projectBoard).toContain('workspaceOwnsSessionPath(scratch, session, topics)')
  })
})
