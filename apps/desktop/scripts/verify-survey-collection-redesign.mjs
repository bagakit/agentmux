import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const entries = (value, label) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Missing ${label}`)
  const rows = Object.entries(value)
  assert.ok(rows.length, `Empty ${label}`)
  return rows
}
const array = (value, label) => {
  assert.ok(Array.isArray(value) && value.length, `Empty ${label}`)
  return value
}
const definitions = {
  surveyZoneItems: 'apps/desktop/src/renderer/src/lib/survey-workface.ts',
  setSurveyZoneCollected: 'apps/desktop/src/renderer/src/store.ts',
  GlobalSurveySurface: 'apps/desktop/src/renderer/src/components/GlobalSurveySurface.tsx',
  SurveyZoneItem: 'apps/desktop/src/renderer/src/components/SurveyZoneItem.tsx',
  WorkspaceWorkbench: 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx'
}
const production = file => /^(?:apps\/desktop|packages\/[^/]+)\/src\//.test(file)
const commitBytes = (root, commit, file) => {
  assert.match(commit, /^[a-f0-9]{40}$/, 'Missing committed Source candidate')
  return execFileSync('git', ['show', `${commit}:${file}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
}

// The original build receipt records output paths relative to the workspace.
export async function checkCompiledOutputs(root, outputs) {
  for (const [file, expected] of entries(outputs, 'compiled outputs')) {
    const absolute = path.resolve(root, file)
    assert.ok(absolute.startsWith(root + path.sep), `Output leaves workspace: ${file}`)
    assert.match(expected, /^[a-f0-9]{64}$/)
    assert.equal(hash(await readFile(absolute)), expected, `Changed compiled output: ${file}`)
  }
}

const greenResult = log => {
  assert.ok(!/^.*Tests.*\b[1-9]\d* failed/m.test(log), 'Failed tests remain in actual log')
  const found = /Tests\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?\s+\((\d+)\)/.exec(log)
  assert.ok(found && Number(found[1]) > 0, 'No nonempty all-GREEN test result')
  const result = { cases: Number(found[1]), skipped: Number(found[2] ?? 0) }
  assert.equal(result.cases + result.skipped, Number(found[3]), 'Test total differs from passed + skipped')
  return result
}
const greenCases = log => greenResult(log).cases

export async function checkOriginalMutation(value, receiptPath, pinned) {
  let count = 0
  entries(value.sourceBefore, 'original mutation Source')
  assert.equal(value.schema, 'agentmux.renderer-source-mutation.v1')
  assert.equal(value.passed, true)
  assert.equal(value.sharedTreeMutations, 0)
  assert.deepEqual(value.runtimeControl, [])
  assert.deepEqual(value.sourceBefore, value.sourceAfter)
  assert.deepEqual(value.sourceBefore, value.copyAfter)
  assert.equal(value.cleanup?.copyRemoved, true)
  for (const test of array(value.cases, 'actual loaded mutations')) {
    assert.ok(test.before && test.after && test.before !== test.after, 'Missing actual mutation transform')
    assert.equal(test.exit, 1, `No Assertion RED: ${test.label}`)
    assert.equal(test.restore?.exit, 0, `No restore GREEN: ${test.label}`)
    assert.ok(production(test.file) && value.sourceBefore[test.file], 'Mutation does not target owning production Source')
    assert.match(test.loaded?.sha256, /^[a-f0-9]{64}$/)
    assert.notEqual(test.loaded.sha256, value.sourceBefore[test.file], 'Original Source was loaded instead of mutant')
    assert.equal(test.restore.loaded?.sha256, value.sourceBefore[test.file], 'Restored Source was not loaded')
    assert.equal(test.loaded.file, test.restore.loaded.file, 'Restore did not use the same copy')
    assert.ok(test.loaded.file.endsWith('/' + test.file), 'Loaded trace targets another Source file')
    for (const phase of [test, test.restore]) {
      const logFile = path.join(path.dirname(receiptPath), phase.log)
      const log = (await pinned(logFile)).toString('utf8')
      const trace = JSON.parse(await pinned(logFile.replace(/\.log$/, '-loaded.json')))
      assert.deepEqual(trace, phase.loaded, 'Actual loaded trace differs from receipt')
      if (phase === test) assert.match(log, /AssertionError/, 'RED is not an assertion')
      else greenCases(log)
    }
    count++
  }
  return count
}

