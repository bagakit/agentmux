# Remote work

<!-- amux:content -->
## Choose where the project and Agent work

Hosts are the connection foundation in Settings → Environment → Hosts. Remote work
uses those saved Hosts. Preparation can read the selected Host’s home through its
saved connection; it does not automatically install, upgrade, approve or start an Agent.

From the Desktop that starts or views the work:

| Mode | Agent runs | Project files and commands |
| --- | --- | --- |
| Local | On this device | On this device |
| Reach · Remote Project | On this device | On the remote Host |
| Relay · Remote Agent | On the remote Host | On this device |
| Orbit · Remote Workspace | Remotely | Remotely, on the Agent Host by default |

Remote Workspace keeps computation and the project off this device. It does not enable
continuous autonomous tasks or change access permissions. Existing arrangements with two
different remote Hosts keep their exact two ends; the screen names each Host.

These choices belong to the person in Desktop. An Agent does not make them on the
person's behalf. The equivalent explicit split-workspace flags also require an
authenticated user or device; do not assume that identity.

## Start work

Open New Tab or New Agent for the project, then use the work-mode entry beside Agent
to edit its arrangement. Settings → Environment → Remote offers the same preparation under Start work.
Choose a mode, an exact registered project and the Agent device. For separate execution,
the Agent startup directory defaults to that Host's confirmed home and may be another
registered directory there; it does not need a project copy. Register a missing project
through its original Host entry rather than guessing a same-named local path.

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
