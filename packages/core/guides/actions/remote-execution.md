# Remote execution

<!-- amux:content -->
## Start from a project in Space

Keep the project files and tools on one machine, and choose where the Agent runs.
The two roles can use either your local machine or a configured remote Host.

Before starting, configure the remote Host in Settings → Remote → Hosts. Register
the project folder and a folder on the Agent runtime machine. The runtime folder
is the Agent's working directory; it does not need a copy of the project.

1. In **Space**, open the project whose files you want to work on, then **New Tab**
   or **New Agent** to open its Launcher.
2. Turn on **Run the Agent on a separate host** in the Launcher.
3. Check **Project & tools**: this is the machine and folder where file operations
   and commands will run.
4. Click the machine name under **Agent runtime**. Choose **Machine**, then click
   a registered project folder on that machine. Browsing a machine alone does not
   select the runtime folder.
5. Select an Agent configuration from that runtime, write your task and click
   **Launch**. Choosing environments does not start an Agent.

For a local project with a remote Agent, start in the local project's Launcher.
For remote project files with a local Agent, start in the remote project's
Launcher and select a local runtime folder. Each new Agent keeps its own two-end
binding; changing a future Launcher does not move existing work.

## Prepare from Settings

In **Settings → Remote → Remote execution**, choose **Project & tools**, then
**Prepare Agent**. This opens the same project Launcher with separate execution
enabled. Next choose **Agent runtime**, its project folder and its Agent
configuration, then **Launch**. Prepare itself does not start or resume an Agent.

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
