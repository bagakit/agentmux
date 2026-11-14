/** Programs the first Core install runs on a remote Host. Each is passed as argv by
 * ExecutionHost; parameters arrive as JSON on stdin, never through shell text. */

/** Read-only: can this Host take a first install under this prefix? Uses only
 * Python 3.6-compatible stdlib, also used by the upgrade inspection. */
export const PROBE_CORE_INSTALL = String.raw`
import json,os,sys,platform,socket,subprocess,stat
p=json.loads(sys.stdin.read()); home=os.path.expanduser('~')
prefix=p['prefix'] if p.get('prefix') else os.path.join(home,'.agentmux','server')
prefix=os.path.abspath(os.path.expanduser(prefix))
def glibc():
 try:
  name,version=platform.libc_ver()
  return version if name=='glibc' and version else None
 except Exception: return None
def listening(path):
 try: target=os.lstat(path)
 except FileNotFoundError: return 'absent'
 if not stat.S_ISSOCK(target.st_mode): return 'other-file'
 s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.settimeout(1)
 try: s.connect(path); return 'serving'
 except (ConnectionRefusedError,FileNotFoundError): return 'stale'
 except Exception: return 'unknown'
 finally: s.close()
def systemd():
 unit_available=not os.path.lexists(os.path.join(home,'.config','systemd','user','agentmux-core.service'))
 run=lambda *args: subprocess.run(list(args),stdout=subprocess.PIPE,stderr=subprocess.PIPE,universal_newlines=True,timeout=10)
 try:
  if run('systemctl','--user','show-environment').returncode!=0: return {'user':False,'linger':None,'unitAvailable':unit_available}
 except (FileNotFoundError,subprocess.TimeoutExpired): return {'user':False,'linger':None,'unitAvailable':unit_available}
 try:
  unit=run('systemctl','--user','show','agentmux-core.service','--property=LoadState','--value')
  unit_available=unit_available and unit.stdout.strip()=='not-found' and unit.returncode in (0,1)
 except (FileNotFoundError,subprocess.TimeoutExpired): unit_available=False
 try:
  shown=run('loginctl','show-user',os.environ.get('USER') or str(os.getuid()),'--property=Linger')
  linger=shown.stdout.strip().split('=',1)[1]=='yes' if shown.returncode==0 and '=' in shown.stdout else None
 except (FileNotFoundError,subprocess.TimeoutExpired): linger=None
 return {'user':True,'linger':linger,'unitAvailable':unit_available}
releases=os.path.join(prefix,'state','core-releases')
installed=any(os.path.lexists(os.path.join(prefix,entry)) for entry in ['bin/amux','start.sh','serve.sh','state/semantic-runtime.json','state/agent-sessions.json']) or os.path.lexists(os.path.join(releases,'current')) or (os.path.isdir(releases) and bool(os.listdir(releases)))
existing=prefix
while not os.path.exists(existing): existing=os.path.dirname(existing)
space=os.statvfs(existing)
print(json.dumps({'platform':sys.platform,'machine':platform.machine(),'glibc':glibc(),'home':home,'prefix':prefix,
 'user':os.environ.get('USER') or '','installed':installed,'socket':listening(os.path.join(prefix,'runtime','control.sock')),
 'availableBytes':space.f_bavail*space.f_frsize,'systemd':systemd()}))
`

/** Unpacks the pinned Node into <prefix>/node/<version> once, from a base64 archive on
 * stdin, after checking its digest. Runs under /bin/sh with only tar, base64 and
 * sha256sum, because no Node exists yet on a first install. */
