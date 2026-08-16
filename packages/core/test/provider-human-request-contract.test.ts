import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { normalizeAgentInteractionResponse } from '../src/agent-interaction.js'
import type {
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse,
  AgentMuxPermissionRequest
} from '../src/types.js'

/**
 * T-003 gate: the typed human-interaction seam has ONE request-identity owner and ONE response-legality
 * owner, and the vendor keystroke is resolved core-side — the client sends only semantics, never bytes.
 *
 * Every assertion here drives the REAL production providers (`claude`, `codex`, `grok`) through
 * `AgentProviderRegistry`, so the test exercises the same objects `client.respondAgentInteraction`
 * (packages/core/src/client.ts:2366 live, :2653 crash-recovery) and `runtime-controller.setPosture`
 * (apps/desktop/src/main/runtime-controller.ts:885) consume in production. It is deliberately behavioural,
 * not a source scan: it fails if the byte-resolution seam is broken, not merely if a string moves.
 *
 * Mutation evidence (2026-09-15): deleting the `request.id !== response.requestId` half of the one
 * legality check in `agent-interaction.ts:365` — rebuilding `packages/core/dist` so the freshness guard
 * cannot pre-empt the run — turns ONLY the identity case red (1 failed | 4 passed). The other four hold,
 * so the assertions are separable rather than one clump riding a single code path.
 */

const ESC = ''
const registry = new AgentProviderRegistry()

function permissionRequest(providerId: 'claude' | 'codex', receiptId: string): AgentMuxPermissionRequest {
  const provider = registry.get(providerId)
  // A native PermissionRequest whose tool is NOT a question tool takes the permission branch
  // (canonicalHookLifecycleEvent === 'permission-request'), exactly as it does in production.
  const norm = provider.normalizeHook({
    receiptId,
    agentSessionId: 'agent-1',
    runId: 'run-1',
    providerId,
    eventName: 'PermissionRequest',
    payload: { tool_name: 'Edit', tool_input: { path: 'src/index.ts' } }
  })
  const request = norm.interaction
  if (!request || request.kind !== 'permission') {
    throw new Error('expected a native-hook permission interaction request')
  }
  return request
}

