import { fixtureTime as _reshape_fixtureTime, fixturePath as _reshape_fixturePath } from "../scripts/lib/fixture-values.mjs"
const _reshape_birthSeconds = Math.floor(_reshape_fixtureTime() / 1000)
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import ts from 'typescript'
import { afterAll, expect, it, vi } from 'vitest'

const exec = promisify(execFile)
const source = await readFile(new URL('../scripts/package-runtime-upgrade.mjs', import.meta.url), 'utf8')
const ast = ts.createSourceFile('owner.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
function actualBridge(name: string) {
  const declaration = ast.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
    .find(node => ts.isIdentifier(node.name) && node.name.text === name)
  const initializer = declaration?.initializer
  if (!initializer || !ts.isTaggedTemplateExpression(initializer) || !ts.isNoSubstitutionTemplateLiteral(initializer.template))
    throw new Error(`The actual ${name} bridge source is unavailable.`)
  return initializer.template.text
}
const bridge = actualBridge('CODE_IDENTITY_SOURCE')
const staticBridge = actualBridge('STATIC_CODE_IDENTITY_SOURCE')
const roots: string[] = [], evidence: unknown[] = []
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  if (process.env.T008_EVIDENCE_DIRECTORY) {
    await mkdir(process.env.T008_EVIDENCE_DIRECTORY, { recursive: true })
    await writeFile(join(process.env.T008_EVIDENCE_DIRECTORY, 'kernel-bridge.json'), JSON.stringify(evidence, null, 2) + '\n')
  }
  if (process.env.T015_EVIDENCE_DIRECTORY) {
    await mkdir(process.env.T015_EVIDENCE_DIRECTORY, { recursive: true })
    await writeFile(join(process.env.T015_EVIDENCE_DIRECTORY, 'static-bridge.json'), JSON.stringify(evidence, null, 2) + '\n')
  }
})

it.runIf(process.platform === 'darwin')('matches the actual bridge struct to this Darwin SDK ABI', async () => {
  const root = await mkdtemp(_reshape_fixturePath("tmp/amx-owner-abi-")); roots.push(root)
  const file = join(root, 'abi.c'), binary = join(root, 'abi')
  await writeFile(file, `#include <sys/proc_info.h>
    #include <stddef.h>
    #include <stdio.h>
    int main(void) { printf("{\\"size\\":%zu,\\"pid\\":%zu,\\"uid\\":%zu,\\"seconds\\":%zu,\\"microseconds\\":%zu}",
      sizeof(struct proc_bsdinfo),offsetof(struct proc_bsdinfo,pbi_pid),offsetof(struct proc_bsdinfo,pbi_uid),
      offsetof(struct proc_bsdinfo,pbi_start_tvsec),offsetof(struct proc_bsdinfo,pbi_start_tvusec)); }`)
  await exec('xcrun', ['clang', file, '-o', binary])
  const sdk = JSON.parse((await exec(binary)).stdout)
  const definition = bridge.slice(0, bridge.indexOf('pid=int(sys.argv[1])'))
  const python = JSON.parse((await exec('/usr/bin/python3', ['-c', definition + `
print(json.dumps({'size':ctypes.sizeof(ProcBSDInfo),'pid':ProcBSDInfo.pbi_pid.offset,'uid':ProcBSDInfo.pbi_uid.offset,
 'seconds':ProcBSDInfo.pbi_start_tvsec.offset,'microseconds':ProcBSDInfo.pbi_start_tvusec.offset}))`])).stdout)
  expect(python).toEqual(sdk)
  evidence.push({ test: 'SDK-ABI', sdk, actualBridge: python })
})

