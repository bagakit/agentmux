# Remote Agents

<!-- amux:content -->
## Use another device's Agent for this project

Tasks, files and commands stay on the project machine. **Agent runs on** chooses
where the Agent process, model access and native configuration run. The common
arrangement keeps your project on this Mac and runs the Agent on a remote Host.
Advanced settings also support the reverse arrangement and other supported pairs.

Configure the remote Host in **Settings → Remote → Hosts** first. AgentMux must
already run there; selecting a device does not install or upgrade its Core.

1. In **Space**, open your project, then **New Tab** or **New Agent**.
2. Choose the device in **Agent runs on**. Its confirmed home directory is the
   default Agent startup directory; it does not need a copy of your project.
   Looking at a device or cancelling selection leaves the original target intact.
3. Check the project and Agent device, choose an Agent configuration from that
   exact device, write your task and click **Launch**. Selecting a device does not
   start an Agent.

Use the advanced **Files & tools** and **Agent startup directory** choices to
change the project side or choose a different runtime directory. They support a
local Agent with remote project files, two remote devices, or different directories
on one device. The directory label describes where the Agent starts, not a second
project copy. Unavailable home observations keep their real cause and retry path;
they do not silently select another device or guessed directory.

Changing the Agent device within one project keeps the same Launcher and draft.
Choosing another project opens that project's own work; the original project
keeps its unsent prompts, file references, Browser and Note drafts. Existing
Agents keep their original two-end bindings.

## Prepare from Settings

In **Settings → Remote → Remote Agents**, check the current local project and
choose **Agent runs on**. Use **Open in Launcher** to continue with both selections
already filled in. If no local project is selected, choose one explicitly. The
remote device's confirmed home is used by default, with its ordinary folder
registration retained as the startup location; preparing does not navigate to
that directory, create an Agent or send a task. Choose the Agent configuration
and enter the task in the original Launcher, then **Launch**.

## Continue existing work

Reopen the original Agent Tab, or use **Open original work** under
**Cross-device Agents** in Settings. **Resume original** continues the original
Session and binding. **Refresh observation** only rereads status. If an operation's
result is unknown, inspect that original operation rather than creating a replacement Agent
or repeating the command. Connection issues do not require closing healthy work.

## Environments and permissions

Files and commands belong to **Files & tools**. Native login, settings, Hooks
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