export async function checkOriginalRestore(value, receiptPath, pinned) {
  entries(value.sourceBefore, 'original restore Source')
  assert.equal(value.schema, 'agentmux.survey-collection-restore.v1')
  assert.equal(value.passed, true)
  assert.deepEqual(value.sourceBefore, value.sourceAfter)
  assert.match(value.compiledSha256, /^[a-f0-9]{64}$/)
  assert.equal(value.phases?.length, 2)
  assert.deepEqual(value.phases.map(phase => phase.phase), ['seed', 'restore'])
  assert.notEqual(value.phases[0].pid, value.phases[1].pid, 'Restore reused one process')
  for (const phase of value.phases) {
    assert.equal(phase.passed, true)
    const output = JSON.parse(await pinned(path.join(path.dirname(receiptPath), `${phase.phase}.json`)))
    assert.deepEqual(output, phase, 'Actual phase output differs from restore receipt')
    const phaseLog = (await pinned(path.join(path.dirname(receiptPath), `${phase.phase}.log`))).toString('utf8')
    assert.ok(phaseLog.split('\n').some(line => { try { const fact = JSON.parse(line); return fact.passed === true && fact.phase === phase.phase && fact.pid === phase.pid } catch { return false } }), 'No actual phase/pid in original log')
    assert.ok(Number.isInteger(phase.pid) && phase.pid > 0)
    array(phase.items, 'restored Survey items')
    entries(phase.collection, 'restored explicit collection')
    array(phase.selection?.selection, 'restored exact selection')
    for (const field of ['displayWorkspaceId', 'groupId', 'tabId', 'regionId']) assert.ok(phase.selection.active?.[field], 'Missing active exact location')
    assert.equal(typeof phase.sidebarCollapsed, 'boolean')
    assert.ok(Number.isFinite(phase.sidebarWidth) && phase.sidebarWidth > 0)
  }
  for (const field of ['items', 'collection', 'selection', 'sidebarCollapsed', 'sidebarWidth']) assert.deepEqual(value.phases[0][field], value.phases[1][field], `Restore changed ${field}`)
  assert.equal(value.cleanup?.compiledRemoved, true)
  assert.equal(value.cleanup?.privateResourcesRemoved, true)
  return value.phases.length
}