async function controlledKernel(mode: string) {
  // Control libproc/csops only. Execute the production bridge unchanged in an actual
  // Python process; this fixture proves the read fence, not real OS identity.
  const bootstrap = `import ctypes,types,sys
sys.argv=['owner-bridge',${JSON.stringify(String(process.pid))}]
mode=${JSON.stringify(mode)}; calls=0
def pidinfo(pid,flavor,arg,buffer,size):
 global calls
 value=buffer._obj; value.pbi_pid=pid+(1 if mode=='pid mismatch' else 0); value.pbi_uid=${process.getuid!()}
 value.pbi_start_tvsec=${_reshape_birthSeconds}; value.pbi_start_tvusec=123456+(1 if mode=='microsecond drift' and calls else 0)
 calls+=1
 return size-(1 if mode=='short read' else 0)
def csops(pid,op,buffer,size):
 if op==0:buffer._obj.value=1
 else:ctypes.memmove(buffer,b'\\x11'*20,size)
 return 0
ctypes.CDLL=lambda *args,**kwargs:types.SimpleNamespace(proc_pidinfo=pidinfo,csops=csops)
`
  return exec('/usr/bin/python3', ['-c', bootstrap + bridge]).then(value => ({ value }), error => ({ error }))
}
it.runIf(process.platform === 'darwin')('returns only stable machine owner facts from the actual bridge', async () => {
  const outcome = await controlledKernel('stable'); expect(outcome).toHaveProperty('value')
  const facts = JSON.parse((outcome as { value: { stdout: string } }).value.stdout)
  expect(facts).toEqual({ pid: process.pid, uid: process.getuid!(), startSeconds: String(_reshape_birthSeconds), startMicroseconds: 123456,
    cdHash: '11'.repeat(20), valid: true })
  evidence.push({ test: 'controlled-stable-machine-facts', facts })
})
it.runIf(process.platform === 'darwin').each(['microsecond drift', 'short read', 'pid mismatch'])
  ('refuses %s inside the actual kernel code observation', async mode => {
    const outcome = await controlledKernel(mode); expect(outcome).toHaveProperty('error')
    expect((outcome as { error: { stderr: string } }).error.stderr).toContain(mode === 'microsecond drift'
      ? 'Runtime process changed during kernel code observation' : 'kernel process identity')
    evidence.push({ test: 'controlled-kernel-refused', mode })
  })

async function controlledStatic(mode: string) {
  // Execute the production CF bridge in Python. Only its native CF functions
  // are controlled, so malformed types/length/OSStatus remain causal inputs.
  const bootstrap = `import ctypes,types,json
mode=${JSON.stringify(mode)}; released=[]; requested={}
OriginalPointer=ctypes.c_void_p
class Pointer(OriginalPointer):
 @classmethod
 def in_dll(cls,library,name):return cls(101 if name=='kSecCodeAttributeArchitecture' else 102)
ctypes.c_void_p=Pointer
raw=ctypes.create_string_buffer(b'\\x22'*32)
def number(value):return value.value if hasattr(value,'value') else value
def url_create(allocator,buffer,size,directory):
 requested['path']=ctypes.string_at(buffer,size).decode(); return 1
def string_create(allocator,value,encoding):
 requested['architecture']=value.decode(); requested['encoding']=encoding; return 2
def dictionary_create(allocator,keys,values,size,key_callbacks,value_callbacks):
 requested['attributeKey']=number(keys[0]); requested['attributeValue']=number(values[0]); return 3
def create_code(url,flags,attributes,output):
 if mode=='wrong architecture':return -67049
 output._obj.value=4; return 0
def check_code(code,flags,requirement):return -67062 if mode in ('invalid signature','primary and cleanup') else 0
def copy_info(code,flags,output):
 if mode=='copy failure':return -50
 output._obj.value=5; return 0
def type_id(value):
 return (99 if mode=='wrong dictionary' else 17) if number(value)==5 else (99 if mode=='wrong data' else 29)
def dictionary_value(info,key):
 requested['digestKey']=number(key); return None if mode=='missing data' else 6
def release(value):
 released.append(number(value))
 if mode=='primary and cleanup' and number(value)==4:raise RuntimeError('independent release failure')
def data_length(value):return 19 if mode=='short data' else 32 if mode=='long data' else 20
def data_bytes(value):return None if mode=='missing bytes' else ctypes.cast(raw,ctypes.POINTER(ctypes.c_uint8))
functions={'CFURLCreateFromFileSystemRepresentation':url_create,'CFStringCreateWithCString':string_create,
 'CFDictionaryCreate':dictionary_create,'CFDictionaryGetValue':dictionary_value,'CFGetTypeID':type_id,
 'CFDictionaryGetTypeID':lambda:17,'CFDataGetTypeID':lambda:29,'CFDataGetLength':data_length,
 'CFDataGetBytePtr':data_bytes,'CFRelease':release,'SecStaticCodeCreateWithPathAndAttributes':create_code,
 'SecStaticCodeCheckValidity':check_code,'SecCodeCopySigningInformation':copy_info}
ctypes.CDLL=lambda *args,**kwargs:types.SimpleNamespace(**functions)
`
  const result = await exec('/usr/bin/python3', ['-I', '-c', bootstrap + staticBridge + `
print(json.dumps({'released':released,'requested':requested,'pointerBytes':ctypes.sizeof(ptr),'CFIndexBytes':ctypes.sizeof(index)}))`,
    process.arch === 'x64' ? 'x86_64' : process.arch])
  const [observation, port] = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  evidence.push({ test: 'controlled-production-static-bridge', mode, observation, port })
  return { observation, port }
}

