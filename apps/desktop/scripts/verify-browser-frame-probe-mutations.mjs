// Source-only proof. Private copies are never placed in a test-scanned archive.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const tests = ['apps/desktop/test/browser-frame-probe-scenario.test.ts', 'apps/desktop/test/browser-ref-resolve.test.ts']
const sources = ['apps/desktop/scripts/browser-frame-probe-scenario.mjs', 'apps/desktop/src/main/browser-selection.ts', 'apps/desktop/src/main/browser-ref-resolve.ts',
  'apps/desktop/src/main/browser-page-snapshot.ts', 'apps/desktop/src/main/browser-frame-documents.ts',
  'apps/desktop/src/main/browser-snapshot-query.ts', 'apps/desktop/src/shared/browser-snapshot-query.ts',
  'apps/desktop/scripts/verify-browser-frame-probe-mutations.mjs']
const mutations = [
  {
    "label": "public-receipt-bare-body-adapter",
    "file": "apps/desktop/scripts/browser-frame-probe-scenario.mjs",
    "edits": [
      {
        "before": "const report = receipt.result",
        "after": "const report = receipt.result?.runOperation ? receipt.result : receipt"
      }
    ]
  },
  {
    "label": "original-operation-identity-unchecked",
    "file": "apps/desktop/scripts/browser-frame-probe-scenario.mjs",
    "edits": [
      {
        "before": "assert.equal(report.runOperation.id, operationId);",
        "after": ""
      }
    ]
  },
  {
    "label": "original-browser-identity-unchecked",
    "file": "apps/desktop/scripts/browser-frame-probe-scenario.mjs",
    "edits": [
      {
        "before": "assert.equal(report.runOperation.browserId, ctx.browserId)",
        "after": ""
      }
    ]
  },
  {
    "label": "empty-public-trace-accepted",
    "file": "apps/desktop/scripts/browser-frame-probe-scenario.mjs",
    "edits": [
      {
        "before": "assert.ok(report.runOperation.steps.length > 0)",
        "after": ""
      }
    ]
  },
  {
    "label": "entire-observation-block-empty",
    "file": "apps/desktop/scripts/browser-frame-probe-scenario.mjs",
    "edits": [
      {
        "before": "  const { tree, snapshot, contexts, nativeDocuments } = value\n  const frames = nativeFrames(tree), names = frames.map(frame => fixtureName(frame.url))\n  for (const name of ['main', 'child', 'nested']) assert.equal(names.filter(item => item === name).length, 1)\n  assert.ok(names.length >= 3 && names.length <= 5)\n  assert.deepEqual(nativeDocuments.map(document => document.document).sort(), [...frameDocuments].sort())\n  const root = tree.frameTree.frame, targets = snapshot.nodes.filter(node => node.role === 'button' && node.name === actionName)\n  assert.equal(snapshot.url, pageUrl); assert.ok(snapshot.navigationId)\n  assert.equal(targets.length, 5, 'All five actual documents need a nonempty same-named target')\n  assert.equal(new Set(targets.map(node => node.ref)).size, 5)\n  assert.equal(new Set(targets.map(node => node.frameId)).size, 5, 'Documents cannot collapse into their shared CDP sender')\n  assert.deepEqual(snapshot.missingFrames, [])\n  assert.deepEqual(snapshot.observation.omittedFrames, [])\n  assert.equal(snapshot.observation.truncated, false)\n  assert.equal(snapshot.observation.returned, snapshot.nodes.length)\n  assert.equal(snapshot.observation.work.axTrees, 5)\n  assert.ok(snapshot.observation.work.axNodes >= targets.length && snapshot.observation.work.cdpCommands > 0)\n  assert.equal(contexts.length, 5)\n  const joined = contexts.map(context => {\n    const node = targets.find(target => target.ref === context.ref), frame = frames.find(frame => frame.id === node?.frameId)\n    const document = context.selection.attributes.id?.replace(/^frame-action-/, ''), native = nativeDocuments.find(item => item.document === document)\n    assert.ok(node && native, 'The issued ref must reach an independently observed Native document')\n    const nativeUrl = new URL(native.url)\n    nativeUrl.username = ''; nativeUrl.password = ''; nativeUrl.search = ''; nativeUrl.hash = ''\n    assert.equal(new URL(context.selection.pageUrl).href, nativeUrl.href)\n    assert.equal(fixtureName(context.selection.pageUrl), document)\n    if (frame) assert.equal(fixtureName(frame.url), document)\n    assert.equal(context.selection.tagName.toLowerCase(), 'button')\n    assert.equal(context.selection.accessibleName, actionName)\n    if (['main', 'child', 'nested'].includes(document)) {\n      assert.ok(frame, 'Same-process refs must join the actual main CDP frame tree')\n      assert.equal(node.sessionId, undefined)\n      assert.equal(native.processId, nativeDocuments.find(item => item.document === 'main').processId)\n      if (document === 'main') assert.equal(frame.id, root.id)\n    } else {\n      assert.ok(typeof node.sessionId === 'string' && node.sessionId.length > 0, 'Cross-site documents need their actual OOPIF sender')\n      assert.notEqual(native.processId, nativeDocuments.find(item => item.document === 'main').processId)\n    }\n    return { document, frameId: node.frameId, ref: node.ref, backendNodeId: node.backendNodeId, sessionId: node.sessionId,\n      nativeFrameTreeNodeId: native.frameTreeNodeId, independentlyJoinedMainCdpTree: Boolean(frame) }\n  })\n  assert.deepEqual(joined.map(item => item.document).sort(), [...frameDocuments].sort())\n  assert.equal(joined.find(item => item.document === 'remote').sessionId, joined.find(item => item.document === 'remote-child').sessionId)\n  return joined",
        "after": "  return []"
      }
    ]
  },
  {
    "label": "document-id-collapsed-to-sender",
    "file": "apps/desktop/scripts/browser-frame-probe-scenario.mjs",
    "edits": [
      {
        "before": "document, frameId: node.frameId, ref: node.ref",
        "after": "document, frameId: node.sessionId ?? root.id, ref: node.ref"
      }
    ]
  },
  {
    "label": "remote-sender-ownership-block-removed",
    "file": "apps/desktop/scripts/browser-frame-probe-scenario.mjs",
    "edits": [
      {
        "before": "assert.ok(typeof node.sessionId === 'string' && node.sessionId.length > 0, 'Cross-site documents need their actual OOPIF sender')",
        "after": ""
      },
      {
        "before": "assert.equal(joined.find(item => item.document === 'remote').sessionId, joined.find(item => item.document === 'remote-child').sessionId)",
        "after": ""
      }
    ]
  },
  {
    "label": "scoped-document-ownership-block-removed",
    "file": "apps/desktop/scripts/browser-frame-probe-scenario.mjs",
    "edits": [
      {
        "before": "assert.deepEqual([...new Set(snapshot.nodes.map(node => node.frameId))], [target.frameId])",
        "after": ""
      },
      {
        "before": "assert.equal(snapshot.observation.scope.document, target.frameId)",
        "after": ""
      }
    ]
  },
  {
    "label": "scope-omissions-hidden",
    "file": "apps/desktop/scripts/browser-frame-probe-scenario.mjs",
    "edits": [
      {
        "before": "assert.deepEqual([...snapshot.observation.omittedFrames].sort(), joined.filter(item => item.document !== document).map(item => item.frameId).sort())",
        "after": ""
      }
    ]
  },
  {
    "label": "actual-ax-cost-hidden",
    "file": "apps/desktop/scripts/browser-frame-probe-scenario.mjs",
    "edits": [
      {
        "before": "assert.equal(snapshot.observation.work.axTrees, 5, 'Output scope does not claim less underlying document work')",
        "after": ""
      }
    ]
  },
  {
    "label": "missing-read-presented-as-complete",
    "file": "apps/desktop/scripts/browser-frame-probe-scenario.mjs",
    "edits": [
      {
        "before": "assert.deepEqual(snapshot.missingFrames, [])",
        "after": "",
        "occurrence": 0
      }
    ]
  },
  {
    "label": "output-truncation-presented-as-complete",
    "file": "apps/desktop/scripts/browser-frame-probe-scenario.mjs",
    "edits": [
      {
        "before": "assert.equal(snapshot.observation.truncated, false)",
        "after": ""
      }
    ]
  },
  {
    "label": "caught-ref-failure-trace-unchecked",
    "file": "apps/desktop/scripts/browser-frame-probe-scenario.mjs",
    "edits": [
      {
        "before": "assert.equal(report.runOperation.steps.filter(step => step.method === 'click' && step.status === 'failed').length, 1)",
        "after": "",
        "occurrence": 1
      }
    ]
  },
  {
    "label": "ordinary-lossy-notice-hidden",
    "file": "apps/desktop/scripts/browser-frame-probe-scenario.mjs",
    "edits": [
      {
        "before": "assert.match(report.runOperation.warning, /by appearance, not identity/)",
        "after": ""
      }
    ]
  },
  {
    "label": "ordinary-recovery-actions-accepted",
    "file": "apps/desktop/scripts/browser-frame-probe-scenario.mjs",
    "edits": [
      {
        "before": "assert.deepEqual(report.runOperation.steps.map(step => [step.method, step.status]), [['elementContext', 'completed']])",
        "after": ""
      }
    ]
  },
  {
    "label": "same-run-withinref-replaced-by-css",
    "file": "apps/desktop/scripts/browser-frame-probe-scenario.mjs",
    "edits": [
      {
        "before": "snapshot({withinRef:child.ref,interactiveOnly:true,maxNodes:120})",
        "after": "snapshot({within:'#frame-main-zone',interactiveOnly:true,maxNodes:120})"
      }
    ]
  },
  {
    "label": "child-navigation-not-awaited",
    "file": "apps/desktop/scripts/browser-frame-probe-scenario.mjs",
    "edits": [
      {
        "before": ";await js(${quoted(navigate)});await click(child.ref);",
        "after": ";void js(${quoted(navigate)});await click(child.ref);"
      }
    ]
  },
  {
    "label": "actual-ref-session-route-disconnected",
    "file": "apps/desktop/src/main/browser-ref-resolve.ts",
    "edits": [
      {
        "before": "const send = node.sessionId ? input.frames?.get(node.sessionId) : input.send",
        "after": "const send = input.send"
      }
    ]
  }
]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = [...new Set([...tests, ...sources])]
const original = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))])))
const hashes = values => Object.fromEntries([...values].map(([file, bytes]) => [file, digest(bytes)]))
const copy = await mkdtemp('/tmp/agentmux-frame-probe-source-')
const evidence = await mkdtemp(join(root, '.tmp/browser-frame-probe-source-'))
const receipt = { schema: 'agentmux.browser-frame-probe-source-mutations.v1', passed: false,
  sourceBefore: hashes(original), boundary: 'Native scenario oracles/generated programs and thin SuccessReceipt consumer with fake facts; actual production ref/snapshot modules with fake CDP. No Native, live socket, application restart or installed artifact.',
  sharedTreeMutations: 0, runtimeControl: [], cases: [] }
