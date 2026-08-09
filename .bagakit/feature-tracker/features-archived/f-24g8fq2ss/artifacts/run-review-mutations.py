from pathlib import Path
import subprocess,json,time
root=Path.cwd()
artifacts=Path(__file__).resolve().parent
mutations=[
('cancelled-observation-blocks', 'packages/core/src/prompt-submission.ts', "(error.code !== 'OUTPUT_GAP' && error.code !== 'AGENT_PROMPT_RENDER_TIMEOUT' &&\n          error.code !== 'AGENT_PROMPT_READINESS_CANCELLED')", "(error.code !== 'OUTPUT_GAP' && error.code !== 'AGENT_PROMPT_RENDER_TIMEOUT')", 'packages/core/test/client-submit-prompt-interrupted.test.ts'),
('stale-screen-accepted','packages/core/src/agent-terminal-screen.ts','? this.screen.throughByte > options.boundaryByte','? this.screen.throughByte >= options.boundaryByte','packages/core/test/agent-terminal-screen.test.ts'),
('snapshot-notice-lost','apps/desktop/src/main/runtime-controller.ts','terminalPromptDelivery: structuredClone(subject.agentSession.terminalPromptDelivery)','lostPromptDelivery: structuredClone(subject.agentSession.terminalPromptDelivery)','apps/desktop/test/runtime-controller.test.ts'),
('live-notice-lost','apps/desktop/src/renderer/src/lib/session-state.ts','terminalPromptDelivery: structuredClone(core.session.terminalPromptDelivery)','lostPromptDelivery: structuredClone(core.session.terminalPromptDelivery)','apps/desktop/test/prompt-delivery-service-window.test.tsx'),
('live-notice-never-clears','apps/desktop/src/renderer/src/lib/session-state.ts','              terminalPromptDelivery: _terminalPromptDelivery,\n','','apps/desktop/test/prompt-delivery-service-window.test.tsx'),
('focus-nonce-reused','apps/desktop/src/renderer/src/store.ts','nonce: ++regionCaretFocusNonce','nonce: (state.regionCaretFocus?.nonce ?? 0) + 1','apps/desktop/test/region-caret-focus.test.ts'),
('pointer-keeps-obsolete-focus','apps/desktop/src/renderer/src/store.ts',': { regionCaretFocus: null })',': {})','apps/desktop/test/region-caret-focus.test.ts'),
('async-editor-drops-focus','apps/desktop/src/renderer/src/components/EditorPane.tsx','              consumeCaretFocus()\n','','apps/desktop/test/editor-caret-focus.test.tsx'),
('board-refresh-detached','apps/desktop/src/renderer/src/hooks/useBoardRows.ts','snapshot, topics, loadError, topicsError, refresh,','snapshot, topics, loadError, topicsError, refresh: async () => false,','apps/desktop/test/board-data-flow.test.tsx'),
('topic-workspace-leak','apps/desktop/src/renderer/src/hooks/useScratchTopics.ts','state?.workspaceId === workspaceId && workspaceId !== null','state !== null && workspaceId !== null','apps/desktop/test/board-data-flow.test.tsx'),
('quadratic-topic-copy','apps/desktop/src/renderer/src/lib/project-board.ts','    const group = byTopic.get(topicId)\n    if (group) group.push(session)\n    else byTopic.set(topicId, [session])','    byTopic.set(topicId, [...(byTopic.get(topicId) ?? []), session])','apps/desktop/test/topic-board.test.ts'),
('noop-avatar-button','apps/desktop/src/renderer/src/components/SelectorList.tsx','onOpen={agent.onOpen}','onOpen={agent.onOpen ?? (() => {})}','apps/desktop/test/selector-avatar-interaction.test.tsx')
]
results=[]
for name,file,old,new,test in mutations:
 p=root/file;source=p.read_text()
 if source.count(old)!=1: raise RuntimeError(f'{name}: expected unique target')
 changed=source.replace(old,new,1);p.write_text(changed)
 try:
  run=subprocess.run(['pnpm','exec','vitest','run',test],cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  (artifacts/f'mutation-{name}.log').write_text(run.stdout)
  killed=run.returncode!=0 and 'AssertionError' in run.stdout
  results.append({'mutation':name,'source':file,'test':test,'exit_code':run.returncode,'killed':killed})
  print(name, 'KILLED' if killed else 'NOT PROVEN',flush=True)
 finally:
  current=p.read_text()
  if current==changed:p.write_text(source)
  elif new and current.count(new)==1:p.write_text(current.replace(new,old,1))
  else: raise RuntimeError(f'{name}: concurrent edit detected; source needs targeted restoration')
 (artifacts/'mutations.json').write_text(json.dumps(results,indent=2)+'\n')
 if not killed:raise RuntimeError(f'{name}: mutant not killed by assertion')