export const INSTALL_NODE = String.raw`
set -eu
prefix="$1" version="$2" digest="$3"
case "$prefix" in /*) ;; *) echo "The install prefix must be absolute." >&2; exit 2 ;; esac
node_dir="$prefix/node/$version"
if [ -x "$node_dir/bin/node" ]; then "$node_dir/bin/node" --version >/dev/null && { printf '{"node":"%s"}\n' "$node_dir/bin/node"; exit 0; }; fi
umask 077; mkdir -p "$prefix/node"; chmod 700 "$prefix"
partial="$node_dir.partial"; rm -rf "$partial"; mkdir "$partial"
base64 -d > "$partial/node.tar.gz"
actual="$(sha256sum "$partial/node.tar.gz" | cut -d' ' -f1)"
[ "$actual" = "$digest" ] || { rm -rf "$partial"; echo "The Node archive does not match its pinned digest." >&2; exit 1; }
tar -xzf "$partial/node.tar.gz" -C "$partial" --strip-components=1
rm -f "$partial/node.tar.gz"; rm -rf "$partial/include" "$partial/share" "$partial/lib/node_modules" "$partial/bin/npm" "$partial/bin/npx" "$partial/bin/corepack"
"$partial/bin/node" --version >/dev/null
mv "$partial" "$node_dir"
printf '{"node":"%s"}\n' "$node_dir/bin/node"
`

/** Writes the stable entry, the start script and, when chosen, a user systemd unit, in
 * the same layout as the Linux release installer; then starts the Core once. */
export const INSTALL_SERVICE = String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const p=JSON.parse(fs.readFileSync(0,'utf8')),q=s=>"'"+s.replaceAll("'","'\\''")+"'",D='$';
const unitPath=path.join(p.home,'.config','systemd','user','agentmux-core.service');
if(p.keepRunning==='systemd' && fs.existsSync(path.dirname(unitPath)) && fs.readdirSync(path.dirname(unitPath)).includes(path.basename(unitPath)))throw Error('An existing AgentMux user service was preserved. Choose the start script or inspect that service.');
if(p.keepRunning==='systemd'){
 const existing=cp.spawnSync('systemctl',['--user','show','agentmux-core.service','--property=LoadState','--value'],{encoding:'utf8',timeout:10000});
 if(![0,1].includes(existing.status)||existing.stdout.trim()!=='not-found')throw Error('The named AgentMux user service already exists or could not be confirmed absent. Its original service was left unchanged.');
}
const prefix=p.prefix,state=path.join(prefix,'state'),runtime=path.join(prefix,'runtime'),current=path.join(state,'core-releases','current');
const write=(file,text,mode)=>{const partial=file+'.partial';fs.writeFileSync(partial,text,{mode});fs.renameSync(partial,file);};
fs.mkdirSync(path.join(prefix,'bin'),{recursive:true,mode:0o700});fs.mkdirSync(runtime,{recursive:true,mode:0o700});
write(path.join(prefix,'bin','amux'),'#!/bin/sh\nexec '+q(path.join(current,'launcher','amux'))+' "$@"\n',0o755);
const env=['HOME="$HOME"','PATH='+q(path.dirname(p.node))+':"$PATH"','SHELL="'+D+'{SHELL:-/bin/sh}"','LANG="'+D+'{LANG:-C.UTF-8}"',
 'AGENTMUX_STATE_DIRECTORY='+q(state),'AGENTMUX_RUNTIME_DIRECTORY='+q(runtime),'AGENTMUX_AGENT_SESSION_STORE='+q(path.join(state,'agent-sessions.json'))].join(' ');
const serve='release="$(readlink -f '+q(current)+')"\nname="'+D+'{release##*/}"\ncase "$name" in *[!0-9a-f]*|\'\') name=\'\' ;; esac\n'+
 'if [ "'+D+'{#name}" -ne 64 ]; then echo "The current release is not installed." >&2; exit 1; fi\ncd "$HOME"\n';
write(path.join(prefix,'start.sh'),'#!/bin/sh\n# Starts this machine\'s AgentMux headless Core unless one is already serving.\nset -eu\n'+
 'if '+q(path.join(prefix,'bin','amux'))+' --endpoint '+q('unix:'+path.join(runtime,'control.sock'))+' system endpoint --inspect >/dev/null 2>&1; then exit 0; fi\n'+serve+
 'env -i '+env+' setsid '+q(p.node)+' "$release/dist/headless-runtime-cli.js" serve >> '+q(path.join(state,'serve.log'))+' 2>&1 < /dev/null &\n',0o755);