const run = async label => {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', ...tests, '--config', join(copy, 'vitest.mutation.config.mts'), '--maxWorkers=1'],
      { cwd: copy, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 30_000)
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, timedOut, output }) })
  })
  await writeFile(join(evidence, `${label}.log`), result.output)
  return { ...result, log: `${label}.log` }
}
try {
  for (const file of ['package.json', 'tsconfig.base.json', 'vitest.setup.ts']) await cp(join(root, file), join(copy, file))
  await symlink(join(root, 'node_modules'), join(copy, 'node_modules'))
  for (const file of ['apps/desktop/package.json','apps/desktop/tsconfig.json']) {
    await mkdir(dirname(join(copy,file)),{recursive:true}); await cp(join(root,file),join(copy,file))
  }
  for (const [file, bytes] of original) {
    await mkdir(dirname(join(copy,file)),{recursive:true}); await writeFile(join(copy,file),bytes)
    await mkdir(dirname(join(evidence,'source',`${file}.txt`)),{recursive:true}); await writeFile(join(evidence,'source',`${file}.txt`),bytes)
  }
  await writeFile(join(copy,'vitest.mutation.config.mts'), `import { defineConfig } from 'vitest/config';export default defineConfig({test:{include:${JSON.stringify(tests)},setupFiles:[${JSON.stringify(join(copy,'vitest.setup.ts'))}]}});`)
  const baseline = await run('baseline-green'); assert.equal(baseline.code,0,baseline.output); assert.match(baseline.output,/Tests\s+26 passed/)
  for (const mutation of mutations) {
    let changed = original.get(mutation.file).toString()
    for (const edit of mutation.edits) {
      const count = changed.split(edit.before).length-1
      if (edit.occurrence === undefined) { assert.equal(count,1,mutation.label); changed=changed.replace(edit.before,edit.after) }
      else { assert.equal(count,2,mutation.label); const index=edit.occurrence===0 ? changed.indexOf(edit.before) : changed.lastIndexOf(edit.before); changed=changed.slice(0,index)+edit.after+changed.slice(index+edit.before.length) }
    }
    try {
      await writeFile(join(copy,mutation.file),changed)
      const red = await run(`${mutation.label}-red`)
      assert.ok(red.code>0 && !red.timedOut && red.signal===null,red.output)
      assert.match(red.output,/AssertionError/); assert.match(red.output,/Tests\s+[1-9]\d* failed/)
      receipt.cases.push({...mutation,exit:red.code,log:red.log});console.log(JSON.stringify({label:mutation.label,assertionRed:true}))
    } finally { await writeFile(join(copy,mutation.file),original.get(mutation.file)) }
    const green=await run(`${mutation.label}-restore-green`);assert.equal(green.code,0,green.output);assert.match(green.output,/Tests\s+26 passed/)
    receipt.cases.at(-1).restore={exit:green.code,log:green.log}
  }
  receipt.sourceAfter=hashes(new Map(await Promise.all(inputs.map(async file=>[file,await readFile(join(root,file))]))))
  receipt.copyAfter=hashes(new Map(await Promise.all(inputs.map(async file=>[file,await readFile(join(copy,file))]))))
  assert.deepEqual(receipt.sourceBefore,receipt.sourceAfter);assert.deepEqual(receipt.sourceBefore,receipt.copyAfter);receipt.passed=true
} catch(error) { receipt.failure={message:error.message,stack:error.stack} }
finally { await rm(copy,{recursive:true,force:true});receipt.cleanup={copyRemoved:true};await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n') }
console.log(JSON.stringify({passed:receipt.passed,mutants:receipt.cases.length,receipt:join(evidence,'receipt.json')}))
assert.equal(receipt.passed,true,receipt.failure?.message)
