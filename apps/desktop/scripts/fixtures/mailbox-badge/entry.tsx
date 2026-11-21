import { flushSync } from 'react-dom'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import type { ContinuousProgressLoop, DurableAgentMuxMessage } from '@agentmux/core'

// Production Workbench/Composer/Mailbox/xterm, with finite read-only preview ports.
await import('../result-ready-input-continuity/entry')
const base = (window as any).resultReady
mountThemeRuntime(window, { appAppearance: 'dark' })
const attach = api.sessions.attach
api.sessions.attach = async (...args) => {
  const attached = await attach(...args)
  return {
    ...attached,
    terminal:
      attached.terminal.type === 'basic-vt'
        ? {
            ...attached.terminal,
            checkpoint: {
              ...attached.terminal.checkpoint,
              historyPolicy: { status: 'observed', scrollbackRows: 1000 }
            }
          }
        : attached.terminal
  }
}
const reads: unknown[] = [],
  listeners = new Set<Parameters<typeof api.sessions.onEvent>[0]>()
const subscribe = api.sessions.onEvent
api.sessions.onEvent = (listener) => {
  listeners.add(listener)
  const release = subscribe(listener)
  return () => {
    listeners.delete(listener)
    release()
  }
}
let journal: DurableAgentMuxMessage[] = [],
  loop: ContinuousProgressLoop | null = null,
  noticeRevision = 0
api.continuousProgress.list = async (target) =>
  loop && target.hostId === loop.hostId && target.agentSessionId === loop.agentSessionId
    ? [loop]
    : []
api.schedule.list = async () => ({ schedules: [], executionScope: 'connected-host' })
api.sessions.listMessages = async (reference, query) => {
  reads.push({ kind: 'messages', reference, query })
  const matching = journal
    .filter(
      (item) =>
        reference.hostId === 'local' &&
        (query.direction === 'incoming'
          ? item.envelope.recipientSessionId
          : item.envelope.senderSessionId) === reference.agentSessionId &&
        (query.beforeSequence === undefined || item.sequence < query.beforeSequence)
    )
    .sort((a, b) => b.sequence - a.sequence)
  const selected = matching.slice(0, query.limit ?? 25)
  return {
    hostId: reference.hostId,
    participantSessionId: reference.agentSessionId,
    direction: query.direction,
    messages: selected.map((item) => {
      const { body, ...envelope } = item.envelope
      return {
        ...item,
        envelope,
        bodyPreview: body,
        bodyBytes: new TextEncoder().encode(body).byteLength
      }
    }),
    nextBeforeSequence: matching.length > selected.length ? selected.at(-1)!.sequence : null
  }
}
api.sessions.readMessage = async (reference, messageId) => ({
  hostId: reference.hostId,
  message:
    journal.find(
      (item) =>
        item.envelope.messageId === messageId &&
        [item.envelope.senderSessionId, item.envelope.recipientSessionId].includes(
          reference.agentSessionId
        )
    ) ?? null
})
api.sessions.inputMailbox = async (reference, options) => ({
  agentSessionId: reference.agentSessionId,
  queueId: 'private-badge-input-journal',
  cut: { incarnation: 'private-badge-cut', throughSequence: 0 },
  budgetBytes: options?.maxBytes ?? 64 * 1024,
  items: [],
  nextCursor: null,
  coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' }
})
const probe = {
  sessionId: base.sessionId,
  seed() {
    journal = []
    base.seed()
    const sessions = useAppStore.getState().sessions,
      owner = sessions.find((session) => session.id === base.sessionId)!,
      peer = sessions.find((session) => session.id !== base.sessionId)!
    if (owner.kind !== 'agent' || peer.kind !== 'agent')
      throw Error('The exact original preview Agent pair is required.')
    journal = Array.from({ length: 100 }, (_, index): DurableAgentMuxMessage => ({
      sequence: index + 1,
      envelope: {
        schema: 'agentmux.a2a.v1',
        messageId: `badge-message-${index + 1}`,
        operationId: `badge-operation-${index + 1}`,
        createdAt: index + 1,
        sender: { kind: 'agent-session', agentSessionId: peer.id },
        recipient: { kind: 'agent-session', agentSessionId: owner.id },
        senderSessionId: peer.id,
        senderRunId: peer.control.run.runId,
        recipientSessionId: owner.id,
        recipientRunId: owner.control.run.runId,
        threadId: `badge-thread-${index + 1}`,
        correlationId: `badge-correlation-${index + 1}`,
        replyTo: null,
        body: `Original private Agent message ${index + 1}`
      },
      delivery: { state: 'delivered', at: index + 1 }
    }))
    loop = {
      loopId: 'private-badge-automation',
      hostId: owner.hostId,
      agentSessionId: owner.id,
      providerId: owner.providerId,
      workspacePath: owner.workspacePath,
      status: 'active',
      intervalMs: 60000,
      nextCheckAt: Date.now() + 60000,
      prompt: 'Retain the original private task.'
    }
    flushSync(() =>
      useAppStore.setState((state) => ({
        noticeReadReceipts: {},
        agentSteerInFlight: {},
        agentSteerQueues: {},
        agentComposerDrafts: {
          ...state.agentComposerDrafts,
          [base.sessionId]: 'Original unsent draft'
        },
        sessions: state.sessions.map((session) =>
          session.id === base.sessionId
            ? {
                ...session,
                contextWindowUsage: {
                  usedTokens: 25000,
                  capacityTokens: 100000,
                  observedAt: Date.now()
                }
              }
            : session
        )
      }))
    )
    queueMicrotask(() => {
      for (const listener of listeners)
        listener({
          type: 'core',
          hostId: owner.hostId,
          event: {
            type: 'agent-message-changed',
            sequence: 100,
            senderSessionId: peer.id,
            recipientSessionId: owner.id
          }
        })
    })
  },
  // Existing human-read receipts are controlled boundary inputs; the component computes unread
  // from its actual four requested journal pages. No unread prop or oversized page is injected.
  unread(count: number) {
    flushSync(() =>
      useAppStore.setState((state) => ({
        noticeReadReceipts: {
          ...state.noticeReadReceipts,
          [`mail:${base.sessionId}`]: Object.fromEntries(
            journal
              .slice(0, 100 - count)
              .map((item) => [
                JSON.stringify(['local', item.envelope.messageId]),
                String(item.sequence)
              ])
          )
        }
      }))
    )
  },
  notices(value: boolean) {
    if (value) ++noticeRevision
    flushSync(() =>
      useAppStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === base.sessionId
            ? {
                ...session,
                terminalPromptDelivery: value
                  ? {
                      state: 'unverified' as const,
                      mode: 'degraded' as const,
                      reason: 'screen-evidence-gap' as const,
                      submissionId: `private-badge-notice-${noticeRevision}`,
                      run: session.control.run,
                      observedAt: noticeRevision
                    }
                  : undefined
              }
            : session
        )
      }))
    )
  },
  progress(value: 'active' | 'inactive') {
    if (!loop) throw Error('The original automation scope is absent.')
    loop = { ...loop, status: value === 'active' ? 'active' : 'stopped' }
  },
  draft(text: string) {
    flushSync(() => useAppStore.getState().setAgentComposerDraft(base.sessionId, text))
  },
  appearance(appAppearance: 'dark' | 'light') {
    updateThemeSelection({ appAppearance })
  },
  facts() {
    return {
      ...base.facts(),
      receipts: useAppStore.getState().noticeReadReceipts,
      reads,
      journalCount: journal.length
    }
  },
  terminal: base.terminal
}
Object.assign(window, { mailboxBadge: probe })
probe.seed()
