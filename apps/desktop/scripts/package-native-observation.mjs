// Private, read-only installer bridge. The original installer owns every
// lifecycle decision; this child returns only bounded OS observations.
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'

const koffi = createRequire(import.meta.resolve('@agentmux/core'))('koffi')
const system = koffi.load('/usr/lib/libSystem.B.dylib')
const fail = (condition, message) => { if (!condition) throw new Error(message) }
const pid = value => {
  fail(/^[1-9]\d*$/.test(value ?? '') && Number.isSafeInteger(Number(value)) && Number(value) <= 0x7fffffff, 'Original process identity is invalid.')
  return Number(value)
}

function processIdentity(processId) {
  const proc = koffi.load('/usr/lib/libproc.dylib')
  const read = proc.func('int proc_pidinfo(int pid, int flavor, uint64_t arg, _Out_ void *buffer, int size)')
  // Darwin SDK's proc_bsdinfo: fixed-width fields followed by timeval64.
  const bytes = Buffer.alloc(136)
  fail(read(processId, 3, 0, bytes, bytes.length) === bytes.length, 'Kernel process identity is unavailable.')
  const value = { pid: bytes.readUInt32LE(12), uid: bytes.readUInt32LE(20),
    startSeconds: bytes.readBigUInt64LE(120).toString(), startMicroseconds: Number(bytes.readBigUInt64LE(128)) }
  fail(value.pid === processId && value.uid === process.getuid() && BigInt(value.startSeconds) > 0n &&
    value.startMicroseconds < 1_000_000, 'Kernel process identity is invalid.')
  return value
}

function kernelCodeIdentity(processId) {
  const csops = system.func('int csops(int pid, unsigned int operation, _Out_ void *buffer, size_t size)')
  const before = processIdentity(processId), status = Buffer.alloc(4), digest = Buffer.alloc(20)
  const valid = () => fail(csops(processId, 0, status, status.length) === 0 && (status.readUInt32LE() & 1) !== 0,
    'Runtime kernel code signature is invalid.')
  valid()
  fail(csops(processId, 5, digest, digest.length) === 0, 'Runtime kernel code identity is unavailable.')
  valid()
  const after = processIdentity(processId)
  fail(JSON.stringify(before) === JSON.stringify(after), 'Runtime process changed during kernel code observation.')
  return { ...after, cdHash: digest.toString('hex'), valid: true }
}

function processMode(processId) {
  const before = processIdentity(processId)
  const sysctl = system.func('int sysctl(const int *name, unsigned int count, _Out_ void *value, _Inout_ size_t *size, const void *newValue, size_t newSize)')
  const maximum = Buffer.alloc(4), maximumSize = [4]
  fail(sysctl([1, 8], 2, maximum, maximumSize, null, 0) === 0 && maximumSize[0] === 4,
    'Kernel argument limit is unavailable.')
  const limit = maximum.readInt32LE()
  fail(limit > 0 && limit <= 2 * 1024 * 1024, 'Kernel argument limit is invalid.')
  const bytes = Buffer.alloc(limit), size = [limit]
  fail(sysctl([1, 49, processId], 3, bytes, size, null, 0) === 0 && size[0] >= 4 && size[0] <= limit,
    'Original process mode is unavailable.')
  const raw = bytes.subarray(0, size[0]), argc = raw.readInt32LE()
  fail(argc >= 0 && argc <= 65536, 'Original argument count is unavailable.')
  let offset = 4
  const string = () => {
    const end = raw.indexOf(0, offset)
    fail(end >= offset, 'Original process mode is incomplete.')
    const value = raw.subarray(offset, end)
    offset = end + 1
    return value
  }
  const executable = realpathSync(new TextDecoder('utf-8', { fatal: true }).decode(string()))
  while (offset < raw.length && raw[offset] === 0) offset++
  for (let index = 0; index < argc; index++) string()
  const selected = []
  let environmentPresent = false
  // A changed process title can leave zero padding before the original env.
  // Walk the bounded NUL records as the original reader did, not a C-string.
  while (offset < raw.length) {
    const entry = string()
    if (entry.length) environmentPresent = true
    if (entry.subarray(0, 21).equals(Buffer.from('ELECTRON_RUN_AS_NODE='))) selected.push(entry.subarray(21).toString('hex'))
  }
  // A redacted environment cannot establish GUI mode. No environment bytes or
  // argv leave this child, including when observation fails.
  fail(environmentPresent, 'Original process environment is unavailable.')
  fail(JSON.stringify(before) === JSON.stringify(processIdentity(processId)), 'Original process generation changed.')
  return { mode: selected.length === 0 ? 'gui' : selected.length === 1 && selected[0] === '31' ? 'node' : 'unknown', executable }
}

