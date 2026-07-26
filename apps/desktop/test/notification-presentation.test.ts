import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTimelineItem } from '@agentmux/core'
import {
  DEFAULT_NOTIFICATION_MODE_ID,
  NOTIFICATION_TIERS,
  composeAttentionBody,
  presentationForMode,
  resolveNotificationMode,
  resolveNotificationModeId
} from '../src/shared/notification-presentation.js'

// ── The tier table is the single source of truth ────────────────────────────────────────────────────
// 停留时长滑轨的档位表只有一处定义，投递侧与设置界面共用同一张表。这些断言从表反推事实，
// 手写清单会与表一起漂移，所以先证明扫描确实有收获。
describe('notification tier table (single source)', () => {
  it('is a real, ordered dwell ramp: off → durations → until-acknowledged', () => {
    expect(NOTIFICATION_TIERS.length).toBeGreaterThan(0)
    expect(NOTIFICATION_TIERS[0]!.mode).toEqual({ kind: 'off' })
    expect(NOTIFICATION_TIERS[NOTIFICATION_TIERS.length - 1]!.mode).toEqual({ kind: 'until-acknowledged' })

    // The middle stops are dwell durations that strictly increase — that is what makes this ONE
    // dimension rather than an unordered set of toggles.
    const dwellMs = NOTIFICATION_TIERS
      .map((tier) => tier.mode)
      .filter((mode): mode is { kind: 'dwell'; dwellMs: number } => mode.kind === 'dwell')
      .map((mode) => mode.dwellMs)
    expect(dwellMs.length).toBeGreaterThan(0)
    for (let i = 1; i < dwellMs.length; i += 1) expect(dwellMs[i]!).toBeGreaterThan(dwellMs[i - 1]!)
  })

  it('resolves a mode id back to the same table entry, and defaults on anything unknown', () => {
    for (const tier of NOTIFICATION_TIERS) {
      expect(resolveNotificationMode(tier.id)).toEqual(tier.mode)
    }
    const defaultMode = NOTIFICATION_TIERS.find((tier) => tier.id === DEFAULT_NOTIFICATION_MODE_ID)!.mode
    // Unknown id and absent field both fall to the explicit default — never to `off`.
    expect(resolveNotificationMode('nonsense' as never)).toEqual(defaultMode)
    expect(DEFAULT_NOTIFICATION_MODE_ID).not.toBe('off')
  })
})

describe('resolveNotificationModeId (config default)', () => {
  it('defaults when the field is absent, so absence never means "no notifications"', () => {
    // A config written before this field existed: absence must resolve to the explicit default tier,
    // not undefined and not off.
    expect(resolveNotificationModeId({})).toBe(DEFAULT_NOTIFICATION_MODE_ID)
    expect(resolveNotificationModeId(null)).toBe(DEFAULT_NOTIFICATION_MODE_ID)
    expect(resolveNotificationModeId({ notifications: undefined })).toBe(DEFAULT_NOTIFICATION_MODE_ID)
  })

  it('honours a stored choice', () => {
    expect(resolveNotificationModeId({ notifications: { mode: 'off' } })).toBe('off')
    expect(resolveNotificationModeId({ notifications: { mode: 'until-acknowledged' } }))
      .toBe('until-acknowledged')
  })
})

// ── Body composition: from existing projections, truncated, missing segments dropped ──────────────────
function item(kind: AgentTimelineItem['kind'], content: string, id: string): AgentTimelineItem {
  return {
    id, agentSessionId: 'a', kind, status: 'complete',
    source: kind === 'user_message' ? 'user' : 'native-hook',
    createdAt: 1, updatedAt: 1, title: kind, content
  }
}

