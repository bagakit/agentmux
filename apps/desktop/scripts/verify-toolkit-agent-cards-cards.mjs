import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { provePerformanceOwner, sha } from './performance-owner-proof.mjs'

const driverInputPaths = [import.meta.filename, resolve(import.meta.dirname, 'fixtures/toolkit-agent-cards/vitest.config.mts')]
const driverInputsBefore = new Map(driverInputPaths.map(path => [path, sha(readFileSync(path))]))

const customResult = process.env.AGENTMUX_TOOLKIT_AGENT_CARDS_CUSTOM_RESULT
assert.ok(customResult, 'AGENTMUX_TOOLKIT_AGENT_CARDS_CUSTOM_RESULT must name the actual T001 ordinary Custom script confirmed result')
process.env.AGENTMUX_TOOLKIT_AGENT_CARDS_CUSTOM_RESULT = resolve(customResult)
const customBytes = readFileSync(process.env.AGENTMUX_TOOLKIT_AGENT_CARDS_CUSTOM_RESULT)
const custom = JSON.parse(customBytes)
assert.equal(custom.snapshot?.kind, 'script')
assert.equal(custom.snapshot?.latestConfirmed?.state, 'succeeded')
assert.equal(custom.snapshot?.latestConfirmed?.exitCode, 0)
assert.ok(custom.snapshot?.latestConfirmed?.run?.runId)
assert.ok(custom.snapshot?.latestConfirmed?.text?.length > 0)
assert.ok(Number.isSafeInteger(custom.executionProof?.childPid) && custom.executionProof.childPid > 0)
assert.equal(custom.executionProof?.privateChildExited, true)
assert.equal(custom.executionProof?.userRunTouched, false)
assert.equal(custom.executionProof?.outputSHA256, sha(custom.snapshot.latestConfirmed.text))
assert.equal(custom.executionProof?.scriptSHA256, sha(custom.snapshot.latestConfirmed.definition.script))