function nodeModes(processIds) {
  const identities = () => {
    let output
    try { output = execFileSync('/bin/ps', ['-p', processIds.join(','), '-o', 'uid=,pid=,ppid=,lstart='],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }) }
    catch (error) { if (error.status !== 1) throw error; output = error.stdout ?? '' }
    return new Map(output.split('\n').filter(line => line.trim()).map(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
      fail(match, 'Original process identity is unavailable.')
      const value = { pid: Number(match[2]), ppid: Number(match[3]), uid: Number(match[1]), birth: match[4].replace(/\s+/g, ' ') }
      return [value.pid, value]
    }))
  }
  const before = identities(), observations = new Map()
  for (const processId of processIds) {
    try { observations.set(processId, processMode(processId)) }
    catch { observations.set(processId, { mode: 'unknown' }) }
  }
  const after = identities()
  return processIds.flatMap(processId => {
    const identity = after.get(processId)
    return identity ? [{ ...identity, ...(identity.uid === process.getuid() && JSON.stringify(before.get(processId)) === JSON.stringify(identity)
      ? observations.get(processId) : { mode: 'unknown' }) }] : []
  })
}

function staticCodeIdentity(architecture) {
  const owners = [], cleanup = [], calls = []
  let result = null, primary = null
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
  const sec = koffi.load('/System/Library/Frameworks/Security.framework/Security')
  const release = cf.func('void CFRelease(void *value)')
  const own = (name, value) => { fail(value, name + ' returned no object'); owners.push([name, value]); return value }
  const status = (api, value) => { calls.push({ api, status: value }); fail(value === 0, api + ' OSStatus=' + value) }
  try {
    fail(['arm64', 'x86_64'].includes(architecture), 'Selected architecture is invalid.')
    const urlCreate = cf.func('void *CFURLCreateFromFileSystemRepresentation(void *allocator, const uint8_t *bytes, long length, bool directory)')
    const stringCreate = cf.func('void *CFStringCreateWithCString(void *allocator, const char *text, uint32_t encoding)')
    const dictionaryCreate = cf.func('void *CFDictionaryCreate(void *allocator, const void **keys, const void **values, long count, void *keyCallbacks, void *valueCallbacks)')
    const dictionaryValue = cf.func('void *CFDictionaryGetValue(void *dictionary, void *key)')
    const type = cf.func('unsigned long CFGetTypeID(void *value)')
    const dictionaryType = cf.func('unsigned long CFDictionaryGetTypeID()')
    const dataType = cf.func('unsigned long CFDataGetTypeID()')
    const dataLength = cf.func('long CFDataGetLength(void *data)')
    const dataBytes = cf.func('void *CFDataGetBytePtr(void *data)')
    const createCode = sec.func('int32_t SecStaticCodeCreateWithPathAndAttributes(void *path, uint32_t flags, void *attributes, _Out_ void **code)')
    const checkCode = sec.func('int32_t SecStaticCodeCheckValidity(void *code, uint32_t flags, void *requirement)')
    const copyInfo = sec.func('int32_t SecCodeCopySigningInformation(void *code, uint32_t flags, _Out_ void **information)')
    const architectureKey = koffi.decode(sec.symbol('kSecCodeAttributeArchitecture', 'void *'), 'void *')
    const uniqueKey = koffi.decode(sec.symbol('kSecCodeInfoUnique', 'void *'), 'void *')
    const bytes = Buffer.from('/dev/fd/3')
    const url = own('file-url', urlCreate(null, bytes, bytes.length, false))
    const arch = own('architecture-string', stringCreate(null, architecture, 0x08000100))
    const attributes = own('architecture-attributes', dictionaryCreate(null, [architectureKey], [arch], 1, null, null))
    const code = [null]
    status('SecStaticCodeCreateWithPathAndAttributes', createCode(url, 0, attributes, code))
    const staticCode = own('static-code', code[0])
    status('SecStaticCodeCheckValidity', checkCode(staticCode, 0, null))
    const information = [null]
    status('SecCodeCopySigningInformation', copyInfo(staticCode, 0, information))
    const info = own('signing-information', information[0])
    fail(type(info) === dictionaryType(), 'Signing information is not a CFDictionary')
    const digest = dictionaryValue(info, uniqueKey)
    fail(digest && type(digest) === dataType(), 'kSecCodeInfoUnique is not CFData')
    const size = dataLength(digest)
    fail(size === 20, 'Code identity length is not the current kernel CDHASH width: ' + size)
    const raw = dataBytes(digest)
    fail(raw, 'CFData returned no bytes')
    result = { kind: 'security-static-code', architecture, dictionaryKey: 'kSecCodeInfoUnique',
      dataType: 'CFData', byteLength: size, cdHash: Buffer.from(koffi.decode(raw, 'uint8_t', size)).toString('hex'), valid: true }
  } catch (error) { primary = { name: error.name, message: error.message } }
  finally {
    for (const [owner, value] of owners.reverse()) {
      try { release(value); cleanup.push({ owner, released: true }) }
      catch (error) { cleanup.push({ owner, released: false, error: { name: error.name, message: error.message } }) }
    }
  }
  return { result, primary, calls, cleanup }
}

const [operation, ...arguments_] = process.argv.slice(2)
if (operation === '--node-modes' && arguments_.length) process.stdout.write(JSON.stringify(nodeModes(arguments_.map(pid))))
else if (operation === '--kernel-code' && arguments_.length === 1) process.stdout.write(JSON.stringify(kernelCodeIdentity(pid(arguments_[0]))))
else if (operation === '--static-code' && arguments_.length === 1) process.stdout.write(JSON.stringify(staticCodeIdentity(arguments_[0])))
else throw new Error('Select one original installer observation.')
