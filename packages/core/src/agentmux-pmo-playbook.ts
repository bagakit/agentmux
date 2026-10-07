import { AGENTMUX_CLI_COMMANDS } from './agentmux-cli-commands.js'
import { goalRoleGuidance } from './goal-role-guidance.js'

function reference(method: string): string {
  const command = AGENTMUX_CLI_COMMANDS.find(entry => entry.method === method)
  if (!command) throw new Error(`PMO manual references an unregistered command: ${method}`)
  return `amux ${command.method.replaceAll('.', ' ')}${command.usage ? ' ' + command.usage : ''}`
}

/** Read-only document rendering; no service connection or user filesystem access. */
export function agentMuxPmoPlaybook(): { readOnly: true; format: 'markdown'; document: string } {
  return { readOnly: true, format: 'markdown', document: `# PMO working manual

PMO is a coordination role and working method. This manual describes choices; it does
not execute a workflow, open an Agent, deliver a task, register a role or edit SOUL/Wiki.

## Agree on the work

Clarify the user's goal, constraints, completion criteria and how completion will be
observed. Separate decisions from guesses. Use the original Goal owner for accepted
scope and activity; an Agent's delivery receipt does not complete the Goal.

${reference('goal.create')}
${reference('goal.inspect')}
${reference('goal.decisions')}
${reference('goal.activity')}

## Discover before assigning

${reference('app.snapshot')}
${reference('settings.executors.ls')}
${reference('agent.ls')}
${reference('space.ls')}
${reference('agent.role.ls')}
${reference('agent.role.resolve')}

Project is a real Host/directory resource. Space is a display context. Zone may be a Git
worktree, a plain directory, or a Topic/Mote resource; Tab and Region are presentations.
Use returned exact identities. Do not guess Project from Space, cwd or the current Tab.
Configured Executor and running Session are different facts. A failed source is unknown,
not an empty inventory. Topic/Mote and their SOUL/Wiki remain real filesystem materials.
Do not rewrite a user's material or invent a replacement registry when a source is absent.

## Open the first working surface from anywhere

${reference('agent.open')}

For an existing Zone, select --zone ZONE --new-tab --executor EXECUTOR --prompt TASK.
For a new Zone, explicitly supply --project PROJECT --space SPACE --new-zone; choose
--worktree --path PATH (--branch BRANCH|--new-branch BRANCH) or --directory PATH.
Use --source-workspace WORKSPACE only to resolve the real resource source within that
Project. No existing Tab anchor or current-Workspace navigation is required. Default
placement is background; --focus is a deliberate navigation request.

Keep one business --operation-id for the original request, separately from RPC wire IDs.
Retain the returned resource, Workspace/Zone, Tab/Region, exact SID/Run and initial-task
facts. Creation, placement, delivery and save are separate. Confirmed delivery means
the original delivery protocol completed; it does not prove accepted/started/finished work.

## Coordinate using original owners

${reference('agent.send')}
${reference('agent.discuss')}
${reference('agent.handoff')}
${reference('message.inbox.check')}
${reference('message.inbox.ack')}
${reference('message.dispatch.inspect')}
${reference('goal.assign')}
${reference('goal.handoff')}
${reference('goal.delegate')}
${reference('goal.delegations')}
${reference('goal.report')}
${reference('goal.collect')}

Assign an owner with concrete input and acceptance evidence. Hand off communication
without silently completing an external Task. Keep message/thread/reply identities.
Role registration is a separate explicit authorized action, never a step this manual runs.

${goalRoleGuidance({ role: 'manager' })}

## Name the actual working Sessions

${reference('agent.inspect')}
${reference('agent.rename')}
${reference('space.state')}
${reference('space.rename')}
${reference('name.history')}
${reference('name.confirm')}

Give your discussion and the unnamed Sessions explicitly entrusted to this work concise
topic-and-responsibility names. Inspect displayName.source and nameRevision on the exact
Session; inspect the original Tab label in space state. Use --derived for autonomous
suggestions so the original owner preserves manual names, manual clears, launch names and
retained intent. Refine a temporary derived name when the topic becomes clear. An explicit
edit without --derived keeps its original semantics; neither mode authenticates a human.
Read back the exact operation and current name after an unknown reply, without replaying
the edit. Applied display names, disk acknowledgement and native Provider synchronization
are separate results. A failed naming step never stops healthy work or replaces a Session.

## Observe and adjust the display

${reference('agent.inspect')}
${reference('agent.output')}
${reference('space.inspect')}
${reference('space.mv')}
${reference('app.focus')}
${reference('space.focus')}
${reference('goal.focus')}

space mv moves the exact source presentation, not execution: SID/Run/Host/cwd and other
views remain. Navigation, actual presentation and input caret eligibility have separate
receipts. Preserve Mote conversation drafts and composition. Canceling an output reader
does not stop the Agent; stopping an Agent is an explicit separate lifecycle action.

## Recover an unknown receipt

Read back space inspect --operation-id OPERATION for retained spatial facts, and exact
Agent/Browser/Toolkit identities for their original owner facts. A current observation
does not certify a previous lost response. Do not automatically re-create worktrees,
start another Run, repeat a move or re-deliver the first task. Partial results retain
created resources and healthy Agents. Unknown startup facts retain durable work surfaces.
Explain the failed step, current known state and recovery action without inventing success
or stopping a healthy Run because a handshake or observation failed.
` }
}