const avatar = 'apps/desktop/src/renderer/src/components/AgentAvatar.tsx'
const cards = 'apps/desktop/src/renderer/src/components/toolkit/ToolkitAgentCards.tsx'
const facts = 'apps/desktop/src/renderer/src/lib/toolkit-agent-card-facts.ts'
const result = 'apps/desktop/src/renderer/src/components/toolkit/UserToolkitResult.tsx'
const parser = 'packages/core/src/toolkit-result-document.ts'
const test = 'apps/desktop/test/toolkit-agent-cards.test.tsx'
const actualConsumer = 'apps/desktop/scripts/fixtures/toolkit-agent-cards/actual-custom-consumer.proof.tsx'
const proof = provePerformanceOwner({ name: 'toolkit-agent-cards-cards', config: 'apps/desktop/scripts/fixtures/toolkit-agent-cards/vitest.config.mts',
  owners: [avatar, cards, facts, result, parser], tests: [test, actualConsumer, 'apps/desktop/test/agent-avatar-settings.test.tsx', 'apps/desktop/test/agent-avatar-outline.test.tsx', 'apps/desktop/test/toolkit-custom-ui.test.tsx'], minimumTests: 53, mutantTests: [test, actualConsumer],
  mutants: [
    ['custom-card-disconnected', result, '<ToolkitAgentCards cards={document.agentCards} active={active && !scriptOpen} />', 'null'],
    ['custom-core-parser-bypassed', result, 'return parseToolkitResultDocument(JSON.parse(text.trim()))', 'return JSON.parse(text.trim())'],
    ['malformed-raw-output-lost', result, 'text={execution.text}', "text={''}"],
    ['session-host-lost', facts, "JSON.stringify(['session', reference.hostId, reference.sessionId])", "JSON.stringify(['session', reference.sessionId])"],
    ['run-host-lost', facts, "JSON.stringify(['run', reference.hostId, reference.runId])", "JSON.stringify(['run', reference.runId])"],
    ['canonical-session-id-replaced', facts, 'sessionId: session.control.agentSessionId }))', 'sessionId: session.id }))'],
    ['current-run-id-replaced', facts, 'runId: session.control.run.runId })]', 'runId: session.id })]'],
    ['ambiguous-first-wins', facts, 'if (candidates.length !== 1)', 'if (false)'],
    ['terminal-claimed-agent', facts, "if (session.kind !== 'agent' || session.control.kind !== 'agent')", 'if (false)'],
    ['hidden-demand-removed', facts, 'if (!active || !selected.size || !wanted.size)', 'if (!selected.size || !wanted.size)'],
    ['metrics-only-demand-removed', facts, 'if (!active || !selected.size || !wanted.size)', 'if (!active || !wanted.size)'],
    ['session-index-stale', facts, 'if (sessions !== indexed)', 'if (!indexed)'],
    ['unrelated-update-map-instability', facts, 'if (changed) previous = next', 'previous = next'],
    ['per-card-store-fanout', cards, "import { ResolvedAgentAvatar } from '../AgentAvatar'", "import { AgentAvatar as ResolvedAgentAvatar } from '../AgentAvatar'"],
    ['configured-name-field-ignored', cards, "{shown.has('name') ?", '{true ?'],
    ['metric-update-memoized-away', cards, 'metric.value === next.card.metrics[index]!.value', 'true'],
    ['duplicate-reference-key', cards, 'key={JSON.stringify([toolkitAgentCardKey(card.reference), index])}', 'key={toolkitAgentCardKey(card.reference)}'],
    ['resolved-face-status-lost', avatar, 'displayState={state} avatar={appearance}', 'displayState={undefined} avatar={appearance}']
  ], callers: [
    [result, 'parseToolkitResultDocument(JSON.parse(text.trim()))'], [result, '<ToolkitAgentCards cards={document.agentCards}'],
    [cards, 'const facts = useToolkitAgentCards(cards.items, cards.fields, active)'], [cards, 'createToolkitAgentCardSelector('],
    [cards, '<ResolvedAgentAvatar'], [avatar, '<AgentAvatarFace provider={providerId}'],
    ['apps/desktop/src/renderer/src/components/toolkit/ToolkitStatusBar.tsx', '<UserToolkitResult'],
    ['apps/desktop/src/renderer/src/components/performance/PerformanceOverview.tsx', '<ToolkitAgentCard card={card}']
  ] })
const driverInputs = driverInputPaths.map(path => ({ path, beforeSHA256: driverInputsBefore.get(path), afterSHA256: sha(readFileSync(path)) }))
for (const input of driverInputs) assert.equal(input.afterSHA256, input.beforeSHA256, `driver input changed during proof: ${input.path}`)
assert.equal(proof.receipt.verifierSHA256, driverInputsBefore.get(import.meta.filename), 'run this scope directly so the helper also binds the actual driver')
proof.receipt.driverInputs = driverInputs
writeFileSync(join(proof.directory, 'receipt.json'), JSON.stringify(proof.receipt, null, 2) + '\n')
assert.equal(sha(readFileSync(process.env.AGENTMUX_TOOLKIT_AGENT_CARDS_CUSTOM_RESULT)), sha(customBytes), 'actual Custom artifact changed during consumer proof')
writeFileSync(join(proof.directory, 'custom-consumer-receipt.json'), JSON.stringify({ passed: true,
  actualExecutionArtifact: process.env.AGENTMUX_TOOLKIT_AGENT_CARDS_CUSTOM_RESULT, artifactSHA256: sha(customBytes),
  textSHA256: sha(custom.snapshot.latestConfirmed.text), textBytes: Buffer.byteLength(custom.snapshot.latestConfirmed.text),
  executionId: custom.snapshot.latestConfirmed.executionId, run: custom.snapshot.latestConfirmed.run,
  actualMountedConsumer: actualConsumer, sourceAndMutationReceipt: join(proof.directory, 'receipt.json'), driverInputs,
  boundary: 'Reuses the T001 real private Node child and CustomToolkitOwner/public CLI confirmed result; this consumer proof starts no Run, input, native Runtime or user App.' }, null, 2) + '\n')
