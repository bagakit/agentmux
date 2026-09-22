import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

// Classify `ps -axo pid=,command=` output for one installed AgentMux bundle.
//
// Three install steps ask about that bundle's processes — "is anything still
// running we must not clobber?" (quitInstalledApplication), "did the new
// bundle actually start?" (relaunchInstalledApplication) and "did a process
// from the PREVIOUS install survive?" (the survivor assertion). All three mean
// the same thing by "a process": one that is *serving* the bundle. The main
// process and the renderer/GPU/utility helpers each keep the old code alive
// and MUST count — that is the 2026-09-01 protection (an old instance kept
// serving out of the Trash by inode while every disk check passed).
//
// A crash-reporter helper does NOT serve the bundle. When the instance it
// belonged to exits, launchd reparents it (PPID 1) and it lingers, holding no
// user state and flushing nothing; it cannot serve UI. Counting it made a
// stale one block every future install (observed live 2026-09-13, pid 1033).
// External Electron-as-Node clients can share the Main executable. Only a
// bound OS mode observation and a complete ancestry outside the GUI distinguish
// them; Main's own Node workers and unknown future helpers remain protected.

// The crash-reporter executable's basename is stable across Electron versions.
// Match it in the *executable* position only: strip arguments first (they all
// begin with " -", and no bundle path segment — "AgentMux", "Electron
// Framework.framework", "AgentMux Helper (Renderer)" — contains " -", so the
// cut isolates the executable even though it contains spaces). A renderer/GPU/
// utility helper whose *arguments* mention the crash handler therefore stays
// classified as serving.
function executableOf(command) {
  const argStart = command.indexOf(' -')
  return argStart === -1 ? command : command.slice(0, argStart)
}

function isCrashReporter(command) {
  return executableOf(command).endsWith('/chrome_crashpad_handler')
}

/**
 * @param {string} psStdout  raw stdout of `ps -axo pid=,command=`
 * @param {{ executable: string, helperRoot: string }} bundle
 *   `executable` = <app>/Contents/MacOS/<PRODUCT_NAME>;
 *   `helperRoot` = <app>/Contents/Frameworks/ (trailing separator included)
 * @returns {{ serving: number[], crashReporter: number[] }}
 */
export function classifyApplicationProcesses(psStdout, { executable, helperRoot }) {
  const serving = []
  const crashReporter = []
  for (const line of psStdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    const command = match[2]
    const underBundle =
      command === executable ||
      command.startsWith(`${executable} `) ||
      command.startsWith(helperRoot)
    if (!underBundle) continue
    if (command.startsWith(helperRoot) && isCrashReporter(command)) {
      crashReporter.push(Number(match[1]))
    } else {
      serving.push(Number(match[1]))
    }
  }
  return { serving, crashReporter }
}

function processRows(psStdout) {
  const rows = psStdout.split('\n').filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line)
    assert(match, 'Application process birth observation is unavailable.')
    const uid = Number(match[1]), pid = Number(match[2]), ppid = Number(match[3])
    assert(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(ppid) && ppid >= 0)
    return { uid, pid, ppid, birth: match[4].replace(/\s+/g, ' '), command: match[5] }
  })
  assert(rows.length > 0, 'The OS process observation is empty.')
  return rows
}

/** Commands select the bundle; only bound mode and ancestry exclude external Node. */
export function snapshotApplicationProcesses(psStdout, bundle, { nodeModes = [], previousOwners = [] } = {}) {
  const rows = processRows(psStdout), byPid = new Map(rows.map(row => [row.pid, row]))
  const classified = classifyApplicationProcesses(rows.map(row => `${row.pid} ${row.command}`).join('\n'), bundle)
  const modes = new Map(nodeModes.map(row => [row.pid, row]))
  const node = new Set(rows.filter(row => {
    const mode = modes.get(row.pid)
    return (row.command === bundle.executable || row.command.startsWith(`${bundle.executable} `)) &&
      mode?.mode === 'node' && mode.executable === bundle.executable && mode.uid === process.getuid() && mode.uid === row.uid &&
      mode.birth === row.birth && mode.ppid === row.ppid
  }).map(row => row.pid))
  const original = previousOwners.filter(row => byPid.get(row.pid)?.birth === row.birth).map(row => row.pid)
  const protectedOwners = new Set([...classified.serving.filter(pid => !node.has(pid)), ...original])
  const externalNode = []
  for (const pid of node) {
    let parent = byPid.get(pid)
    const visited = new Set()
    while (parent && !protectedOwners.has(parent.pid) && !visited.has(parent.pid)) {
      visited.add(parent.pid)
      if (parent.pid === 1) { externalNode.push(pid); break }
      parent = byPid.get(parent.ppid)
    }
  }
  return { serving: [...new Set([...classified.serving.filter(pid => !externalNode.includes(pid)), ...original])],
    crashReporter: classified.crashReporter, externalNode,
    processes: rows.map(({ pid, ppid, birth }) => ({ pid, ppid, birth })) }
}