describe('composeAttentionBody', () => {
  it('names the Agent and state, then the latest assistant reply and user question', () => {
    const body = composeAttentionBody({
      label: 'Refactor bot',
      state: 'waiting',
      items: [
        item('user_message', 'first question', 'u1'),
        item('assistant_message', 'first answer', 'r1'),
        item('user_message', 'second question', 'u2'),
        item('assistant_message', 'second answer', 'r2')
      ]
    })
    // The LATEST of each, not the first — a notification is about the current exchange.
    expect(body).toBe('Refactor bot — Waiting for you\nRefactor bot: second answer\nYou: second question')
  })

  it('omits any segment it cannot find, with no placeholder text', () => {
    // Only a user question exists; the assistant-reply line is absent entirely.
    const body = composeAttentionBody({
      label: 'Bot', state: 'blocked', items: [item('user_message', 'help', 'u1')]
    })
    expect(body).toBe('Bot — Blocked\nYou: help')
    expect(body).not.toMatch(/\(|none|—\s*$/i)

    // No items at all: just the name and state line.
    expect(composeAttentionBody({ label: 'Bot', state: 'done', items: [] })).toBe('Bot — Finished')
    expect(composeAttentionBody({ label: 'Bot', state: 'error' })).toBe('Bot — Error')
  })

  it('truncates a long reply on a character boundary instead of pasting a whole block', () => {
    const wall = 'x'.repeat(500)
    const body = composeAttentionBody({ label: 'Bot', state: 'done', items: [item('assistant_message', wall, 'r1')] })
    const summaryLine = body.split('\n')[1]!
    // The summary is bounded well under the raw length and ends with an ellipsis marker.
    expect(summaryLine.length).toBeLessThan(160)
    expect(summaryLine.endsWith('…')).toBe(true)
  })

  it('collapses newlines so a fenced code block cannot smuggle its own line breaks into a one-line body', () => {
    const codeBlock = '```ts\nconst a = 1\nconst b = 2\n```'
    const body = composeAttentionBody({ label: 'Bot', state: 'done', items: [item('assistant_message', codeBlock, 'r1')] })
    // Exactly two lines: the name+state line and the single collapsed summary line. No block newlines leak.
    expect(body.split('\n').length).toBe(2)
  })

  it('does not split a surrogate pair when truncating', () => {
    // One BMP char (1 code unit) then emoji (2 code units each), well past the char cap. A naive
    // string slice at the cap would land mid-pair here and leave a lone surrogate; Array.from cuts on
    // a code-point boundary. The 1-unit prefix shifts parity so the naive cut actually splits — a
    // pure-emoji string would happen to fall on an even boundary and hide the bug.
    const content = `.${'😀'.repeat(200)}`
    const body = composeAttentionBody({ label: 'Bot', state: 'done', items: [item('assistant_message', content, 'r1')] })
    const summary = body.split('\n')[1]!
    const hasLoneSurrogate = Array.from(summary).some(
      (ch) => ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff
    )
    expect(hasLoneSurrogate).toBe(false)
  })
})

// ── Platform honesty for the "until I dismiss it" tier ────────────────────────────────────────────────
describe('presentationForMode', () => {
  it('keeps a dwell banner as-requested everywhere', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(presentationForMode({ kind: 'dwell', dwellMs: 6000 }, platform)).toBe('as-requested')
    }
  })

  it('downgrades until-acknowledged only where the platform cannot pin it open', () => {
    // Windows/Linux honour timeoutType:'never'; macOS decides banner-vs-alert by system preference, so
    // it is reported honestly as a downgrade rather than a false success.
    expect(presentationForMode({ kind: 'until-acknowledged' }, 'win32')).toBe('as-requested')
    expect(presentationForMode({ kind: 'until-acknowledged' }, 'linux')).toBe('as-requested')
    expect(presentationForMode({ kind: 'until-acknowledged' }, 'darwin')).toBe('downgraded')
  })
})

// ── Main notifier reports the honest presentation end to end ──────────────────────────────────────────
const shown: string[] = []
const constructed: Array<Record<string, unknown>> = []

class FakeNotification {
  static isSupported = vi.fn(() => true)
  private handlers = new Map<string, () => void>()
  constructor(public options: Record<string, unknown>) { constructed.push(options) }
  on(event: string, handler: () => void): void { this.handlers.set(event, handler) }
  once(event: string, handler: () => void): void { this.handlers.set(event, handler) }
  off(): void {}
  removeAllListeners(): void {}
  show(): void { shown.push(String(this.options.title)) }
  close(): void {}
}

vi.mock('electron', () => ({ Notification: FakeNotification }))

// Imported after the mock so the module under test binds to FakeNotification.
const { createAgentNotifier } = await import('../src/main/agent-notifier.js')

function fakeWindow(): Parameters<typeof createAgentNotifier>[0]['window'] {
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => {},
    focus: () => {}
  } as unknown as Parameters<typeof createAgentNotifier>[0]['window']
}

describe('createAgentNotifier delivery result', () => {
  beforeEach(() => {
    shown.length = 0
    constructed.length = 0
    FakeNotification.isSupported.mockReturnValue(true)
  })

  it('reports shown+as-requested and asks the OS to pin it open where the platform allows', () => {
    const notifier = createAgentNotifier({ window: fakeWindow(), onActivate: () => {}, platform: 'linux' })
    const result = notifier.notify({ sessionId: 'a', title: 'Agent finished', body: 'b', mode: 'until-acknowledged' })

    expect(result).toEqual({ status: 'shown', presentation: 'as-requested' })
    expect(shown).toEqual(['Agent finished'])
    // The persistence request actually reached Electron — timeoutType 'never', not 'default'.
    expect(constructed[0]!.timeoutType).toBe('never')
  })

  it('reports shown+downgraded on a platform that cannot pin it, and does NOT ask for never', () => {
    const notifier = createAgentNotifier({ window: fakeWindow(), onActivate: () => {}, platform: 'darwin' })
    const result = notifier.notify({ sessionId: 'a', title: 'Agent finished', body: 'b', mode: 'until-acknowledged' })

    // The banner still showed — this is not "unsupported" — but it did not stay, and we say so.
    expect(result).toEqual({ status: 'shown', presentation: 'downgraded' })
    expect(shown).toEqual(['Agent finished'])
    expect(constructed[0]!.timeoutType).toBe('default')
  })

  it('reports unsupported when the platform cannot notify at all', () => {
    FakeNotification.isSupported.mockReturnValue(false)
    const notifier = createAgentNotifier({ window: fakeWindow(), onActivate: () => {}, platform: 'darwin' })
    const result = notifier.notify({ sessionId: 'a', title: 't', body: 'b', mode: 'standard' })

    expect(result.status).toBe('unsupported')
    expect(shown).toEqual([])
  })
})