let unit=null;
if(p.keepRunning==='systemd'){
 const dir=path.join(p.home,'.config','systemd','user');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 // The unit runs the same release resolution as start.sh, in the foreground, so systemd owns the process.
 write(path.join(prefix,'serve.sh'),'#!/bin/sh\nset -eu\n'+serve+'exec env -i '+env+' '+q(p.node)+' "$release/dist/headless-runtime-cli.js" serve\n',0o755);
 unit=unitPath;
 const unitText='[Unit]\nDescription=AgentMux headless Core\n\n[Service]\nType=simple\nExecStart='+JSON.stringify(path.join(prefix,'serve.sh')).replaceAll('%','%%')+'\nKillMode=process\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n';
 // Publish the complete unit exclusively: a concurrent install or user service is never overwritten.
 const staging=fs.mkdtempSync(path.join(dir,'.agentmux-unit-'));
 try{const candidate=path.join(staging,'unit');fs.writeFileSync(candidate,unitText,{mode:0o644});fs.linkSync(candidate,unit);}finally{fs.rmSync(staging,{recursive:true,force:true});}
 for(const args of [['--user','daemon-reload'],['--user','enable','--now','agentmux-core.service']]){
  const done=cp.spawnSync('systemctl',args,{encoding:'utf8',timeout:30000});
  if(done.status!==0)throw Error('systemctl '+args.join(' ')+' failed: '+(done.stderr||done.error?.message||'').trim());
 }
}else{
 const done=cp.spawnSync('/bin/sh',[path.join(prefix,'start.sh')],{encoding:'utf8',timeout:30000});
 if(done.status!==0)throw Error('start.sh failed: '+(done.stderr||'').trim());
}
console.log(JSON.stringify({remoteCommand:path.join(prefix,'bin','amux'),remoteSocketPath:path.join(runtime,'control.sock'),startScript:path.join(prefix,'start.sh'),unit}));
`

/** Reads the public owner identity of the newly started Core through its own client. */
export const READ_INSTALLED_OWNER = String.raw`
const fs=require('node:fs'),path=require('node:path'),url=require('node:url');
const p=JSON.parse(fs.readFileSync(0,'utf8'));
void(async()=>{
 const {connectAgentMuxRpc}=await import(url.pathToFileURL(path.join(p.releaseDirectory,'dist','public-rpc-client.js')).href);
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:p.socket}});
 try{
  const {owner}=await rpc.call('runtime.owner.identity',{},{signal:AbortSignal.timeout(20000)});
  if(!Number.isSafeInteger(owner.processId)||owner.processId<1)throw Error('The new Core process identity is unconfirmed.');
  const base='/proc/'+owner.processId,argv=fs.readFileSync(base+'/cmdline','utf8').split(String.fromCharCode(0)).slice(0,-1);
  const expected=fs.realpathSync(path.join(p.releaseDirectory,'dist','headless-runtime-cli.js'));
  if(argv.length!==3||argv[2]!=='serve'||fs.realpathSync(argv[1])!==expected)throw Error('The responding Core runs another release.');
  const env=Object.fromEntries(fs.readFileSync(base+'/environ','utf8').split(String.fromCharCode(0)).filter(Boolean).map(item=>{const at=item.indexOf('=');return [item.slice(0,at),item.slice(at+1)];}));
  if(env.AGENTMUX_STATE_DIRECTORY!==path.dirname(path.dirname(p.releaseDirectory))||env.AGENTMUX_RUNTIME_DIRECTORY!==path.dirname(p.socket))throw Error('The responding Core serves another namespace.');
  console.log(JSON.stringify({owner}));
 }
 finally{await rpc.dispose();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
`
