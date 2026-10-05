import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readLocalSigningIdentity } from './macos-local-signing.mjs'

const root = resolve(import.meta.dirname, '../../..')
const exec = promisify(execFile)
const digest = value => createHash('sha256').update(value).digest('hex')
const signingPath = 'apps/desktop/scripts/macos-signing.mjs'
const inputs = [signingPath, 'apps/desktop/scripts/macos-local-signing.mjs',
  'apps/desktop/scripts/package-macos.mjs', 'apps/desktop/test/package-macos-signing.test.ts',
  'apps/desktop/test/macos-local-signing.test.ts', 'apps/desktop/test/vitest.macos-signing.config.mts',
  'apps/desktop/scripts/verify-macos-signing-qualification.mjs', 'pnpm-lock.yaml']
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async path => [path, digest(await readFile(join(root, path)))])))

// Modify one genuine ARM64 instruction byte, preserving the Mach-O structure,
// certificate metadata and default requirement. This never executes the copy.
function tamperText(bytes) {
  const magic = bytes.readUInt32BE(0)
  let base = 0
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const stride = magic === 0xcafebabf ? 32 : 20
    const arches = bytes.readUInt32BE(4)
    const index = Array.from({ length: arches }, (_, i) => 8 + i * stride)
      .find(offset => bytes.readUInt32BE(offset) === 0x0100000c)
    assert.notEqual(index, undefined, 'native fixture must contain ARM64')
    base = magic === 0xcafebabf ? Number(bytes.readBigUInt64BE(index + 8)) : bytes.readUInt32BE(index + 8)
  }
  assert.equal(bytes.readUInt32LE(base), 0xfeedfacf, 'native fixture must be a valid 64-bit Mach-O')
  let command = base + 32
  for (let i = 0; i < bytes.readUInt32LE(base + 16); i++) {
    const kind = bytes.readUInt32LE(command), size = bytes.readUInt32LE(command + 4)
    if (kind === 0x19) {
      for (let section = 0; section < bytes.readUInt32LE(command + 64); section++) {
        const entry = command + 72 + section * 80
        if (bytes.subarray(entry, entry + 16).toString().replaceAll('\0', '') === '__text') {
          const position = base + bytes.readUInt32LE(entry + 48)
          assert(position < bytes.length && bytes.readBigUInt64LE(entry + 40) > 0n)
          bytes[position] ^= 1
          return position
        }
      }
    }
    assert(size >= 8 && command + size <= bytes.length, 'native fixture load commands must remain bounded')
    command += size
  }
  throw new Error('native fixture __text section unavailable')
}

function replaceOnce(source, from, to) {
  assert.equal(source.split(from).length, 2, 'production mutant anchor must be unique')
  return source.replace(from, to)
}

const nativeRejection = (error, pattern) => !error.killed && error.signal == null &&
  [1, 3].includes(error.code) && error.cmd?.startsWith('/usr/bin/codesign ') &&
  pattern.test(String(error.stderr ?? ''))
const requirementRejection = error => nativeRejection(error, /code failed to satisfy specified code requirement(?:\(s\))?/i)
const integrityRejection = error => nativeRejection(error, /invalid signature \(code or signature have been modified\)/i)
const missingRejection = (error, kind) => error.code === 'ERR_ASSERTION' && /^Missing expected rejection/.test(error.message)
  ? kind : 'unexpected-or-infrastructure-failure'

