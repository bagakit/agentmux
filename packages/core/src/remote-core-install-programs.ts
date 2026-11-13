/** Programs the first Core install runs on a remote Host. Each is passed as argv by
 * ExecutionHost; parameters arrive as JSON on stdin, never through shell text. */

/** Read-only: can this Host take a first install under this prefix? Uses only
 * python3, which the upgrade inspection already requires on the remote. */
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
 try:
  run=lambda *args: subprocess.run(list(args),capture_output=True,text=True,timeout=10)
  if run('systemctl','--user','show-environment').returncode!=0: return {'user':False,'linger':None}
  shown=run('loginctl','show-user',os.environ.get('USER') or str(os.getuid()),'--property=Linger')
  linger=shown.stdout.strip().split('=',1)[1]=='yes' if shown.returncode==0 and '=' in shown.stdout else None
  return {'user':True,'linger':linger}
 except (FileNotFoundError,subprocess.TimeoutExpired): return {'user':False,'linger':None}
installed=os.path.join(prefix,'state','core-releases','current')
existing=prefix
while not os.path.exists(existing): existing=os.path.dirname(existing)
space=os.statvfs(existing)
print(json.dumps({'platform':sys.platform,'machine':platform.machine(),'glibc':glibc(),'home':home,'prefix':prefix,
 'user':os.environ.get('USER') or '','installed':os.path.lexists(installed),'socket':listening(os.path.join(prefix,'runtime','control.sock')),
 'prefixEntries':sorted(os.listdir(prefix))[:20] if os.path.isdir(prefix) else None,'availableBytes':space.f_bavail*space.f_frsize,'systemd':systemd()}))
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
 unit=path.join(dir,'agentmux-core.service');
 write(unit,'[Unit]\nDescription=AgentMux headless Core\n\n[Service]\nType=simple\nExecStart='+path.join(prefix,'serve.sh')+'\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n',0o644);
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
 try{const {owner}=await rpc.call('runtime.owner.identity',{},{signal:AbortSignal.timeout(20000)});console.log(JSON.stringify({owner}));}
 finally{await rpc.dispose();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
`
