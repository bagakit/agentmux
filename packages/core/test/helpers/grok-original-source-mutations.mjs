import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const status = 'packages/core/src/providers/grok-session-status.ts', source = 'packages/core/src/providers/grok-native-source.ts'
export const mutations = {
  'omit-live-locator': [status, [['await grokProcessSource(context, signal)', 'undefined']], '^the exact private OS Run'],
  'omit-native-prompt-binding': [status, [['submittedTurn ?? meta?.promptId', 'meta?.promptId']], '^the original prompt-submit'],
  'keep-idle-at-prompt-marker': [status, [['unknown(update.prompt_id ?? previousTurn)', 'void 0']], '^a pending native prompt marker'],
  'ignore-prompt-counter-gap': [status, [['sequence === pending.sequence + 1', 'true']], '^counter-gap'],
  'ignore-prompt-physical-gap': [status, [['pending.end === entry.start', 'true']], '^physical-gap'],
  'permit-blocked-prompt': [status, [['allowed: valid && meta?.isReplay', 'allowed: true && meta?.isReplay']], '^blocked'],
  'lose-multiblock-marker': [status, [['while (before) {', 'while (false && before) {']], '^finite and cold watch bind'],
  'lose-explicit-multiblock': [status, [['if (!countedRun && !explicitRun)', 'if (!countedRun)']], '^a fresh explicit native ID.*legacy-explicit'],
  'forget-preceding-turn': [status, [['scan.retainPrevious(previous.previous())', 'void 0']], '^finite and restarted watch cannot revive'],
  'index-zero-forgets-predecessor': [status, [['if (user) {', "if (user && object(user.value.params) && object(user.value.params.update) && object(user.value.params.update._meta) && Number(user.value.params.update._meta.promptIndex) > 0) {"]], '^the zero-index shortcut'],
  'explicit-id-revives-idle': [status, [['if (!continuation && turn === previousTurn)', 'if (false)']], '^the explicit shortcut'],
  'accept-read-only-source': [source, [["file.access === 'w' || file.access === 'u'", 'true']], '^a read-only OS descriptor'],
  'accept-foreign-native': [source, [['row.session_id !== handle.sessionId || ', '']], '^an original OS descriptor cannot borrow a wrong native'],
  'accept-child-source': [source, [["row.session_relationship !== 'primary' || ", '']], '^an original OS descriptor cannot borrow a wrong child'],
  'accept-foreign-cwd': ['packages/core/src/providers/grok-native-history.ts', [['if (!cwd || cwd !== context.workspacePath)', 'if (false)']], '^an original OS descriptor cannot borrow a wrong cwd'],
  'ignore-summary-rewrite': ['packages/core/src/providers/grok-native-history.ts', [['if (before) {', 'if (before && false) {']], '^a summary rewritten'],
  'ignore-original-birth': [source, [['if (await nativeProcessBirth(processId, active) !== birth || await nativeProcessBirth(original.processId, active) !== writerBirth) throw unavailable()', '', 2]], '^the original process birth'],
  'block-on-replaced-fifo': [source, [[' | constants.O_NONBLOCK', '']], '^a FIFO replacing'],
  'accept-replaced-updates': [status, [['BigInt(actual.dev) !== original.stat.dev || BigInt(actual.ino) !== original.stat.ino', 'false']], '^an updates replacement'],
  'accept-incomplete-terminal': [status, [['return ((await reader.readBeforeChanges())?.end ?? 0) === reader.sourceSizeBytes', 'return true']], '^an unterminated but valid JSON terminal'],
  'use-stale-path-extent': [status, [['if (reader.sourceSizeBytes !== extent)', 'if (reader.sourceSizeBytes !== Number(original.stat.size))']], '^a complete native append.*finite'],
  'emit-before-cut-completes': [status, [['consumed = entry.end; turns.accept(entry)', 'consumed = entry.end; turns.accept(entry); const premature = turns.observation(); if (premature) emit(premature)']], '^a whole native cut']
}
const owners = new Set([status, source, 'packages/core/src/providers/grok-native-history.ts', 'packages/core/src/providers/grok.ts',
  'packages/core/src/native-jsonl-history-reader.ts', 'packages/core/src/client.ts', 'packages/core/src/public-rpc-service.ts',
  'apps/host/src/goal-runtime.ts', 'apps/host/src/continuous-progress-loop-manager.ts', 'apps/host/src/continuous-progress-delivery.ts'])
export function instrument(code, file) {
  if (!owners.has(file)) return code
  const selected = process.env.MOTE_GROK_ORIGINAL_MUTATION, mutation = mutations[selected]
  if (selected && !mutation) throw Error('Unknown original-source mutation ' + selected)
  let output = code, edits = 0
  if (mutation?.[0] === file) for (const [before, after, count = 1] of mutation[1]) {
    if (output.split(before).length !== count + 1) throw Error('Exact current production anchors required: ' + selected)
    output = output.replaceAll(before, after); edits += count
  }
  if (process.env.MOTE_GROK_ORIGINAL_LOADED) {
    const sha = value => createHash('sha256').update(value).digest('hex')
    appendFileSync(process.env.MOTE_GROK_ORIGINAL_LOADED, JSON.stringify({ file, originalSHA256: sha(code), loadedSHA256: sha(output), mutation: edits ? selected : null, edits }) + '\n')
  }
  return output
}
