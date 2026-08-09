from pathlib import Path
import subprocess,json
root=Path.cwd()
out=Path(__file__).resolve().parent
out.mkdir(exist_ok=True)
mutations=[
 ('exports-dropped','apps/desktop/src/main/login-shell-environment.ts','    Object.assign(env, parsed)','    env.PATH = parsed.PATH','apps/desktop/test/login-shell-environment.test.ts'),
 ('interactive-config-skipped','apps/desktop/src/main/login-shell-environment.ts',"[['-ilc', command], ['-lc', command]]", "[['-lc', command], ['-lc', command]]",'apps/desktop/test/login-shell-environment.test.ts'),
 ('partial-success-silent','apps/desktop/src/main/login-shell-environment.ts',"result.mode === 'interactive-login' ? undefined",'true ? undefined','apps/desktop/test/login-shell-environment.test.ts'),
 ('stale-daemon-environment','packages/core/src/ctxmux-run-adapter.ts','env: { ...localProcessEnvironment(), ...input.env }','env: input.env ?? {}','packages/core/test/run-environment.test.ts'),
 ('explicit-override-lost','packages/core/src/ctxmux-run-adapter.ts','env: { ...localProcessEnvironment(), ...input.env }','env: { ...input.env, ...localProcessEnvironment() }','packages/core/test/run-environment.test.ts'),
 ('snapshot-notice-lost','apps/desktop/src/renderer/src/store.ts','initialSnapshotResult.value.environmentWarning ?? null','null','apps/desktop/test/shell-environment-notice.test.tsx'),
 ('service-window-hidden','apps/desktop/src/renderer/src/components/ShellEnvironmentNotice.tsx','notice={warning ? {','notice={false ? {','apps/desktop/test/shell-environment-notice.test.tsx')
]
results=[]
for name,file,old,new,test in mutations:
 p=root/file;s=p.read_text()
 if s.count(old)!=1:raise RuntimeError(f'{name}: target is not unique')
 changed=s.replace(old,new,1);p.write_text(changed)
 try:
  r=subprocess.run(['pnpm','exec','vitest','run',test],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
  (out/f'mutation-{name}.log').write_text(r.stdout)
  killed=r.returncode!=0 and 'AssertionError' in r.stdout
  results.append({'name':name,'file':file,'test':test,'killed':killed})
  print(name,killed,flush=True)
 finally:
  if p.read_text()!=changed: raise RuntimeError('Concurrent edit: restore only mutation manually')
  p.write_text(s)
 (out/'mutations.json').write_text(json.dumps(results,indent=2)+'\n')
 if not killed:raise RuntimeError('mutation survived')