it.runIf(process.platform === 'darwin')('reads exact selected CFData from the inherited original FD and releases only Create/Copy owners', async () => {
  const { observation, port } = await controlledStatic('valid')
  expect(observation.primary).toBeNull()
  expect(observation.result).toEqual({ kind: 'security-static-code', architecture: process.arch === 'x64' ? 'x86_64' : process.arch,
    dictionaryKey: 'kSecCodeInfoUnique', dataType: 'CFData', byteLength: 20, cdHash: '22'.repeat(20), valid: true })
  expect(port.requested).toEqual({ path: '/dev/fd/3', architecture: process.arch === 'x64' ? 'x86_64' : process.arch,
    encoding: 0x08000100, attributeKey: 101, attributeValue: 2, digestKey: 102 })
  expect(port.released).toEqual([5, 4, 3, 2, 1])
  expect(observation.cleanup.every((owner: any) => owner.released)).toBe(true)
})
it.runIf(process.platform === 'darwin').each(['wrong architecture', 'invalid signature', 'copy failure', 'wrong dictionary',
  'missing data', 'wrong data', 'short data', 'long data', 'missing bytes'])('refuses %s in the actual static CF bridge', async mode => {
  const { observation, port } = await controlledStatic(mode)
  expect(observation.result).toBeNull()
  expect(observation.primary).toEqual(expect.objectContaining({ name: expect.any(String), message: expect.any(String) }))
  expect(port.released).toEqual(mode === 'wrong architecture' ? [3, 2, 1] :
    ['invalid signature', 'copy failure'].includes(mode) ? [4, 3, 2, 1] : [5, 4, 3, 2, 1])
})
it.runIf(process.platform === 'darwin')('keeps the primary CF failure while independently attempting every remaining release', async () => {
  const { observation, port } = await controlledStatic('primary and cleanup')
  expect(observation.primary.message).toContain('SecStaticCodeCheckValidity OSStatus=-67062')
  expect(observation.cleanup[0]).toMatchObject({ owner: 'static-code', released: false, error: { message: 'independent release failure' } })
  expect(port.released).toEqual([4, 3, 2, 1]); expect(observation.result).toBeNull()
})

