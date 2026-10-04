import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function verifyMotePersonaTask(task) {
  const base = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
  const output = join(base, '.tmp/mote-companion-' + task); await mkdir(output, { recursive: true })
  const attempt = await mkdtemp(join(output, 'attempt-')), isolated = join(attempt, 'source')
  const cooperation = task === 'cooperation', ideas = task === 'ideas'
  const tests = cooperation ? ['test/mote-cooperation.test.tsx', 'test/mote-behavior.test.ts'] : ideas ? ['test/mote-ideas.test.tsx', 'test/mote-default-knowledge.test.ts'] : ['test/mote-materials-inspection.test.tsx', 'test/mote-materials-public-read.test.ts']
  const variants = cooperation ? [
    { id: 'new-launcher-draft', path: 'apps/desktop/src/renderer/src/lib/mote-materials-actions.ts', from: 'current.setAgentComposerDraft(region.regionId, prompt)', to: 'current.setAgentComposerDraft(region.regionId, "")' },
    { id: 'later-launcher-input', path: 'apps/desktop/src/renderer/src/lib/mote-materials-actions.ts', from: 'if ((current.agentComposerDrafts[region.regionId] ?? \'\') !== \'\')', to: 'if (false)' },
    { id: 'launcher-resource-fence', path: 'apps/desktop/src/renderer/src/lib/mote-materials-actions.ts', from: "region?.kind !== 'launcher' || region.workspaceId !== owner.workspace.id ||", to: "region?.kind !== 'launcher' ||" },
    { id: 'preserve-group-inputs', path: 'apps/desktop/src/renderer/src/lib/mote-materials-actions.ts', from: 'tabGroupId: destination.groupId, zoneId, reveal: true })', to: 'tabGroupId: destination.groupId, zoneId, reveal: true, initialInputs: { prompt: "Retained Group unsent", names: { agentName: "", tabName: "" }, optionsByProvider: {} } })' },
    { id: 'preserve-original-soul', path: 'apps/desktop/src/renderer/src/lib/mote-behavior.ts', from: 'return content + (content.endsWith', to: 'return "" + (content.endsWith' },
    { id: 'explicit-four-axis-code', path: 'apps/desktop/src/renderer/src/lib/mote-behavior.ts', from: "MOTE_BEHAVIOR_AXES.map(axis => draft[axis.id]).join('')", to: "MOTE_BEHAVIOR_AXES.map(axis => draft[axis.id]).reverse().join('')" },
    { id: 'strict-owned-block', path: 'apps/desktop/src/renderer/src/lib/mote-behavior.ts', from: 'if (serializeMoteBehaviorBlock(preferences) !== block)', to: 'if (false)' },
    { id: 'confirmed-empty-group-rejected', path: 'apps/desktop/src/renderer/src/lib/mote-cooperation.ts', from: '?? emptyMoteDestination(state, scope, { reference })', to: '?? null' },
    { id: 'saved-unknown-borrows-empty', path: 'apps/desktop/src/renderer/src/lib/mote-materials-actions.ts', from: 'if (choice?.tabId || choice?.regionId) return null', to: 'if (false) return null' },
    { id: 'recent-ideas-action-does-nothing', path: 'apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx', from: 'label="View ideas and saved materials" onClick={onShowIdeas}', to: 'label="View ideas and saved materials" onClick={() => {}}' },
    { id: 'initial-later-form', path: 'apps/desktop/src/renderer/src/components/MoteBehaviorDialog.tsx', from: 'else if (!edited.current)', to: 'else if (true)' },
    { id: 'original-read-lifetime', path: 'apps/desktop/src/renderer/src/components/MoteBehaviorDialog.tsx', from: 'if (lifetime.current !== epoch) return\n      if (changed)', to: 'if (false) return\n      if (changed)' },
    { id: 'review-later-form', path: 'apps/desktop/src/renderer/src/components/MoteBehaviorDialog.tsx', from: 'lifetime.current === epoch && form.current === submitted', to: 'lifetime.current === epoch' },
    { id: 'review-later-trial-input', path: 'apps/desktop/src/renderer/src/components/MoteBehaviorDialog.tsx', from: ' && trialInput.current === submittedTrial', to: '' },
    { id: 'review-navigation-epoch', path: 'apps/desktop/src/renderer/src/lib/mote-cooperation.ts', from: "if (changed || !stillCurrent() || result.status !== 'read'", to: "if (false || !stillCurrent() || result.status !== 'read'" },
    { id: 'unknown-save-label', path: 'apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx', from: '!loading && !issue && !documentIssue &&', to: '!loading && !issue &&' },
    { id: 'later-original-document', path: 'apps/desktop/src/renderer/src/lib/mote-cooperation.ts', from: 'before && (current?.content !== before.content || current.revision !== before.revision)', to: 'false' }
  ] : ideas ? [
    { id: 'idea-source-revision', path: 'apps/desktop/src/renderer/src/lib/mote-idea-request.ts', from: 'revision: document.revision, excerpt:', to: 'revision: "lost-revision", excerpt:' },
    { id: 'idea-goal-association', path: 'apps/desktop/src/renderer/src/lib/mote-idea-request.ts', from: 'goal.sessionIds.includes(session.id)', to: 'goal.sessionIds.includes(session.control.agentSessionId)' },
    { id: 'idea-navigation-epoch', path: 'apps/desktop/src/renderer/src/lib/mote-idea-request.ts', from: 'if (fileNavigationSelection(current) !== navigation) changed = true', to: 'if (false) changed = true' },
    { id: 'idea-later-direction', path: 'apps/desktop/src/renderer/src/components/MoteIdeaControls.tsx', from: 'prepareMoteIdeaDraft(scope, reference, input, material, () => alive.current && current.current.input === capturedInput &&', to: 'prepareMoteIdeaDraft(scope, reference, input, material, () => alive.current &&' },
    { id: 'idea-feedback-revision', path: 'apps/desktop/src/renderer/src/lib/mote-idea-request.ts', from: "'Saved file revision: ' + material.revision", to: "'Saved file revision: unconfirmed'" },
    { id: 'existing-mote-role-consumer', path: 'apps/desktop/src/main/scratch-topics.ts', from: '...(snapshot.soul ? [MOTE_COORDINATION_ROLE] : [])', to: '...[]' }
  ] : [
    { id: 'public-body-read', path: 'apps/desktop/src/renderer/src/lib/mote-cooperation.ts', from: 'path: path.slice(scope.rootPath.length + 1)', to: 'path: "wrong-material.md"' },
    { id: 'late-read-epoch', path: 'apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx', from: 'return () => { current = false }', to: 'return () => {}' },
    { id: 'exact-file-resource', path: 'apps/desktop/src/main/file-read-owner.ts', from: 'workspace.path !== expected.workspacePath', to: 'false' },
    { id: 'full-file-revision', path: 'packages/core/src/public-rpc-files.ts', from: "revision(d.revision, code)", to: "string(d.revision, code)" },
    { id: 'public-files-owner-route', path: 'packages/core/src/public-rpc-service.ts', from: "await this.ports.files.read(input)", to: "({resource:null,result:{status:'unknown',code:'MUTATED_OWNER',message:'Original owner omitted'}})" }
  ]
  const callerChecks = cooperation ? [
    { symbol: 'openMoteDiscussionDraft', definition: 'apps/desktop/src/renderer/src/lib/mote-materials-actions.ts', caller: 'apps/desktop/src/renderer/src/components/MoteBehaviorDialog.tsx', anchor: 'if (openMoteDiscussionDraft(scope, question' },
    { symbol: 'stageMoteBehaviorPreferences', definition: 'apps/desktop/src/renderer/src/lib/mote-cooperation.ts', caller: 'apps/desktop/src/renderer/src/components/MoteBehaviorDialog.tsx', anchor: 'await stageMoteBehaviorPreferences(' },
    { symbol: 'MoteBehaviorDialog', definition: 'apps/desktop/src/renderer/src/components/MoteBehaviorDialog.tsx', caller: 'apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx', anchor: '<MoteBehaviorDialog ' },
    { symbol: 'deriveMoteBehaviorCode', definition: 'apps/desktop/src/renderer/src/lib/mote-behavior.ts', caller: 'apps/desktop/src/renderer/src/components/MoteBehaviorDialog.tsx', anchor: 'code = deriveMoteBehaviorCode(draft)' },
    { symbol: 'parseMoteBehaviorBlock', definition: 'apps/desktop/src/renderer/src/lib/mote-behavior.ts', caller: 'apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx', anchor: 'saved ? parseMoteBehaviorBlock(saved.content)' },
    { symbol: 'replaceMoteBehaviorBlock', definition: 'apps/desktop/src/renderer/src/lib/mote-behavior.ts', caller: 'apps/desktop/src/renderer/src/lib/mote-cooperation.ts', anchor: 'return replaceMoteBehaviorBlock(' },
    { symbol: 'stageMoteSoulAddition', definition: 'apps/desktop/src/renderer/src/lib/mote-cooperation.ts', caller: 'apps/desktop/src/renderer/src/lib/mote-idea-request.ts', anchor: 'return stageMoteSoulAddition(' }
  ] : ideas ? [
    { symbol: 'prepareMoteIdeaDraft', definition: 'apps/desktop/src/renderer/src/lib/mote-idea-request.ts', caller: 'apps/desktop/src/renderer/src/components/MoteIdeaControls.tsx', anchor: 'finish(prepareMoteIdeaDraft(' },
    { symbol: 'stageMoteIdeaFeedback', definition: 'apps/desktop/src/renderer/src/lib/mote-idea-request.ts', caller: 'apps/desktop/src/renderer/src/components/MoteIdeaControls.tsx', anchor: 'finish(stageMoteIdeaFeedback(' },
    { symbol: 'MoteIdeaControls', definition: 'apps/desktop/src/renderer/src/components/MoteIdeaControls.tsx', caller: 'apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx', anchor: '<MoteIdeaControls ' },
    { symbol: 'MOTE_COORDINATION_ROLE', definition: 'apps/desktop/src/shared/scratch-topics.ts', caller: 'apps/desktop/src/main/scratch-topics.ts', anchor: '...(snapshot.soul ? [MOTE_COORDINATION_ROLE] : [])' },
    { symbol: 'setMoteIdeaDraft', definition: 'apps/desktop/src/renderer/src/lib/launcher-state.ts', caller: 'apps/desktop/src/renderer/src/components/MoteIdeaControls.tsx', anchor: 'useLauncherState.getState().setMoteIdeaDraft(' }
  ] : [
    { symbol: 'readMoteMaterial', definition: 'apps/desktop/src/renderer/src/lib/mote-cooperation.ts', caller: 'apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx', anchor: 'void readMoteMaterial(scope, selected)' },
    { symbol: 'FileReadOwner', definition: 'apps/desktop/src/main/file-read-owner.ts', caller: 'apps/desktop/src/main/ipc.ts', anchor: 'new FileReadOwner(' },
    { symbol: 'file.read', definition: 'packages/core/src/public-rpc-files.ts', caller: 'packages/core/src/public-rpc-service.ts', anchor: 'await this.ports.files.read(input)' },
    { symbol: 'parseFileReadCommand', definition: 'packages/core/src/agentmux-cli-files.ts', caller: 'packages/core/src/agentmux-cli-commands.ts', anchor: 'parseFileReadCommand(' }
  ]
  const config = 'apps/desktop/scripts/fixtures/mote-companion-workflows/vitest.persona.config.mts'
  const files = [...new Set([...variants.map(item => item.path), ...callerChecks.flatMap(item => [item.definition, item.caller]), ...tests.map(path => 'apps/desktop/' + path), config,
    ...(cooperation ? ['apps/desktop/src/renderer/src/styles/mote-workface.css', 'apps/desktop/scripts/verify-mote-persona-task.mjs', 'apps/desktop/scripts/verify-mote-cooperation.mjs',
      'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts',
      'apps/desktop/src/renderer/src/lib/launcher-state.ts', 'apps/desktop/src/renderer/src/lib/workbench-persistence.ts',
      'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/shared/space-addresses.ts', 'packages/core/src/toolkit.ts',
      'packages/core/src/control.ts', 'packages/core/src/spatial-state.ts', 'packages/core/src/spatial-graph.ts'] : [])])]
  const original = Object.fromEntries(await Promise.all(files.map(async path => [path, await readFile(join(base, path))])))
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const receipt = { schema: 'agentmux.mote-companion-persona-verification.v1', task, passed: false, source: Object.fromEntries(Object.entries(original).map(([path, bytes]) => [path, digest(bytes)])), runs: [], callers: [], failure: null,
    boundary: 'Current Source original App/Store/Files/public service/client/actual CLI; isolated filesystem and transport, no live user Run, Native or installed package qualification.' }
  const run = async (label, expected) => {
    const child = spawn(process.execPath, [join(base, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(isolated, config), ...tests, '--maxWorkers=1'],
      { cwd: isolated, env: { ...process.env, TMPDIR: _hygiene_fixturePath("tmp") }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const status = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })) })
    await writeFile(join(attempt, label + '.log'), stdout + stderr)
    const text = stdout + stderr, count = cooperation ? 19 : ideas ? 10 : 7
    const collected = new RegExp('Tests\\s+(?:' + count + ' (?:passed|failed)|\\d+ failed \\| \\d+ passed \\(' + count + '\\))').test(text)
    const assertion = /AssertionError:|expected .* to /.test(text)
    receipt.runs.push({ label, expected, ...status, collected, assertion })
    assert.equal(status.signal, null, 'A process termination is not behavioral proof'); assert.ok(collected, 'The complete nonempty owning tests were not collected')
    if (expected === 'GREEN') assert.equal(status.code, 0, text)
    else { assert.notEqual(status.code, 0, 'The product mutant stayed green'); assert.ok(assertion, 'A load/setup failure cannot qualify as assertion RED') }
    console.log(label + ': ' + expected)
  }
  try {
    await mkdir(isolated); await mkdir(join(isolated, 'packages'))
    await cp(join(base, 'apps/desktop/src'), join(isolated, 'apps/desktop/src'), { recursive: true })
    await symlink(join(base, 'apps/desktop/resources'), join(isolated, 'apps/desktop/resources'))
    await cp(join(base, 'apps/desktop/test/fixtures'), join(isolated, 'apps/desktop/test/fixtures'), { recursive: true })
    await cp(join(base, 'apps/desktop/test/helpers'), join(isolated, 'apps/desktop/test/helpers'), { recursive: true })
    await cp(join(base, 'packages/core/src'), join(isolated, 'packages/core/src'), { recursive: true })
    await cp(join(base, 'packages/core/package.json'), join(isolated, 'packages/core/package.json'))
    for (const name of ['demand', 'layout', 'client-ui']) await symlink(join(base, 'packages', name), join(isolated, 'packages', name))
    for (const path of [...tests.map(path => 'apps/desktop/' + path), config, 'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts', 'vitest.setup.ts', 'tsconfig.base.json', 'apps/desktop/tsconfig.json']) {
      await mkdir(dirname(join(isolated, path)), { recursive: true }); await cp(join(base, path), join(isolated, path))
    }
    await symlink(join(base, 'node_modules'), join(isolated, 'node_modules')); await symlink(join(base, 'packages/core/node_modules'), join(isolated, 'packages/core/node_modules'))
    await symlink(join(base, 'apps/desktop/node_modules'), join(isolated, 'apps/desktop/node_modules')); await writeFile(join(isolated, 'package.json'), '{"type":"module"}')
    for (const check of callerChecks) {
      assert.notEqual(check.definition, check.caller); assert.ok(!/\/test\/|\.test\./u.test(check.caller), 'A test cannot be a production caller')
      const lines = original[check.caller].toString().split('\n'), line = lines.findIndex(line => line.includes(check.anchor) && !line.trim().startsWith('import '))
      assert.ok(line >= 0, check.symbol + ' has no definition-external production caller'); receipt.callers.push({ ...check, line: line + 1 })
    }
    assert.ok(receipt.callers.length > 0); await run('baseline', 'GREEN')
    for (const variant of variants) {
      const source = original[variant.path].toString(); assert.equal(source.split(variant.from).length, 2, 'Mutation needs one exact implementation anchor')
      await writeFile(join(isolated, variant.path), source.replace(variant.from, variant.to))
      try { await run(variant.id + '-red', 'RED') } finally { await writeFile(join(isolated, variant.path), original[variant.path]) }
      await run(variant.id + '-restored', 'GREEN')
    }
    receipt.passed = true
  } catch (error) { receipt.failure = error.stack; process.exitCode = 1 }
  finally {
    receipt.sourceChanges = []
    for (const [path, bytes] of Object.entries(original)) {
      const current = digest(await readFile(join(base, path)))
      if (current !== digest(bytes)) receipt.sourceChanges.push({ path, before: digest(bytes), after: current })
    }
    if (receipt.sourceChanges.length) {
      receipt.passed = false; receipt.failure = 'Candidate Source changed during isolated verification; these results do not qualify the current candidate.'; process.exitCode = 1
    }
    await rm(isolated, { recursive: true, force: true }); receipt.cleanup = { privateSourceRemoved: true, writesRestrictedToPrivateSource: true }
    await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); await writeFile(join(output, 'last.json'), JSON.stringify({ receipt: join(attempt, 'receipt.json') }) + '\n')
    console.log(JSON.stringify({ passed: receipt.passed, task, runs: receipt.runs.length, callers: receipt.callers.length, receipt: join(attempt, 'receipt.json') }))
  }
}
