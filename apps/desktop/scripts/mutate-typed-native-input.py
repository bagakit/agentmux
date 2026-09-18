import hashlib, json, os, re, subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[3]
out = root / 'docs/reviews/evidence/typed-native-input-2026-10-02'
core = root / 'packages/core'
client = root / 'packages/core/src/client.ts'
terminal = root / 'apps/desktop/src/renderer/src/components/TerminalView.tsx'
protocol = root / 'packages/core/src/agent-interaction.ts'
cases = [
    ('pending-blocks-native', client,
     '// The native terminal remains usable while a typed request is pending.',
     "if (session.pendingInteraction) throw new AgentMuxError('Mutant pending block', 'AGENT_INTERACTION_PENDING')\n      // The native terminal remains usable while a typed request is pending.",
     ['test/client-interaction-lifecycle.test.ts', 'test/client-agent-paste.test.ts']),
    ('stale-run-admitted', client,
     'if (!sameRun(session.run, input.expectedRun)) {\n      throw new AgentMuxError(\'Agent Session changed before native input.\'',
     'if (false) {\n      throw new AgentMuxError(\'Agent Session changed before native input.\'',
     ['test/client-interaction-lifecycle.test.ts']),
    ('terminal-blocks-pending', terminal, 'const acceptsInput = true',
     "const acceptsInput = session.kind !== 'agent' || session.pendingInteraction === undefined",
     ['apps/desktop/test/terminal-view-control-observation.test.ts', 'apps/desktop/test/terminal-multiline-paste.test.tsx']),
    ('permission-completion-not-wired', protocol,
     '...(config.permissionCompletionEvents ? { permissionCompletionEvents: config.permissionCompletionEvents } : {}),',
     '// Mutant: permission completion declaration dropped.',
     ['test/native-question-completion.test.ts']),
    ('native-unknown-not-saved-before-bytes', client, "      await observeNativeInput('unknown')", "      // Mutant: uncertainty before bytes dropped.", ['test/client-interaction-lifecycle.test.ts']),
    ('late-native-receipt-rebound', client, 'if (pending?.request.id !== requestId) return current', 'if (!pending) return current', ['test/native-question-completion.test.ts']),
    ('not-applied-keeps-unknown', client, "error.detail === 'not_applied') await observeNativeInput('not_applied')", "error.detail === 'mutant') await observeNativeInput('not_applied')", ['test/client-interaction-lifecycle.test.ts']),
    ('unconfirmed-typed-guard-dropped', client, "if (unavailableReason) throw new AgentMuxError(unavailableReason, 'AGENT_INTERACTION_UNCONFIRMED')", '// Mutant: unconfirmed response guard dropped.', ['test/client-interaction-lifecycle.test.ts']),
    ('new-request-guesses-completion', client, 'if (!previous) next.pendingInteraction = { request: structuredClone(interaction) }', 'if (!previous || previous.request.id !== interaction.id) next.pendingInteraction = { request: structuredClone(interaction) }', ['test/native-question-completion.test.ts']),
    ('native-takeover-claim-replayed', client, 'if (pending.nativeInput || pending.nativeCompleted || pending.additionalRequests?.length) {', 'if (pending.request.id.length < 0) {', ['test/client-interaction-lifecycle.test.ts']),
    ('user-source-fact-ignored', root / 'apps/desktop/src/renderer/src/lib/terminal-reveal.ts', 'source.onUserInput(() => { userInput = true })', 'source.onUserInput(() => { userInput = false })', ['apps/desktop/test/terminal-multiline-paste.test.tsx']),
    ('protocol-reply-labelled-user', root / 'apps/desktop/src/renderer/src/lib/terminal-reveal.ts', "const origin = userInput ? 'user' : 'terminal-protocol'", "const origin = userInput ? 'user' : 'user'", ['apps/desktop/test/terminal-multiline-paste.test.tsx']),
    ('activity-clock-rejects-core', root / 'apps/desktop/src/renderer/src/lib/session-state.ts', 'incoming.updatedAt < session.agentSessionUpdatedAt', 'incoming.updatedAt < session.updatedAt', ['apps/desktop/test/native-question-completion-consumer.test.tsx']),

    ('input-source-guessing', client, "input.source !== 'user' && input.source !== 'terminal-protocol'", "input.source !== input.source", ['test/client-interaction-lifecycle.test.ts']),

]

def run(args, cwd, file):
    with file.open('w') as log:
        return subprocess.run(args, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, timeout=120).returncode

receipt = {'schema': 'agentmux.typed-native-input-mutations.v1', 'passed': False, 'cases': []}
for name, file, before, after, tests in cases:
    original = file.read_bytes()
    source = original.decode()
    assert source.count(before) == 1, (name, source.count(before))
    try:
        file.write_text(source.replace(before, after))
        is_core = file.is_relative_to(core)
        if is_core:
            assert run(['node', 'scripts/build.mjs'], core, out / (name + '-build.log')) == 0
        code = run(['pnpm', 'exec', 'vitest', 'run', *tests, '--maxWorkers=1'],
                   core if is_core else root, out / (name + '-red.log'))
        log = (out / (name + '-red.log')).read_text()
        assert code != 0 and re.search(r'Tests\s+\d+ failed', log) and ' FAIL ' in log, (name, code, log[-800:])
        print(name + ': RED; restoring source', flush=True)
        receipt['cases'].append({'name': name, 'source': str(file.relative_to(root)), 'sourceSha256': hashlib.sha256(original).hexdigest(),
                                  'redExit': code, 'red': name + '-red.log'})
        (out / 'mutations-in-progress.json').write_text(json.dumps(receipt, indent=2) + '\n')
    finally:
        file.write_bytes(original)
        assert file.read_bytes() == original
        if file.is_relative_to(core):
            assert run(['node', 'scripts/build.mjs'], core, out / (name + '-restored-build.log')) == 0

assert run(['node', 'scripts/build.mjs'], core, out / 'restored-build.log') == 0
assert run(['pnpm', 'exec', 'vitest', 'run', 'test/client-interaction-lifecycle.test.ts', 'test/client-agent-paste.test.ts',
            'test/native-question-completion.test.ts', 'test/client-raw-input-render-preemption.test.ts', 'test/agent-interaction.test.ts', 'test/provider-human-request-contract.test.ts', 'test/empty-terminal-input-is-not-a-failure.test.ts', '--maxWorkers=1'],
           core, out / 'restored-core-green.log') == 0
assert run(['pnpm', 'exec', 'vitest', 'run', 'apps/desktop/test/terminal-view-control-observation.test.ts',
            'apps/desktop/test/terminal-multiline-paste.test.tsx', 'apps/desktop/test/agent-pending-interaction-keyboard.test.tsx', 'apps/desktop/test/native-question-completion-consumer.test.tsx', 'apps/desktop/test/renderer-state-owners.test.ts', '--maxWorkers=1'],
           root, out / 'restored-terminal-green.log') == 0
receipt['passed'] = True
(out / 'mutations-in-progress.json').unlink(missing_ok=True)
(out / 'mutations.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({'passed': True, 'mutants': len(cases)}), flush=True)
