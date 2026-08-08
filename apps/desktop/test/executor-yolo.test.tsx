import { describe, expect, it } from 'vitest'
import { withYoloArgs, yoloArgsForProvider } from '../src/renderer/src/lib/executors.js'
describe('one-click YOLO provider posture', () => {
  it('uses explicit Claude and Codex args', () => {
    expect(yoloArgsForProvider('claude')).toEqual(['--dangerously-skip-permissions'])
    expect(yoloArgsForProvider('codex')).toEqual(['--dangerously-bypass-approvals-and-sandbox'])
  })
  it('replaces conflicting posture flags while preserving model', () => {
    expect(withYoloArgs('codex', ['--model', 'gpt-5', '--sandbox', 'read-only', '--ask-for-approval', 'on-request'])).toEqual(['--model', 'gpt-5', '--dangerously-bypass-approvals-and-sandbox'])
    expect(withYoloArgs('claude', ['--model', 'opus', '--permission-mode=manual'])).toEqual(['--model', 'opus', '--dangerously-skip-permissions'])
  })
  it('does not invent posture for unsupported Providers', () => { expect(withYoloArgs('gemini', [])).toBeNull() })
})
