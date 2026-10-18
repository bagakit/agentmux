import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
const files = [...new Set(tracked.split('\0').filter(Boolean))].filter(path => {
  if (!/\.(?:[cm]?[jt]sx?|swift)$/u.test(path) || /(?:^|\/)(?:test|tests|fixtures|vendor)(?:\/|$)/u.test(path)) return false
  return /^(?:apps|packages)\/[^/]+\/src\//u.test(path)
    || /^apps\/desktop\/browser-extension\//u.test(path)
    || /^apps\/mobile\/ios\/App\/App\//u.test(path)
    || /^packages\/core\/examples\//u.test(path)
    || /^apps\/desktop\/scripts\/icon-review\//u.test(path)
    || /^apps\/desktop\/scripts\/(?:package[^/]*|update-[^/]*|macos-local-signing|prepare-browser-extension-identity)\.mjs$/u.test(path)
})
const sources = new Map(await Promise.all(files.map(async path => [path, await readFile(new URL(path, new URL('..', import.meta.url)), 'utf8')])))

function verify(sources) {
  assert.ok(sources.size > 0, 'Production source discovery must not be empty')
  let consumers = 0, preservedExternalWireUuidCalls = 0
  const violations = []
  for (const [path, original] of sources) {
    let source = original
    if (path === 'packages/connectors/src/connection-enrollment-store.ts') {
      // The private create wire contract is unknown; retain only its original format.
      const createClaim = "const attemptId = kind === 'create' ? randomUUID() : mintObjectId()"
      assert.equal(source.split(createClaim).length, 2, 'The original external create wire allocation must be exact')
      source = source.replace(createClaim, 'const attemptId = mintObjectId()')
      preservedExternalWireUuidCalls++
    }
    if (/\bmintObjectId\b/u.test(source)) consumers++
    // These are autonomous allocation calls, not legacy UUID validators,
    // external protocol fields, fixture values or native identifiers.
    if (/\brandomUUID\s*\(|\bUUID\s*\(\)\s*\.uuidString|\buuidv[14]\s*\(|\buuid\.v[14]\s*\(/u.test(source)) violations.push(path)
    if (/bytes\[6\].*&\s*(?:15|0x0f).*\|\s*(?:64|0x40)/u.test(source)) violations.push(path)
  }
  assert.ok(consumers > 0, 'Production consumers of the shared allocator must be present')
  assert.deepEqual(violations, [], 'Autonomous UUID allocation must use the shared identity component')
  assert.equal(preservedExternalWireUuidCalls, 1)
  return { files: sources.size, consumers, preservedExternalWireUuidCalls }
}

const coverage = verify(sources)
// Exercise the actual scan against an actual production consumer with its
// allocator regressed; a missing scan or an empty discovery must fail too.
const target = [...sources].find(([, source]) => /\bmintObjectId\(\)/u.test(source))
assert.ok(target, 'An actual allocation call is required for the scan mutation')
const mutant = new Map(sources)
mutant.set(target[0], target[1].replace(/\bmintObjectId\(\)/u, 'crypto.randomUUID()'))
assert.throws(() => verify(mutant), /Autonomous UUID allocation/u)
const unexpected = new Map(sources)
const externalOwner = 'packages/connectors/src/connection-enrollment-store.ts'
unexpected.set(externalOwner, sources.get(externalOwner) + '\nconst unexpected = crypto.randomUUID()\n')
assert.throws(() => verify(unexpected), /Autonomous UUID allocation/u)
assert.throws(() => verify(new Map()), /must not be empty/u)
verify(sources)
process.stdout.write(JSON.stringify({ passed: true, ...coverage, autonomousUuidCalls: 0, mutations: 3 }) + '\n')
