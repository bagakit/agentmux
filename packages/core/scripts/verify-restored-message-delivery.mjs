import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
const execute = promisify(execFile), root = fileURLToPath(new URL('../../../', import.meta.url)), core = join(root, 'packages/core')
const args = process.argv.slice(2)
assert(args.every(a => ['--native', '--source', '--mutations', '--resume-boundary'].includes(a)), 'Unknown restored delivery proof option')
const evidence = join(root, '.tmp/verify-restored-message-delivery'); await mkdir(evidence, { recursive: true })
const report = { schema: 'agentmux.restored-message-delivery.v1', passed: false, callers: [], mutations: [] }
const run = (argv, options = {}) => execute(process.execPath, argv, { cwd: root, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, maxBuffer: 8 * 1024 * 1024, ...options })
const tests = () => run([join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(core, 'scripts/restored-message-delivery.vitest.config.mts')])
try {
  await run([join(core, 'scripts/build.mjs')]); report.build = true
  for (const [file, patterns] of [
    ['packages/core/src/providers/codex.ts', [/verifyPromptExecutionTransport: createCodexPromptExecutionTransportVerifier\(\)/u]],
    ['packages/core/src/providers/codex-prompt-execution-evidence.ts', [/openNativeProcessImage\(nativePid, signal\)/u, /nativeProcessBirth\(nativePid, verificationSignal\) === nativeBirth/u]],
    ['packages/core/src/prompt-submission.ts', [/provider\.verifyPromptExecutionTransport\(\{ \.\.\.nativeContext/u]],
    ['packages/core/src/agentmux-cli-commands.ts', [/command\('agent\.send'/u, /execution/u]],
    ['packages/core/test/fixtures/immediate-native-worker.mjs', [/createCodexPromptExecutionTransportVerifier\(\)/u]]
  ]) {
    const text = await readFile(join(root, file), 'utf8'); for (const pattern of patterns) assert(pattern.test(text), `Missing caller ${file} ${pattern}`)
    report.callers.push({ file, witnesses: patterns.length })
  }
  assert(report.callers.length >= 3)
  const types = join(evidence, 'typecheck.json'); await writeFile(types, JSON.stringify({ extends: join(core, 'tsconfig.json'), compilerOptions: { noEmit: true, composite: false, rootDir: root }, include: [join(core, 'test/restored-message-delivery.test.ts'), join(core, 'test/native-process-image.test.ts')], exclude: [] }))
  await run([join(root, 'node_modules/typescript/bin/tsc'), '--project', types]); report.owningTypes = true
  const green = await tests(); await writeFile(join(evidence, 'tests.log'), green.stdout + green.stderr); assert(/12 passed/u.test(green.stdout)); report.tests = 12
  if (args.includes('--mutations')) for (const [name, file, before, after] of [
    ['current-writer-version', 'packages/core/src/providers/codex-prompt-execution-evidence.ts', "if (version !== '0.160.1')", 'if (false)'],
    ['historical-version-gate', 'packages/core/src/providers/codex-prompt-execution-evidence.ts', "if (meta.type !== 'session_meta' || (meta.payload?.session_id ?? meta.payload?.id) !== handle.sessionId) return false", "if (meta.type !== 'session_meta' || (meta.payload?.session_id ?? meta.payload?.id) !== handle.sessionId || (meta.payload)?.cli_version !== '0.160.1') return false"],
    ['cached-input-authorization', 'packages/core/src/providers/codex-prompt-execution-evidence.ts', 'if (owners.length !== 1) return false', "if (versionFact) return true; if (owners.length !== 1) return false"],
    ['root-birth', 'packages/core/src/providers/codex-prompt-execution-evidence.ts', 'await nativeProcessBirth(context.processId, verificationSignal) === rootBirth', 'true'],
    ['writer-birth', 'packages/core/src/providers/codex-prompt-execution-evidence.ts', 'await nativeProcessBirth(nativePid, verificationSignal) === nativeBirth', 'true'],
    ['writer-source', 'packages/core/src/providers/codex-prompt-execution-evidence.ts', '!context.nativeSourceId || sourceIdentity(handle.sessionId, source) !== context.nativeSourceId', 'false'],
    ['mapped-image-current', 'packages/core/src/providers/codex-prompt-execution-evidence.ts', '      await image.assertCurrent(verificationSignal)\n      if (version', '      /* deliberately trust a replaced mapped image */\n      if (version'],
    ['post-probe-unique-writer', 'packages/core/src/providers/codex-prompt-execution-evidence.ts', 'afterOwners.length === 1 && afterOwners[0] === nativePid', 'true']
  ]) {
    const path = join(root, file), original = await readFile(path, 'utf8'); assert.equal(original.split(before).length - 1, 1, `One exact mutation target: ${name}`)
    let red
    try {
      await writeFile(path, original.replace(before, after)); red = await tests().then(value => ({ ...value, code: 0 }), error => error)
      assert.notEqual(red.code, 0, `Mutation survived ${name}`); assert(/\d+ failed|FAIL\s+packages\/core\/test/u.test(red.stdout + red.stderr), `No owning assertion ${name}`)
    } finally { await writeFile(path, original) }
    assert(/12 passed/u.test((await tests()).stdout)); await writeFile(join(evidence, name + '.log'), red.stdout + red.stderr)
    report.mutations.push({ name, result: 'RED/restore GREEN' })
  }
  await run([join(core, 'scripts/build.mjs')])
  if (args.includes('--native')) {
    assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64')
    const intake = join(evidence, 'official-native-0.159.0'); await mkdir(intake, { recursive: true })
    const archive = join(intake, 'native.tgz'), url = 'https://registry.npmjs.org/@openai/codex/-/codex-0.159.0-darwin-arm64.tgz'
    const integrity = 'D1x+5n2y0TE43ERJs3CbBDRPLQl968hpqsInOwYNhfnTOTT53McpfFa6+VfPWwmPi0zW0aJ0C97K+6MhNHYe6A=='
    let bytes = await readFile(archive).catch(() => null)
    if (!bytes) { const response = await fetch(url); assert(response.ok); bytes = Buffer.from(await response.arrayBuffer()); await writeFile(archive, bytes, { mode: 0o600 }) }
    assert.equal(createHash('sha512').update(bytes).digest('base64'), integrity)
    const member = 'package/vendor/aarch64-apple-darwin/bin/codex'
    await execute('tar', ['-xzf', archive, '-C', intake, member])
    const binary = join(intake, member)
    report.oldNativeIntake = { url, integrity: 'sha512-' + integrity, archiveSha256: createHash('sha256').update(bytes).digest('hex'), binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex') }
    const native = await run([join(core, 'test/fixtures/restored-message-native-worker.mjs'), evidence, ...(args.includes('--resume-boundary') ? ['--resume-boundary'] : [])], { timeout: 240_000,
      env: { ...process.env, AGENTMUX_TEST_OLD_CODEX_COMMAND: binary } })
    await writeFile(join(evidence, 'native.log'), native.stdout + native.stderr)
    report.native = JSON.parse(await readFile(join(evidence, 'native-proof.json'), 'utf8')); assert(report.native.passed)
  }
  report.passed = true
} catch (error) { report.failure = { message: error.message, stdout: error.stdout, stderr: error.stderr }; throw error }
finally { await writeFile(join(evidence, 'verification.json'), JSON.stringify(report, null, 2) + '\n') }
console.log(JSON.stringify({ passed: report.passed, tests: report.tests, mutations: report.mutations.length, native: !!report.native, evidence }))
