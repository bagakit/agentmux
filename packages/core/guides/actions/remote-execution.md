# Remote execution

<!-- amux:content -->
## Start from a project in Space

Keep the project files and tools on one machine, and choose where the Agent runs.
The two roles can use either your local machine or a configured remote Host.

Before starting, configure the remote Host in Settings → Remote → Hosts. Register
the project folder and a folder on the Agent runtime machine. The runtime folder
is the Agent's working directory; it does not need a copy of the project.

1. In **Space**, open a project, then **New Tab** or **New Agent**.
2. Choose an arrangement directly in the Launcher:
   - **Local development**: project and Agent on this machine.
   - **Remote development**: choose a project on a remote server; its files,
     Git, terminals and Agent work there.
   - **Remote Agent**: keep a local project and choose a remote Agent runtime.
3. If a target is missing, choose its **Machine** and registered directory in
   the inline setup. The Agent runtime directory does not need a project copy.
   Browsing a machine or cancelling setup does not change the current target.
4. Check **Project & tools** and, for separate execution, **Agent runtime**.
   Select the Agent configuration from that exact runtime, write your task and
   click **Launch**. Choosing an arrangement does not start an Agent.

**Custom** lets you choose both ends independently, including a local Agent
with remote project files, two different remote machines, or different working
directories on one machine. Use **Agent follows project** for a shared target.

Changing the runtime within one project keeps the same Launcher and draft.
Choosing another project opens that project's own work; the original project
keeps its unsent prompts, file references, Browser and Note drafts. Existing
Agents keep their original two-end bindings.

## Prepare from Settings

In **Settings → Remote → Remote execution**, choose **Project & tools**, then
**Prepare Agent**. This opens the same project Launcher with separate execution
enabled. Choose **Remote Agent** for a local project, or **Custom** for other two-end
arrangements. Select the runtime working directory and its Agent configuration,
then **Launch**. Prepare itself does not start or resume an Agent.

## Continue existing work

Reopen the original Agent Tab, or use **Open original work** on its execution
binding in Settings. **Resume original** continues the original Session and
binding. **Refresh observation** only rereads status. If an operation's result is
unknown, inspect that original operation rather than creating a replacement Agent
or repeating the command. Connection issues do not require closing healthy work.

## Environments and permissions

Files and commands belong to **Project & tools**. Native login, settings, Hooks
and Skills load from the **Agent runtime** machine; they are not automatically
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
