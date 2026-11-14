# Remote work

<!-- amux:content -->
## Choose where the project and Agent work

Hosts are the connection foundation in Settings → Cluster → Hosts. Remote work
uses those saved Hosts. Preparation can read the selected Host’s home through its
saved connection; it does not automatically install, upgrade, approve or start an Agent.

For project work, choose the project, then choose its Agent. The project Launcher
defaults to an Agent on the project's own device, even when you view that project
from another machine. Outpost selects an Agent elsewhere and keeps the project fixed.

The global Remote setup also explains these access scenarios from this Desktop:

| Mode | Agent runs | Project files and commands |
| --- | --- | --- |
| Local | On this device | On this device |
| Reach · Remote Project | On this device | On the remote Host |
| Outpost · Remote Agent | On the remote Host | On this device |
| Orbit · Remote Workspace | Remotely | Remotely, on the Agent Host by default |

Remote Workspace keeps computation and the project off this device. It does not enable
continuous autonomous tasks or change access permissions. Existing arrangements with two
different remote Hosts keep their exact two ends; the screen names each Host.

These choices belong to the person in Desktop. An Agent does not make them on the
person's behalf. The equivalent explicit split-workspace flags also require an
authenticated user or device; do not assume that identity.

## Working through another Host

Project and Agent placement, the tool execution path, and this viewer's access
paths are different facts. Suppose A views a project on B, B connects to C, and
C connects to D. The project remains on B. With an explicit authorized route to
D, choosing Outpost for that project selects D's Agent; C is only an intermediate
node. The workflow remains choose project, choose Agent. Viewing it from A does
not change those two execution ends.

The compact Run mode identity shows the project and Agent together. Its detail
separates the execution route from this client's access channels. A known SSH
channel or ProxyJump configuration cannot prove the tool route or its hop count.
Unobserved paths remain unconfirmed. Connections do not pass on trust or permissions.

Currently, B's public service can use C when C is configured there. A Desktop
does not automatically import B's Hosts or establish an A/C workflow from those
two connections. Configure and verify a route to C in the current entry point
before using it. An SSH jump host can carry an explicitly configured route; that
configuration alone does not prove a working end-to-end connection.

## Start work

Open New Tab or New Agent for the project, then use Agent location beside Agent
to choose Project device or Outpost. A project Launcher keeps its working folder;
Project device uses that project's Host, and Outpost chooses another exact Agent
Host. A remote project offers the same choices. Settings → Cluster → Remote first shows existing work;
choose Set up new work when you want to prepare an Agent. Connecting to or browsing
a Host does not require a project.

In the global setup, choose a mode, the working folder and the Agent device. The working folder is where
this task's files and commands live. Use an exact saved folder, or choose The device
home and its device; preparation reads that device's confirmed home and registers
the original folder. A generic Agent does not need a business project first. For separate execution,
the Agent startup directory defaults to that Host's confirmed home and may be another
registered directory there; it does not need a project copy. Register another missing
folder through its original Host entry rather than guessing a same-named local path.

Review the Agent and Project ends, then Apply arrangement in the Launcher or Open in
Launcher from Settings. This only prepares the original target. Choose an Agent from
that Host's configuration, enter your task and explicitly Launch. Nothing starts while
you browse settings or edit the arrangement.

In a Goal's New Agent flow, prepare the same locations first, choose the configuration
on that Agent Host, then explicitly Create Agent. Creation sends no task; save its
Goal relationship separately through the original Goal flow.

The task, names and launch options remain editable and retained. Cancel or preparation
failure preserves the original arrangement; retry the exact failed target, not a guessed
replacement. A later selection cannot be overwritten by an older reply. Existing Agents
keep their original execution binding.

## Continue existing work

Every non-local Agent identity shows its relative work mode; inspect that label to read
the exact Agent and Project Hosts and paths. Moving its display does not move execution.
The Existing work view in Remote includes both split-tool bindings and ordinary remote Sessions.
Open original work returns to that exact Session. Resume original and tool rejoin keep
the original identities; Refresh observation only rereads the relevant facts.

If an operation result is unknown, inspect the original operation instead of creating a
replacement Agent or repeating its input. Connection issues do not require closing
healthy work. Mode labels explain placement, not connectivity, permission or completion.

## Environments and permissions

Files and commands belong to the project side. Native login, settings, Hooks
and Skills load from the Agent device; they are not automatically
copied between machines. Read file contents and tool results can enter the
Agent's context. Selecting a project folder is not an operating-system sandbox.

Check the selected Provider's capability notices and native permission prompts.
A connected tool channel does not prove every Hook, Skill or child Agent mode is
supported. The [Core capability scope](../../README.md#agent-与工具分端执行)
describes the current adapters and their limits.

## CLI

The existing `agent open` command uses `--execution-workspace AGENT_WORKSPACE`
and `--tool-workspace RESOURCE_WORKSPACE` for the same separation. This creation
mode requires an authenticated user/device; a managed Agent cannot assume that
identity. Read `agent open --help` for exact parameters and `space --skill` before
choosing a display destination. `agent execution --help` describes original
binding observation and operation inspection.


### Continue the original split-work request

Core prepares the resource helper and the Agent-side helper before starting either.
A required preparation failure retains the original intent and reports its exact Host,
helper role and step in `error.executionFailure`. This does not stop existing Agents.
An optional upgrade observation is advice; updating Core does not itself prove that
preparation, creation or the first input succeeded.

Use `amux agent execution binding --input FILE` at the original Coordinator to read
its retained `continuation` reference and `helperStarts`. Start facts describe submission
and acknowledgement, not current Run health. After fixing the exact endpoint, explicitly
run `amux agent execution continue --input FILE`, with only:

```json
{"bindingId":"ORIGINAL_BINDING","agentSessionId":"ORIGINAL_SESSION","createOperationId":"ORIGINAL_CREATE"}
```

An older Desktop failure may retain its typed request without this formal reference.
Its visible original workface and Check original read the same Coordinator's stored
intent using only the frozen Session/create/Host and tool location. A matching existing
intent can supply its reference; an error message or edited configuration cannot.
Missing identity stays unknown. This read does not start helpers, continue creation or
send input; finding an intent does not qualify the current endpoints. Continue remains
an explicit separate action on the same original request.

Core loads the frozen input; do not supply a new prompt, directory, Executor or grant.
The original Coordinator and both original Runtime identities must remain the targets.
A Core restart or upgrade does not clear a Native Start attempt. A missing original
Start receipt stays unknown and is never permission to submit another Start or input.
The reply adopts only the matching original Session and creation receipt.

This operation requires the same transport-authenticated user/device authority as
execution creation. It does not elevate a managed Agent. `execution rejoin` only
reattaches the original helper readers; `creation continue` remains the separate
continuation for an active ordinary creation wait. Neither is an alias for this action.
