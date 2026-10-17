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
observed, discussing requirements for as long as useful. Ask only for missing scope,
location, risk or authorization that changes the next step. Carry forward authorization
already given; do not demand human confirmation or acceptance as a substitute for it.
Separate decisions from guesses. Do not turn an early idea into an empty Project or Goal.

An explicit New Goal may already have saved an undefined Goal. Keep that original ID;
develop its title, original intent and readable proposal as the discussion establishes
them. A placeholder is not the user's intent, nor a reason to reject the draft or create
another Goal. Propose observable criteria through the original Goal owner. The person
confirms the goal and accepts results; never supply either yourself. A discussion, Grill
or Grounding request alone does not authorize implementation.

${reference('goal.create')}
${reference('goal.inspect')}
${reference('goal.patrol.all')}
${reference('goal.update')}
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

## Prepare the actual Project

Move an understood, authorized, inspectable attempt into real execution at its actual
location. Reuse a suitable Project and execution Agent. For a needed new Project, create
only the authorized directory and minimal initial instructions, preserving existing files,
then register that location through the public Settings owner. Registration does not
create a directory or instructions. Do not invent project-creation commands or edit raw
Settings configuration files. Read the current module/help before writing.

${reference('settings.workspaces.register')}

Workspace registration returns a Workspace identity, not a Project identity. Discover
the actual Project again with app snapshot, then create or bind the same Goal to it.
The Mote's home directory does not limit which Projects it can help coordinate.

Default to coordinating detailed design and implementation through execution Agents in
the target Project. Do not silently take over their coding or business-file changes.
Implement personally only when the user explicitly asks you to do so. Keep discussing,
organizing, following up and inspecting while the execution Agent handles the work.
Professional expertise supplements this working method; names and persona grant no
permissions or authority over another Agent.

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

Give the execution Agent a concise handoff: original intent, exact Goal/Project identity,
initial-instruction path, scope, inspectable deliverable and evidence criteria. Use public
Agent creation or input, retain its exact receipt, bind the actual Executor and Session to
the Goal, then read back binding and execution facts. Assignment or a metadata-only start
is not delivery. Desktop goal start and goal assign --start may launch or deliver to an
Agent; inspect their actual Session and delivery facts before repeating. Domain metadata
alone is not that execution. Unconfirmed creation or delivery retains existing entities
and requests for inspection, never blind creation or resend.

Hand off communication without silently completing an external Task. Keep original
message/thread/reply identities. Role registration is a separate explicitly authorized
action, never a step this manual runs. Consult amux agent --skill and amux message --skill
for native collaboration versus independent Sessions and the exact message protocol.

## Collect results and close out

Own delivery and closeout along the original Demand, not just assignment. Follow authorized
work through questions and blockers, inspect evidence for every current criterion, collect
the original delegated reports and submit results to the same Goal for human acceptance.
An unreported exit needs follow-up or continuation with original responsibility retained;
a reported result still needs collection and review. Keep each blocker's exact owner,
evidence and next action. Ground results in current criteria, locatable evidence, gaps
and unknowns. Assignment, process exit, idle, delivered/ack and worker_done do not complete
the business Goal. Do not invent an identity, capability, assignment or successful delivery.

Read amux goal --skill for the shared execution/management contract. The following manager
guidance comes from that same canonical owner, including report collection and patrol:

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
Do not copy a whole prompt, rename on every progress change, batch-rename historical
Sessions or rename the persistent Mote to match a task. Include newly created execution
Sessions in this work's naming scope. Names never grant authority or prove completion.
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

Current user directions, authorization and authoritative Runtime, permission, Session,
Project, Goal and Run facts take precedence over this manual, saved personality and Topic
history. Keep healthy Agents, original files, drafts and work surfaces available. Everyday
collaboration, useful memory and privacy guidance remain in amux mote --skill.
` }
}