// KERN_PROCARGS2 separates argc/argv from the actual environment. The selected
// key is the only environment value returned; neither argv nor full env leaves
// this bounded child. ps birth/UID observations fence each kernel read.
const NODE_MODE_SOURCE = String.raw`
import ctypes,json,os,re,struct,subprocess,sys
lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
pids=[int(p) for p in sys.argv[1:]]
def identities():
 result=subprocess.run(['/bin/ps','-p',','.join(map(str,pids)),'-o','uid=,pid=,ppid=,lstart='],capture_output=True,text=True,timeout=2,env={**os.environ,'LC_ALL':'C'})
 if result.returncode not in (0,1):raise RuntimeError('identity unavailable')
 rows={}
 for line in result.stdout.splitlines():
  m=re.fullmatch(r'\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*',line)
  if not m:raise RuntimeError('invalid identity')
  rows[int(m[2])]={'pid':int(m[2]),'ppid':int(m[3]),'uid':int(m[1]),'birth':' '.join(m[4].split())}
 return rows
def read_mode(pid):
 size=ctypes.c_size_t(); maximum=ctypes.c_int(); size.value=ctypes.sizeof(maximum)
 if lib.sysctl((ctypes.c_int*2)(1,8),2,ctypes.byref(maximum),ctypes.byref(size),None,0)!=0:raise RuntimeError('argmax unavailable')
 if not 0<maximum.value<=2*1024*1024:raise RuntimeError('argmax out of bound')
 buf=ctypes.create_string_buffer(maximum.value);size.value=maximum.value
 if lib.sysctl((ctypes.c_int*3)(1,49,pid),3,buf,ctypes.byref(size),None,0)!=0:raise RuntimeError('process mode unavailable')
 raw=buf.raw[:size.value];argc=struct.unpack_from('i',raw)[0]; offset=4
 if not 0<=argc<=65536:raise RuntimeError('argc unavailable')
 def string():
  nonlocal offset
  end=raw.index(b'\0',offset);value=raw[offset:end];offset=end+1;return value
 executable=os.path.realpath(string().decode('utf-8'))
 while offset<len(raw) and raw[offset]==0:offset+=1
 for _ in range(argc):string()
 selected=[]
 while offset<len(raw):
  entry=string()
  if entry.startswith(b'ELECTRON_RUN_AS_NODE='):selected.append(entry.split(b'=',1)[1])
 return {'mode':'node' if selected==[b'1'] else 'gui' if not selected else 'unknown','executable':executable}
before=identities(); observations={}
for pid in pids:
 try:observations[pid]=read_mode(pid)
 except Exception:observations[pid]={'mode':'unknown'}
after=identities();result=[]
for pid in pids:
 identity=after.get(pid)
 if identity is not None:result.append({**identity,**(observations[pid] if before.get(pid)==identity and identity['uid']==os.getuid() else {'mode':'unknown'})})
print(json.dumps(result))
`

async function electronNodeModes(pids) {
  if (!pids.length) return []
  try {
    const result = await exec('/usr/bin/python3', ['-c', NODE_MODE_SOURCE, ...pids.map(String)],
      { timeout: 5_000, maxBuffer: 256 * 1024 })
    return JSON.parse(result.stdout)
  } catch { return [] } // Unknown stays protected. It is not proof of process exit.
}

async function osProcessSnapshot() {
  return (await exec('/bin/ps', ['-axo', 'uid=,pid=,ppid=,lstart=,command='],
    { timeout: 5_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })).stdout
}

/** Re-observe current OS owners after mode reads; an errno is never an exit fact. */
export async function observeApplicationProcesses(bundle, previousOwners = [],
  { processSnapshot = osProcessSnapshot, modes = electronNodeModes } = {}) {
  const first = processRows(await processSnapshot())
  const candidates = first.filter(row => row.command === bundle.executable || row.command.startsWith(`${bundle.executable} `))
  const nodeModes = await modes(candidates.map(row => row.pid))
  const scope = snapshotApplicationProcesses(await processSnapshot(), bundle, { nodeModes, previousOwners })
  return { ...scope, nodeModes: nodeModes.filter(mode => scope.processes.some(row =>
    row.pid === mode.pid && row.birth === mode.birth && row.ppid === mode.ppid)) }
}

/** Late helpers belong to the observed new Main; a launch-time PID list is not an owner. */
export function assertApplicationActivationOwnership({ previous, beforeLaunch, current, serving, mainPid }) {
  const before = new Map(beforeLaunch.map(row => [row.pid, row]))
  const after = new Map(current.map(row => [row.pid, row]))
  for (const row of previous) {
    assert(after.get(row.pid)?.birth !== row.birth,
      `A previous application owner is still running (pid ${row.pid}). Its old image cannot be declared replaced.`)
  }
  const main = after.get(mainPid)
  assert(main && main.birth && serving.includes(mainPid), 'The loaded Main has no current application process observation.')
  assert(before.get(mainPid)?.birth !== main.birth, 'The loaded Main existed before candidate launch; new activation is unconfirmed.')
  return serving.map(pid => {
    const owner = after.get(pid)
    assert(owner?.birth, `Application process birth is unavailable (pid ${pid}).`)
    assert(before.get(pid)?.birth !== owner.birth, `Application process ${pid} existed before candidate launch; its new ownership is unconfirmed.`)
    const visited = new Set()
    let parent = owner
    while (parent.pid !== mainPid) {
      assert(!visited.has(parent.pid), `Application process ancestry is cyclic (pid ${pid}).`)
      visited.add(parent.pid)
      parent = after.get(parent.ppid)
      assert(parent, `Application process ${pid} is not a confirmed descendant of the loaded Main.`)
    }
    return owner
  })
}