describe('Provider human-interaction request contract (T-003)', () => {
  it('withholds the vendor keystroke from the IPC request and resolves it core-side per picked option', () => {
    const claude = registry.get('claude')
    const request = permissionRequest('claude', 'rcpt-claude-1')

    // The DESCRIBE half crosses IPC; the CONTRIBUTE half (the keystroke) is dropped. A renderer that
    // only sees this request has no byte to fabricate — it can send an optionId and nothing else.
    expect(request.options.map((option) => option.id)).toEqual(['allow-once', 'allow-always', 'reject-once'])
    for (const option of request.options) {
      expect('input' in option).toBe(false)
    }

    // The picked option's declared byte is resolved core-side. optionId → byte is the Provider's private
    // knowledge, never the client's.
    const plan = (optionId: string) => claude.planInteractionResponse(request, {
      kind: 'permission',
      requestId: 'rcpt-claude-1',
      decision: { outcome: 'selected', optionId }
    })
    expect(plan('allow-once')).toEqual({ data: '1' })
    expect(plan('allow-always')).toEqual({ data: '2' })
    expect(plan('reject-once')).toEqual({ data: ESC })
    // Cancelling the whole request is ESC, not a fabricated decline byte.
    expect(claude.planInteractionResponse(request, {
      kind: 'permission',
      requestId: 'rcpt-claude-1',
      decision: { outcome: 'cancelled' }
    })).toEqual({ data: ESC })

    // A second Provider resolves its OWN declared bytes from the same semantic answer shape.
    const codex = registry.get('codex')
    const codexRequest = permissionRequest('codex', 'rcpt-codex-1')
    expect(codexRequest.options.map((option) => option.id)).toEqual(['allow-once', 'reject-once'])
    expect(codex.planInteractionResponse(codexRequest, {
      kind: 'permission',
      requestId: 'rcpt-codex-1',
      decision: { outcome: 'selected', optionId: 'allow-once' }
    })).toEqual({ data: '1' })
  })

  it('derives request identity from the ingestion receipt id and rejects a mismatched response', () => {
    const claude = registry.get('claude')
    const request = permissionRequest('claude', 'rcpt-identity')
    expect(request.id).toBe('rcpt-identity')
    expect(request.evidence.source).toBe('native-hook')
    expect(request.evidence.hookReceiptId).toBe('rcpt-identity')

    // The one legality validator compares the response's requestId against the request's id; a response
    // aimed at a different request is refused, on both the provider path and the validator directly.
    const wrongId: AgentMuxInteractionResponse = {
      kind: 'permission',
      requestId: 'some-other-request',
      decision: { outcome: 'selected', optionId: 'allow-once' }
    }
    expect(() => claude.planInteractionResponse(request, wrongId)).toThrow('does not match its request')
    expect(() => normalizeAgentInteractionResponse(request, wrongId)).toThrow('does not match its request')
  })

  it('routes every response through the single legality validator', () => {
    const claude = registry.get('claude')
    const request = permissionRequest('claude', 'rcpt-legality')

    // Unknown option id — rejected by the one validator, reached through the provider's plan path.
    const unknownOption: AgentMuxInteractionResponse = {
      kind: 'permission',
      requestId: 'rcpt-legality',
      decision: { outcome: 'selected', optionId: 'invented' }
    }
    expect(() => claude.planInteractionResponse(request, unknownOption)).toThrow('unknown option')
    expect(() => normalizeAgentInteractionResponse(request, unknownOption)).toThrow('unknown option')

    // Wrong response kind for a permission request — same validator refuses it.
    const wrongKind = {
      kind: 'question',
      requestId: 'rcpt-legality',
      outcome: 'cancelled'
    } as unknown as AgentMuxInteractionResponse
    expect(() => normalizeAgentInteractionResponse(request, wrongKind)).toThrow('does not match its request')

    // A malformed outcome is refused rather than silently coerced into a byte.
    const badOutcome = {
      kind: 'permission',
      requestId: 'rcpt-legality',
      decision: { outcome: 'invented', optionId: 'allow-once' }
    } as unknown as AgentMuxInteractionResponse
    expect(() => normalizeAgentInteractionResponse(request, badOutcome)).toThrow('outcome is invalid')
  })

  it('resolves posture-set keystrokes core-side, and posture is a Provider capability not a global one', () => {
    const grok = registry.get('grok')
    // The composer sends a mode id; the byte that SETS that mode is resolved core-side from the
    // declaration, never generated by the client.
    expect(grok.planPostureSet('ask')).toEqual({ data: '/always-approve off\r' })
    expect(grok.planPostureSet('always-approve')).toEqual({ data: '/always-approve on\r' })
    expect(() => grok.planPostureSet('yolo')).toThrow('does not declare')

    // Fail closed: a Provider that declares no posture control refuses to plan one — a posture set is a
    // per-Provider in-band capability, not a host/global switch.
    expect(() => registry.get('claude').planPostureSet('ask')).toThrow('does not expose a live posture control')
    // Symmetrically, a Provider that declares no interaction protocol refuses to plan a response byte.
    expect(() => grok.planInteractionResponse(
      { kind: 'permission', id: 'x', agentSessionId: 'a', title: 't', options: [], evidence: { source: 'native-hook', observedAt: 0 } },
      { kind: 'permission', requestId: 'x', decision: { outcome: 'cancelled' } }
    )).toThrow('does not support semantic terminal interactions')
  })

  it('keeps the interaction request union to provider permission and question only (no host permission merged in)', () => {
    // Compile-time SSOT anchor (this file is inside packages/core tsconfig `include`, so tsc enforces it):
    // if a host-permission kind is ever merged into AgentMuxInteractionRequest, this Record demands the new
    // key and tsc fails (TS2741) — the plan's "host and provider permissions are not one request" invariant.
    const kinds: Record<AgentMuxInteractionRequest['kind'], true> = { permission: true, question: true }

    // Why the union matters at runtime, not just to tsc: the one legality validator dispatches with
    // `if (request.kind === 'permission') { … }` and then FALLS THROUGH to the question branch
    // (agent-interaction.ts:371 / :392). A third kind would be silently validated as a question rather
    // than refused. So each declared kind must own a branch that rejects the OTHER kind's response —
    // that is what proves the dispatch is exhaustive today, and it is not a restatement of the literal
    // above: it drives the real validator once per kind.
    const permission = permissionRequest('claude', 'rcpt-union')
    const question: AgentMuxInteractionRequest = {
      kind: 'question',
      id: 'rcpt-union-q',
      agentSessionId: 'agent-1',
      title: 'Pick one',
      questions: [{ id: 'q1', prompt: 'Which?', options: [{ id: 'o1', label: 'One' }] }],
      evidence: { source: 'native-hook', observedAt: 0 }
    }
    const requestFor: Record<AgentMuxInteractionRequest['kind'], AgentMuxInteractionRequest> = {
      permission,
      question
    }
    expect(Object.keys(requestFor).sort()).toEqual(Object.keys(kinds).sort())

    for (const [kind, request] of Object.entries(requestFor)) {
      const foreignKind = kind === 'permission' ? 'question' : 'permission'
      const foreign = { kind: foreignKind, requestId: request.id } as unknown as AgentMuxInteractionResponse
      expect(() => normalizeAgentInteractionResponse(request, foreign)).toThrow('does not match its request')
    }
  })
})