export async function checkEvidence(root, evidencePath, taskId) {
  assert.ok(['T-001', 'T-002'].includes(taskId), `Unknown Task: ${taskId}`)
  const artifactRoot = path.resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root }).toString().trim(), '..')
  const resolve = file => {
    assert.ok(typeof file === 'string' && file.length, 'Missing artifact path')
    const result = path.resolve(root, file)
    assert.ok(result.startsWith(artifactRoot + path.sep), `Artifact leaves Git workspace: ${file}`)
    return result
  }
  const bytes = async (file, expected) => {
    assert.match(expected, /^[a-f0-9]{64}$/, `Missing SHA256: ${file}`)
    const actual = await readFile(resolve(file))
    assert.equal(hash(actual), expected, `Changed bytes: ${file}`)
    return actual
  }
  const artifact = async ref => ({ value: JSON.parse(await bytes(ref?.path, ref?.sha256)), file: ref.path })
  const proof = JSON.parse(await readFile(resolve(evidencePath), 'utf8'))
  assert.equal(proof.schema, 'agentmux.survey-collection-redesign.evidence.v1')
  const task = proof.tasks?.[taskId]
  assert.ok(task, `Missing ${taskId} evidence`)
  // Attachments pin existing receipt children whose original format names a log/trace
  // but does not store its SHA. This map contains identities, not a second proof result.
  const attachments = Object.fromEntries(entries(task.attachments, 'original artifact identities'))
  const pinned = async file => bytes(file, attachments[file])
  const child = (parent, file) => path.relative(root, path.resolve(path.dirname(resolve(parent)), file))
  const { value: qualified } = await artifact(task.qualification)
  assert.equal(qualified.schema, 'agentmux.survey-redesign.current-source.v1')
  assert.equal(qualified.sourceCommit, task.sourceCommit)
  const current = Object.fromEntries(entries(qualified.owningFiles, 'current owning Source'))
  for (const [file, sha] of Object.entries(current)) {
    await bytes(file, sha)
    assert.equal(hash(commitBytes(root, task.sourceCommit, file)), sha, `Commit/working mismatch: ${file}`)
  }
  for (const file of ['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/survey-workface.ts', 'apps/desktop/src/renderer/src/components/GlobalSurveySurface.tsx']) {
    assert.ok(current[file], `Missing owning Source: ${file}`)
  }

  const checks = qualified.checks
  const slices = Object.fromEntries(entries(qualified.qualifiedSlices, 'actual mounted scopes'))
  assert.ok(slices.originalOwning, 'Missing actual baseline scope')
  const scopedLogs = [], mountedScope = {}
  let mountedCases = 0
  for (const [name, scope] of Object.entries(slices)) {
    const key = name === 'originalOwning' ? 'mounted' : name
    const check = checks?.[key], ref = qualified.artifacts?.[key]
    assert.equal(check?.exit, 0, `Mounted scope did not pass: ${name}`)
    assert.equal(scope.exit, 0)
    assert.match(scope.sourceCommit, /^[a-f0-9]{40}$/, 'Missing executed scope Source')
    assert.ok(check.command, 'Missing actual mounted command')
    const result = greenResult((await bytes(ref?.path, ref?.sha256)).toString('utf8'))
    assert.deepEqual(result, { cases: check.cases, skipped: check.skipped ?? 0 }, 'Mounted count/log mismatch')
    assert.deepEqual(result, { cases: scope.cases, skipped: scope.skipped ?? 0 }, 'Scope count/log mismatch')
    mountedScope[name] = scope
    mountedCases += result.cases
    scopedLogs.push({ name, scope, ref })
  }
  for (const name of ['sourceTypes', 'strictTypes']) {
    assert.equal(checks[name]?.exit, 0, `${name} did not pass`)
    await bytes(qualified.artifacts[name].path, qualified.artifacts[name].sha256)
  }
  const sourceConfigRef = { path: checks.sourceTypes.config, sha256: checks.sourceTypes.configSha256 }
  const { value: sourceConfig } = await artifact(sourceConfigRef)
  const included = array(sourceConfig.include, 'production type inputs')
  const includedOwners = Object.keys(current).filter(production).filter(file => included.some(pattern => path.matchesGlob(resolve(file), path.resolve(path.dirname(resolve(sourceConfigRef.path)), pattern))))
  assert.ok(includedOwners.length > 0, 'Production type config includes no owning Source')
  const aliasBase = path.resolve(path.dirname(resolve(sourceConfigRef.path)), sourceConfig.compilerOptions.baseUrl)
  for (const [name, targets] of entries(sourceConfig.compilerOptions?.paths, 'production Source aliases')) {
    for (const target of array(targets, `${name} Source targets`)) {
      const file = path.relative(root, path.resolve(aliasBase, target))
      assert.ok(production(file) && (await readFile(resolve(file))).length, `Alias does not resolve Source: ${name}`)
    }
  }
  const strictFile = checks.strictTypes.config
  const strict = JSON.parse(await bytes(strictFile, checks.strictTypes.configSha256))
  assert.deepEqual(strict.include, checks.strictTypes.includes, 'Strict include receipt differs from actual config')
  assert.equal(strict.compilerOptions?.strict, true, 'Owning fixture is not strict')
  for (const file of array(strict.include, 'strict fixture inputs')) {
    const resolved = child(strictFile, file)
    assert.ok((await pinned(resolved)).length, `Empty strict input: ${resolved}`)
  }
  const { value: review } = await artifact(task.sourceReview)
  for (const symbol of taskId === 'T-001' ? ['surveyZoneItems', 'setSurveyZoneCollected', 'GlobalSurveySurface'] : ['GlobalSurveySurface', 'SurveyZoneItem']) assert.ok(review.callers?.[symbol], `Missing actual caller: ${symbol}`)
  for (const [symbol, rows] of entries(review.callers, 'product callers')) {
    assert.ok(definitions[symbol], `Unknown caller symbol: ${symbol}`)
    let uses = 0
    for (const row of array(rows, `${symbol} callers`)) {
      assert.ok(production(row.file) && row.file !== definitions[symbol] && !/\/test\//.test(row.file), `Not a caller: ${symbol}`)
      assert.ok(!/^\s*(?:import\b|declare\b|export\s+(?:type|interface|function|(?:const|let|class)\s)|(?:type|interface|function)\b|(?:\/\/|\/\*|\*))/u.test(row.text) && row.text.includes(symbol), `Only an import: ${symbol}`)
      assert.ok((await readFile(resolve(row.file), 'utf8')).split('\n').includes(row.text), `Changed caller: ${symbol}`)
      uses++
    }
    assert.ok(uses > 0, `No product caller: ${symbol}`)
  }
  assert.equal(review.status, 'approved', 'Independent Source review is not approved')
  assert.ok(review.reviewer && review.seenScope, 'Missing independent reviewer/seen scope')
  assert.equal(review.toSource, task.sourceCommit)
  assert.deepEqual(review.currentQualification, task.qualification)
  const proofInputs = []
  const consumed = (ref, fromSource) => {
    const result = array(review.consumedProofs, 'finite proof consumption').find(item => item.proof.path === ref.path && item.proof.sha256 === ref.sha256)
    assert.ok(result, `Unknown historical proof scope: ${ref.path}`)
    assert.equal(result.toSource, task.sourceCommit)
    if (fromSource) assert.equal(result.fromSource, fromSource, 'Unknown executed scope Source')
    assert.ok(result.seenScope && result.semanticConclusion, `Missing finite conclusion: ${ref.path}`)
    return result
  }
  const bearings = async (consumption, drift) => {
    for (const changed of drift) {
      assert.equal(hash(commitBytes(root, consumption.fromSource, changed.file)), changed.before, 'Changed historical input')
      assert.equal(hash(await readFile(resolve(changed.file))), changed.after, 'Changed current input')
    }
    for (const anchor of array(consumption.unchangedAnchors, 'reviewed unchanged bearing scopes')) {
      assert.ok(typeof anchor.text === 'string' && anchor.text.length, 'Empty bearing scope')
      assert.equal(hash(Buffer.from(anchor.text)), anchor.sha256, 'Changed bearing scope identity')
      for (const sourceBytes of [commitBytes(root, consumption.fromSource, anchor.file), await readFile(resolve(anchor.file))]) {
        assert.equal(sourceBytes.toString('utf8').split(anchor.text).length, 2, 'Bearing scope must occur exactly once')
      }
    }
    const nonBearing = new Set()
    for (const item of consumption.nonBearingInputs ?? []) {
      assert.deepEqual(drift.find(changed => changed.file === item.file), { file: item.file, before: item.before, after: item.after }, 'Unknown non-bearing input diff')
      const { value: finite } = await artifact(item.review)
      assert.equal(finite.status, 'pass-finite-source-consumption')
      assert.ok(finite.reviewer, 'Missing finite Source reviewer')
      assert.equal(finite.sourceCommit, task.sourceCommit)
      assert.ok(item.observation?.scope && item.observation?.result && finite.observations?.some(observation => observation.scope === item.observation.scope && observation.result === item.observation.result), 'Missing original finite observation')
      const original = finite.consumedProofs?.find(proof => resolve(proof.file) === resolve(consumption.proof.path) && proof.sha256 === consumption.proof.sha256)
      assert.equal(original?.originalSourceCommit, consumption.fromSource)
      assert.equal(original?.currentInputSha256?.[item.file], item.after, 'Finite review does not cover this input')
      nonBearing.add(item.file)
    }
    for (const changed of drift) assert.ok(consumption.unchangedAnchors.some(anchor => anchor.file === changed.file) || nonBearing.has(changed.file), `Unknown changed input: ${changed.file}`)
  }
  const qualifyInputs = async (source, ref) => {
    const inputs = entries(source, 'proof Source inputs'), drift = []
    for (const [file, sha] of inputs) {
      const now = hash(await readFile(resolve(file)))
      if (now !== sha) drift.push({ file, before: sha, after: now })
    }
    proofInputs.push({ proof: ref, changedInputs: drift })
    if (drift.length) {
      const consumption = consumed(ref)
      for (const [file, sha] of inputs) if (production(file)) assert.equal(hash(commitBytes(root, consumption.fromSource, file)), sha, `Historical Source mismatch: ${file}`)
      const ordered = rows => rows.toSorted((a, b) => a.file.localeCompare(b.file))
      assert.deepEqual(ordered(consumption.changedInputs), ordered(drift), `Unreviewed Source diff: ${ref.path}`)
      await bearings(consumption, drift)
    } else {
      for (const [file, sha] of inputs) if (production(file)) assert.equal(hash(commitBytes(root, task.sourceCommit, file)), sha, `Current proof input is not committed: ${file}`)
    }
  }
  for (const { name, scope, ref } of scopedLogs) if (scope.sourceCommit !== task.sourceCommit) {
    if (name === 'originalOwning' && qualified.previousQualification) {
      let previousRef = qualified.previousQualification, previous
      const visited = new Set()
      do {
        assert.ok(previousRef?.path && !visited.has(previousRef.path), 'Missing or cyclic original qualification')
        visited.add(previousRef.path)
        previous = (await artifact(previousRef)).value
        assert.equal(previous.schema, 'agentmux.survey-redesign.current-source.v1')
        assert.deepEqual(previous.artifacts.mounted, ref, 'Baseline log identity differs')
        if (previous.behaviorCommit === scope.sourceCommit) break
        previousRef = previous.previousQualification
      } while (true)
      assert.equal(previous.sourceCommit, checks.mounted.sourceCommit ?? previous.sourceCommit, 'Unknown qualified baseline Source')
      await qualifyInputs(previous.owningFiles, previousRef)
    } else {
      // The independent reviewer owns this explicitly bounded semantic scope;
      // the tool checks its declared diff/anchors, not a complete graph equivalence.
      const consumption = consumed(ref, scope.sourceCommit)
      assert.ok(Array.isArray(consumption.changedInputs), 'Missing declared scope diff')
      await bearings(consumption, consumption.changedInputs)
    }
  }
  let mutated = 0
  for (const ref of array(task.mutations, 'loaded mutation receipts')) {
    const { value, file } = await artifact(ref)
    mutated += await checkOriginalMutation(value, file, pinned)
    await qualifyInputs(value.sourceBefore, ref)
  }
  if (taskId === 'T-001') {
    const { value } = await artifact(task.restore)
    await checkOriginalRestore(value, task.restore.path, pinned)
    await qualifyInputs(value.sourceBefore, task.restore)
  } else {
    const { value: compiled, file } = await artifact(task.compiled)
    assert.equal(compiled.sourceCommit, task.sourceCommit)
    assert.deepEqual(compiled.workingInputs, compiled.sourceAfter, 'Source changed while compiling')
    assert.ok(compiled.sourceBoundary, 'Missing actual compiled Source scope')
    for (const [source, sha] of entries(compiled.workingInputs, 'compiled inputs')) {
      if (production(source)) assert.equal(hash(commitBytes(root, task.sourceCommit, source)), sha, `Compiled production input is not committed: ${source}`)
      else await bytes(source, sha) // ignored private fixture, not production Source
    }
    for (const [source, sha] of Object.entries(current).filter(([file]) => production(file) && !file.endsWith('.css'))) {
      assert.equal(compiled.workingInputs[source], sha, `Owning Source was not actually compiled: ${source}`)
    }
    for (const [style, sha] of entries(compiled.importedStyles, 'compiled styles')) {
      if (production(style)) assert.equal(hash(commitBytes(root, task.sourceCommit, style)), sha, `Compiled style is not committed: ${style}`)
      else await bytes(style, sha)
    }
    for (const [style, sha] of Object.entries(current).filter(([file]) => file.endsWith('.css'))) assert.equal(compiled.importedStyles[style], sha, `Owning style was not actually compiled: ${style}`)
    await checkCompiledOutputs(root, compiled.outputs)
    const { value: images, file: imagesFile } = await artifact(task.images)
    const { value: visual } = await artifact(task.visualReview)
    assert.equal(images.sourceCommit, task.sourceCommit)
    assert.deepEqual(images.compiledReceipt, task.compiled)
    assert.equal(visual.sourceCommit, task.sourceCommit)
    assert.equal(visual.schema, 'agentmux.survey-redesign.final-visual-continuation.v1')
    for (const [field, ref] of [['compiledReceipt', task.compiled], ['previewReceipt', task.images], ['currentQualification', task.qualification]]) {
      assert.equal(resolve(visual[field]), resolve(ref.path), `Changed visual ${field}`)
      assert.equal(visual[field + 'Sha256'], ref.sha256)
    }
    assert.equal(visual.aestheticSatisfied, true, 'Independent reviewer is not satisfied')
    assert.deepEqual(visual.findings, [], 'Visual must-fix is unresolved')
    assert.ok(visual.reviewer, 'Missing independent visual reviewer')
    for (const observation of array(visual.observations, 'actual visual observations')) assert.ok(observation.scope && observation.observation, 'Missing actual visual observation')
    const { value: prior } = await artifact({ path: visual.priorVisualReview, sha256: visual.priorVisualReviewSha256 })
    assert.equal(prior.status, 'pass'); assert.equal(prior.aestheticSatisfied, true); assert.deepEqual(prior.findings, [])
    const { value: finite } = await artifact({ path: visual.sourceReview, sha256: visual.sourceReviewSha256 })
    assert.equal(finite.status, 'pass-finite-source-consumption'); assert.ok(finite.reviewer); assert.equal(finite.sourceCommit, task.sourceCommit)
    await artifact({ path: visual.priorGeometry, sha256: visual.priorGeometrySha256 })
    const opened = array(visual.readImages, 'actual opened images')
    const frames = array(images.frames, 'actual final frames')
    for (const frame of frames) {
      assert.ok(images.frameRoot, 'Missing original frame directory')
      const picture = await bytes(path.join(images.frameRoot, frame.file), frame.sha256)
      assert.ok(picture.length > 24 && picture.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'Frame is not PNG')
      assert.deepEqual(frame.pixelSize, { width: picture.readUInt32BE(16), height: picture.readUInt32BE(20) })
      const seen = opened.find(item => item.file === frame.file && item.sha256 === frame.sha256)
      if (seen) { assert.equal(seen.actualOpened, true); continue }
      const consumed = array(visual.consumedImages, 'explicitly consumed images').find(item => item.file === frame.file && item.sha256 === frame.sha256)
      assert.ok(consumed?.actualOpened === false && consumed.previousActualOpened === true, `Image was not actually reviewed: ${frame.file}`)
      assert.equal(resolve(consumed.previousReview), resolve(visual.priorVisualReview)); assert.equal(consumed.previousReviewSha256, visual.priorVisualReviewSha256)
      assert.ok(array(prior.readImages, 'prior actual opened images').some(item => item.file === frame.file && item.sha256 === consumed.previousImageSha256 && item.actualOpened === true), 'Unknown prior opened image')
      if (consumed.byteIdenticalToPreviouslyOpened) {
        assert.equal(consumed.reviewMode, 'previous-actual-opened-native-identical-bytes'); assert.equal(consumed.previousImageSha256, frame.sha256)
      } else {
        assert.equal(consumed.reviewMode, 'prior-composition-consumed-with-current-source-and-changed-footer-representatives')
        assert.ok(consumed.currentImageIndividuallyOpened === false && consumed.basis, 'Missing finite image consumption basis')
      }
    }
    for (const scene of array(images.scenes, 'actual full-interface scenes')) {
      assert.ok(scene.name, 'Missing actual scene')
      entries(scene.owners, 'actual scene owners'); entries(scene.geometry, 'actual scene geometry')
      for (const image of array(scene.images, 'scene images')) assert.ok(frames.some(frame => frame.file === image.file && frame.sha256 === image.sha256), 'Scene image is not in final frames')
    }
  }
  return { passed: true, task: taskId, sourceCommit: task.sourceCommit, mountedCases, mountedScope, loadedMutations: mutated, consumedProofs: proofInputs.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    assert.equal(args.shift(), '--check-evidence', 'Expected --check-evidence --task T-001|T-002 [--evidence path]')
    let task, evidence, evidenceFlag = false
    while (args.length) {
      const flag = args.shift(), value = args.shift()
      assert.ok(value, `Missing value: ${flag}`)
      if (flag === '--task' && task === undefined) task = value
      else if (flag === '--evidence' && !evidenceFlag) { evidence = value; evidenceFlag = true }
      else assert.fail(`Unknown or duplicate argument: ${flag}`)
    }
    console.log(JSON.stringify(await checkEvidence(workspace, evidence ?? '.tmp/survey-collection-redesign/qualification.json', task)))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