async function evaluate(module, { run, original, healthy, damaged, bundleId }) {
  const rows = []
  const check = async (name, callback, classify) => {
    try { await callback(); rows.push({ name, status: 'passed' }) }
    catch (error) { rows.push({ name, status: 'failed', failureClass: classify(error), messages: [String(error.message)] }) }
  }
  await check('native original valid-warning local identity qualifies', async () => {
    // Controlled observation shape from the actual incident; the real saved
    // certificate and the subsequent native signature qualification are used.
    const observed = await module.preflightMacosSigning({ argv: [], env: {}, loadLocal: async () => original,
      run: async (command, args) => {
        assert.equal(command, '/usr/bin/security')
        assert.deepEqual(args, ['find-identity', '-v', '-p', 'codesigning'])
        const actual = await run(command, args)
        assert(actual.stdout.includes(original.identity), 'original private identity must be actually listed')
        return { stdout: `1) ${original.identity} "Original local certificate" (CSSMERR_TP_NOT_TRUSTED)\n1 valid identities found\n`, stderr: '' }
      } })
    assert.deepEqual(observed, original)
  }, error => error.code == null && error.message.startsWith('The configured signing identity is not uniquely available and valid for codesigning.')
    ? 'original-local-warning-row-rejected' : 'unexpected-or-infrastructure-failure')
  await check('native same-certificate signed Mach-O passes strict trusted qualification', async () => {
    const calls = []
    const proof = await module.verifyMacosSigning(healthy, original, { bundleId,
      run: async (command, args) => { calls.push(args); return run(command, args) } })
    assert.equal(proof.identity, original.identity)
    assert.equal(proof.authorizationContinuity, 'unverified')
    assert.equal(proof.notarized, false)
    assert(calls[0].includes(`=identifier "${bundleId}" and certificate leaf = H"${original.identity}" and certificate leaf trusted`))
  }, error => requirementRejection(error) ? 'actual-native-certificate-requirement-rejected' : 'unexpected-or-infrastructure-failure')
  await check('native wrong certificate cannot become a qualified local signature', async () => {
    await assert.rejects(module.verifyMacosSigning(healthy, { ...original, identity: '0'.repeat(40) }, { run, bundleId }), requirementRejection)
  }, error => missingRejection(error, 'wrong-certificate-rejection-missing'))
  await check('native structurally intact tampered signature must reject', async () => {
    await assert.rejects(module.verifyMacosSigning(damaged, original, { run, bundleId }), integrityRejection)
  }, error => missingRejection(error, 'actual-signature-integrity-rejection-missing'))
  return { passed: rows.filter(row => row.status === 'passed').length,
    failed: rows.filter(row => row.status === 'failed'), rows }
}

async function nativeWorker() {
  const [contextPath, modulePath, resultPath] = process.argv.slice(3)
  const context = JSON.parse(await readFile(contextPath, 'utf8')), logs = []
  let sequence = 0
  const run = async (command, args) => {
    const path = resultPath + `.${sequence++}.log`
    try {
      const result = await exec(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1_048_576 })
      await writeFile(path, result.stdout + result.stderr, { mode: 0o600 })
      logs.push({ stage: args[0], exit: 0, path, sha256: digest(result.stdout + result.stderr) })
      return result
    } catch (error) {
      const contents = String(error.stdout ?? '') + String(error.stderr ?? '')
      await writeFile(path, contents, { mode: 0o600 })
      logs.push({ stage: args[0], exit: error.code, signal: error.signal, path, sha256: digest(contents) })
      throw error
    }
  }
  let result
  try {
    const module = await import(pathToFileURL(modulePath).href)
    assert.equal(typeof module.preflightMacosSigning, 'function')
    assert.equal(typeof module.verifyMacosSigning, 'function')
    result = await evaluate(module, { ...context, run })
    process.exitCode = result.failed.length > 0 ? 1 : 0
  } catch (error) {
    result = { infrastructureError: String(error.stack ?? error), rows: [], failed: [], passed: 0 }
    process.exitCode = 2
  }
  await writeFile(resultPath, JSON.stringify({ ...result, logs, executedModuleSHA256: digest(await readFile(modulePath)) }, null, 2) + '\n', { mode: 0o600 })
}

