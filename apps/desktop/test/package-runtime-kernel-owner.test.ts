import { fixtureTime as _reshape_fixtureTime, fixturePath as _reshape_fixturePath } from "../scripts/lib/fixture-values.mjs"
const _reshape_birthSeconds = Math.floor(_reshape_fixtureTime() / 1000)
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ts from 'typescript'
import { afterAll, expect, it } from 'vitest'

const exec = promisify(execFile)
const source = await readFile(new URL('../scripts/package-runtime-upgrade.mjs', import.meta.url), 'utf8')
const ast = ts.createSourceFile('owner.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
const declaration = ast.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
  .find(node => ts.isIdentifier(node.name) && node.name.text === 'CODE_IDENTITY_SOURCE')!
const initializer = declaration.initializer!
if (!ts.isTaggedTemplateExpression(initializer) || !ts.isNoSubstitutionTemplateLiteral(initializer.template))
  throw new Error('The actual kernel owner bridge source is unavailable.')
const bridge = initializer.template.text
const roots: string[] = [], evidence: unknown[] = []
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  if (process.env.T008_EVIDENCE_DIRECTORY) {
    await mkdir(process.env.T008_EVIDENCE_DIRECTORY, { recursive: true })
    await writeFile(join(process.env.T008_EVIDENCE_DIRECTORY, 'kernel-bridge.json'), JSON.stringify(evidence, null, 2) + '\n')
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