it.runIf(process.platform === 'darwin')('matches the static bridge types and public API signatures to the actual Darwin SDK', async () => {
  const root = await mkdtemp(_reshape_fixturePath("tmp/amx-static-abi-")); roots.push(root)
  const file = join(root, 'abi.c'), binary = join(root, 'abi')
  await writeFile(file, `#include <Security/Security.h>
    #include <CoreFoundation/CoreFoundation.h>
    #include <stdio.h>
    int main(void) {
      CFURLRef (*url)(CFAllocatorRef,const UInt8*,CFIndex,Boolean)=CFURLCreateFromFileSystemRepresentation;
      OSStatus (*create)(CFURLRef,SecCSFlags,CFDictionaryRef,SecStaticCodeRef*)=SecStaticCodeCreateWithPathAndAttributes;
      OSStatus (*check)(SecStaticCodeRef,SecCSFlags,SecRequirementRef)=SecStaticCodeCheckValidity;
      OSStatus (*copy)(SecStaticCodeRef,SecCSFlags,CFDictionaryRef*)=SecCodeCopySigningInformation;
      (void)url;(void)create;(void)check;(void)copy;
      printf("{\\"pointer\\":%zu,\\"CFIndex\\":%zu,\\"CFTypeID\\":%zu,\\"OSStatus\\":%zu,\\"SecCSFlags\\":%zu,\\"Boolean\\":%zu,\\"UTF8\\":%u}",
        sizeof(void*),sizeof(CFIndex),sizeof(CFTypeID),sizeof(OSStatus),sizeof(SecCSFlags),sizeof(Boolean),kCFStringEncodingUTF8);
    }`)
  await exec('xcrun', ['clang', '-Werror', file, '-framework', 'Security', '-framework', 'CoreFoundation', '-o', binary])
  const sdk = JSON.parse((await exec(binary)).stdout)
  const definition = staticBridge.slice(0, staticBridge.indexOf('owners=[]'))
  const python = JSON.parse((await exec('/usr/bin/python3', ['-I', '-c', definition + `
print(json.dumps({'pointer':ctypes.sizeof(ptr),'CFIndex':ctypes.sizeof(index),'CFTypeID':ctypes.sizeof(type_id.restype),
 'OSStatus':ctypes.sizeof(create_code.restype),'SecCSFlags':ctypes.sizeof(create_code.argtypes[1]),
 'Boolean':ctypes.sizeof(url_create.argtypes[3]),'UTF8':0x08000100}))`])).stdout)
  expect(python).toEqual(sdk)
  evidence.push({ test: 'static-CF-SDK-ABI', sdk, actualBridge: python })
})