async function main() {
  assert.equal(process.platform, 'darwin', 'actual macOS qualification cannot be skipped')
  const outputRoot = join(root, '.tmp/macos-signing-qualification')
  await mkdir(outputRoot, { recursive: true, mode: 0o700 })
  const output = await mkdtemp(join(outputRoot, 'attempt-'))
  const before = await hashes()
  const receipt = { schema: 'agentmux.macos-signing-qualification.v1', output, sourceBefore: before,
    qualified: false, units: null, native: null, mutants: [], callers: [], infrastructureError: null }
  let sequence = 0
  const nativeLogs = []
  const run = async (command, args) => {
    const stem = `native-${String(sequence++).padStart(3, '0')}`
    try {
      const result = await exec(command, args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 1_048_576 })
      await writeFile(join(output, stem + '.log'), result.stdout + result.stderr, { mode: 0o600 })
      nativeLogs.push({ stage: args[0], exit: 0, log: stem + '.log', logSHA256: digest(result.stdout + result.stderr) })
      return result
    } catch (error) {
      const log = String(error.stdout ?? '') + String(error.stderr ?? '')
      await writeFile(join(output, stem + '.log'), log, { mode: 0o600 })
      nativeLogs.push({ stage: args[0], exit: error.code, signal: error.signal, log: stem + '.log', logSHA256: digest(log) })
      throw error
    }
  }
  try {
    const unitReport = join(output, 'focused.json')
    let unitExit = 0
    try {
      const result = await exec(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run',
        '--config', 'apps/desktop/test/vitest.macos-signing.config.mts', '--reporter=json', '--outputFile=' + unitReport],
      { cwd: root, env: { ...process.env, PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false' }, encoding: 'utf8', timeout: 60_000, maxBuffer: 1_048_576 })
      await writeFile(join(output, 'focused.log'), result.stdout + result.stderr, { mode: 0o600 })
    } catch (error) {
      unitExit = error.code
      await writeFile(join(output, 'focused.log'), String(error.stdout ?? '') + String(error.stderr ?? ''), { mode: 0o600 })
    }
    const units = JSON.parse(await readFile(unitReport, 'utf8'))
    receipt.units = { exit: unitExit, passed: units.numPassedTests, failed: units.numFailedTests,
      skipped: units.numPendingTests, reportSHA256: digest(await readFile(unitReport)) }
    assert.equal(unitExit, 0)
    assert.equal(units.numFailedTests, 0)
    assert.equal(units.numPendingTests, 0)
    assert(units.numPassedTests >= 54, 'focused original and new signing assertions must be nonempty')

    const source = await readFile(join(root, signingPath), 'utf8')
    const resolved = source.replace("from '@electron/osx-sign'", `from ${JSON.stringify(import.meta.resolve('@electron/osx-sign'))}`)
      .replace("from './macos-local-signing.mjs'", `from ${JSON.stringify(pathToFileURL(join(root, 'apps/desktop/scripts/macos-local-signing.mjs')).href)}`)
    const load = async (name, body) => {
      const path = join(output, name + '.mjs')
      await writeFile(path, body, { mode: 0o600 })
      const module = await import(pathToFileURL(path).href)
      assert.equal(typeof module.preflightMacosSigning, 'function')
      assert.equal(typeof module.verifyMacosSigning, 'function')
      return { module, path, sha256: digest(body) }
    }
    const candidate = await load('candidate', resolved)
    const original = await readLocalSigningIdentity()
    assert.equal(original?.profile, 'local', 'fixture requires the existing saved user certificate; it never creates one')
    const healthy = join(output, 'healthy-macho'), damaged = join(output, 'tampered-macho')
    await copyFile('/usr/bin/true', healthy)
    const bundleId = 'dev.agentmux.signing-qualification'
    await run('/usr/bin/codesign', ['--force', '--sign', original.identity, '--identifier', bundleId, healthy])
    await copyFile(healthy, damaged)
    const bytes = await readFile(damaged), tamperedOffset = tamperText(bytes)
    await writeFile(damaged, bytes)
    const nativeIdentity = { originalCertificateSHA1: original.identity, systemBinarySHA256: digest(await readFile('/usr/bin/true')),
      healthySHA256: digest(await readFile(healthy)), tamperedSHA256: digest(bytes), bytes: bytes.length,
      tamperedOffset, bundleId, candidateModuleSHA256: candidate.sha256 }

    const contextPath = join(output, 'native-context.json')
    await writeFile(contextPath, JSON.stringify({ original, healthy, damaged, bundleId }) + '\n', { mode: 0o600 })
    async function execute(name, module) {
      const resultPath = join(output, name + '.json')
      let exit = 0
      try {
        const result = await exec(process.execPath, [fileURLToPath(import.meta.url), '--native-worker', contextPath, module.path, resultPath],
          { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 1_048_576 })
        await writeFile(join(output, name + '.log'), result.stdout + result.stderr, { mode: 0o600 })
      } catch (error) {
        exit = error.code
        await writeFile(join(output, name + '.log'), String(error.stdout ?? '') + String(error.stderr ?? ''), { mode: 0o600 })
        assert(!error.killed && error.signal == null && exit === 1, 'a worker timeout/load/tool failure is not semantic RED')
      }
      const result = JSON.parse(await readFile(resultPath, 'utf8'))
      assert.equal(result.infrastructureError, undefined)
      assert.equal(result.executedModuleSHA256, module.sha256)
      assert.equal(result.rows.length, 4)
      return { ...result, exit, reportPath: resultPath, reportSHA256: digest(await readFile(resultPath)) }
    }
    const positive = await execute('candidate-native', candidate)
    receipt.native = { ...nativeIdentity, ...positive }
    assert.equal(positive.failed.length, 0, 'actual candidate native assertions must pass')

    const parserStart = resolved.indexOf('  // Count every selected local row')
    const parserEnd = resolved.indexOf('  if (local) { requireSigningPlan(local);', parserStart)
    assert(parserStart > 0 && parserEnd > parserStart)
    const oldParser = String.raw`  const identities = [...inventory.stdout.matchAll(/^\s*\d+\)\s+([A-F0-9]{40})\s+"([^"\n]+)"\s*$/gmi)]
  const selected = identities.filter(match => match[1].toUpperCase() === fingerprint)
  if (selected.length !== 1) reject('The configured signing identity is not uniquely available and valid for codesigning.')
`
    const variants = [
      ['old-local-row-parser', resolved.slice(0, parserStart) + oldParser + resolved.slice(parserEnd),
        'native original valid-warning local identity qualifies', 'original-local-warning-row-rejected'],
      ['wrong-required-certificate', replaceOnce(resolved, 'certificate leaf = H"${plan.identity}" and certificate leaf trusted',
        'certificate leaf = H"${"0".repeat(40)}" and certificate leaf trusted'),
      'native same-certificate signed Mach-O passes strict trusted qualification', 'actual-native-certificate-requirement-rejected'],
      ['removed-native-strict-verification', replaceOnce(resolved,
        "  await run('/usr/bin/codesign', [...verification, appPath])", '  // Counterfactual: native strict verification omitted.'),
      'native structurally intact tampered signature must reject', 'actual-signature-integrity-rejection-missing']
    ]
    for (const [name, body, requiredFailure, requiredClass] of variants) {
      const mutant = await load(name, body)
      const result = await execute(name + '-native', mutant)
      assert(result.failed.some(row => row.name === requiredFailure && row.failureClass === requiredClass),
        'required production semantic mutant must turn its precise native oracle RED')
      receipt.mutants.push({ name, source: signingPath, originalSha256: before[signingPath], mutatedSha256: digest(body),
        executedModuleSha256: mutant.sha256, exit: result.exit, failed: result.failed, reportPath: result.reportPath,
        reportSHA256: result.reportSHA256, semantic: true })
      assert.equal(digest(await readFile(healthy)), nativeIdentity.healthySHA256)
      assert.equal(digest(await readFile(damaged)), nativeIdentity.tamperedSHA256)
    }
    const caller = await readFile(join(root, 'apps/desktop/scripts/package-macos.mjs'), 'utf8')
    for (const symbol of ['preflightMacosSigning', 'signMacosApplication', 'verifyMacosSigning', 'installApplication']) {
      const count = [...caller.matchAll(new RegExp(`\\bawait\\s+${symbol}\\s*\\(`, 'g'))].length
      assert(count > 0, `definition-outside package caller missing: ${symbol}`)
      receipt.callers.push({ source: 'apps/desktop/scripts/package-macos.mjs', symbol, count })
    }
    assert.equal(receipt.mutants.length, 3)
    receipt.qualified = true
  } catch (error) {
    receipt.infrastructureError = String(error.stack ?? error)
    process.exitCode = 1
  } finally {
    receipt.nativeLogs = nativeLogs
    receipt.sourceAfter = await hashes()
    receipt.sourceStable = JSON.stringify(receipt.sourceBefore) === JSON.stringify(receipt.sourceAfter)
    if (!receipt.sourceStable) { receipt.qualified = false; process.exitCode = 1 }
    const path = join(output, 'receipt.json')
    await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify({ receipt: path, qualified: receipt.qualified, sourceStable: receipt.sourceStable,
      unitPassed: receipt.units?.passed, nativePassed: receipt.native?.passed, semanticMutants: receipt.mutants.length }))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--native-worker') await nativeWorker()
  else await main()
}