function readerPort() {
  const declaration = ast.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'staticCodeRead')!
  const child = Object.assign(new EventEmitter(), { pid: 731, stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true), unref: vi.fn() })
  const timers: { callback: () => void; delay: number; cleared: boolean }[] = []
  const spawn = vi.fn(() => child)
  const read = new Function('spawn', 'STATIC_CODE_IDENTITY_SOURCE', 'Buffer', 'setTimeout', 'clearTimeout',
    `return (${declaration.getText(ast)})`)(spawn, staticBridge, Buffer,
    (callback: () => void, delay: number) => { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer },
    (timer: typeof timers[number] | undefined) => { if (timer) timer.cleared = true })
  return { read, child, timers, spawn }
}
it('waits for the original static reader exit after accepted timeout signals and keeps unknown immutable', async () => {
  const port = readerPort(); let settled = false
  const pending = port.read({ fd: 71 }, 'arm64').then((receipt: any) => { settled = true; return receipt })
  expect(port.spawn).toHaveBeenCalledWith('/usr/bin/python3', ['-I', '-c', staticBridge, 'arm64'], { stdio: ['ignore', 'pipe', 'pipe', 71] })
  port.child.stdout.write('{"result":"a complete JSON response is not exit"}')
  port.timers[0]!.callback(); await Promise.resolve()
  expect(settled).toBe(false); expect(port.child.kill.mock.calls).toEqual([['SIGTERM']])
  port.timers[1]!.callback(); await Promise.resolve(); expect(settled).toBe(false)
  port.timers[2]!.callback(); const receipt = await pending
  expect(receipt).toMatchObject({ exitConfirmed: false, code: null, signal: null, interruption: 'timeout',
    signals: [{ name: 'SIGTERM', accepted: true }, { name: 'SIGKILL', accepted: true }], errors: [] })
  port.child.emit('exit', 0, null); port.child.emit('error', new Error('late reader error'))
  expect(receipt.exitConfirmed).toBe(false); expect(receipt.errors).toEqual([])
  expect(port.child.kill).toHaveBeenCalledTimes(2)
  expect(port.child.unref).toHaveBeenCalledOnce()
  expect(port.child.stdout.destroyed && port.child.stderr.destroyed).toBe(true)
  expect(port.child.listenerCount('exit')).toBe(0); expect(port.child.listenerCount('close')).toBe(0)
  expect(receipt.observerCleanup).toEqual(['reader-observer', 'reader-stdout', 'reader-stderr', 'reader-handle']
    .map(owner => ({ owner, released: true })))
  evidence.push({ test: 'controlled-original-static-reader-unknown', receipt })
})
it('never signals the original static reader after its confirmed natural exit', async () => {
  const port = readerPort(), pending = port.read({ fd: 71 }, 'arm64')
  port.child.emit('exit', 0, null); port.child.emit('close', 0, null); const receipt = await pending
  port.timers[0]!.callback()
  expect(receipt).toMatchObject({ exitConfirmed: true, code: 0, signal: null, interruption: null, signals: [] })
  expect(port.child.kill).not.toHaveBeenCalled(); expect(port.timers.every(timer => timer.cleared)).toBe(true)
  evidence.push({ test: 'controlled-original-static-reader-natural-exit', receipt })
})
it('drains original reader output after exit before accepting the complete response', async () => {
  const port = readerPort(); let settled = false
  const pending = port.read({ fd: 71 }, 'arm64').then((receipt: any) => { settled = true; return receipt })
  port.child.emit('exit', 0, null); await Promise.resolve()
  expect(settled).toBe(false)
  port.child.stdout.write('original response after process exit')
  port.child.emit('close', 0, null)
  expect(await pending).toMatchObject({ exitConfirmed: true, code: 0, signal: null,
    interruption: null, stdout: 'original response after process exit', signals: [] })
  expect(port.child.kill).not.toHaveBeenCalled()
})
it('keeps a reader error after spawn unknown until original exit while preserving synchronous signal refusal', async () => {
  const port = readerPort(); let settled = false
  const primary = Object.freeze(new Error('original reader stream error'))
  const refusal = Object.freeze(new Error('original reader signal refused'))
  port.child.kill.mockImplementation(() => { port.child.emit('error', refusal); return false })
  const pending = port.read({ fd: 71 }, 'arm64').then((receipt: any) => { settled = true; return receipt })
  port.child.emit('error', primary); await Promise.resolve()
  expect(settled).toBe(false); expect(port.child.unref).not.toHaveBeenCalled()
  port.timers[1]!.callback(); port.timers[2]!.callback()
  const receipt = await pending
  expect(receipt).toMatchObject({ originalPid: 731, exitConfirmed: false, interruption: 'reader-error',
    signals: [{ name: 'SIGTERM', accepted: false }, { name: 'SIGKILL', accepted: false }] })
  expect(receipt.errors).toEqual([primary, refusal, refusal])
  expect(port.child.unref).toHaveBeenCalledOnce()
  expect(port.child.stdout.destroyed && port.child.stderr.destroyed).toBe(true)
})
it('releases an original spawn-failed reader without asserting exit or sending signals', async () => {
  const port = readerPort(); (port.child as any).pid = undefined
  const primary = Object.freeze(new Error('original reader spawn failed'))
  const pending = port.read({ fd: 71 }, 'arm64'); port.child.emit('error', primary)
  expect(await pending).toMatchObject({ originalPid: null, exitConfirmed: false, signals: [], errors: [primary] })
  expect(port.child.kill).not.toHaveBeenCalled(); expect(port.child.unref).toHaveBeenCalledOnce()
})
it('keeps a missing pipe-close observation unknown without signalling an exited reader', async () => {
  const port = readerPort(), pending = port.read({ fd: 71 }, 'arm64')
  port.child.emit('exit', 0, null); port.timers[0]!.callback()
  const outcome = await Promise.race([pending.then((receipt: any) => ({ receipt })),
    new Promise(resolve => setImmediate(() => resolve({ missingReceipt: true })))])
  expect(outcome).toMatchObject({ receipt: { exitConfirmed: true, code: 0, signal: null, interruption: 'timeout', signals: [] } })
  expect(port.child.kill).not.toHaveBeenCalled()
})
