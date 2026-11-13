# Remote Agents

<!-- amux:content -->
## Use another device's Agent for this project

Tasks, files and commands stay on the project machine. **Runs on** chooses where
the Agent process, model access and native configuration run. The common
arrangement keeps your project on this Mac and runs the Agent on a remote Host.

Configure the remote Host in **Settings → Remote → Hosts** first. AgentMux must
already run there; selecting a device does not install or upgrade its Core.

1. In **Space**, open your project, then **New Tab** or **New Agent**. The page
   header shows the project and the device it lives on; to work elsewhere, open
   that project or device from Space.
2. In the Agent section, choose the device in **Runs on**. It appears when more
   than one device is configured. The device's confirmed home directory is the
   default Agent startup directory; it does not need a copy of your project.
3. The Agent list switches to that device's configurations. Choose one, write
   your task and click **Launch**. Selecting a device does not start an Agent.

While a device is being prepared you can keep writing. A failure stays next to
**Runs on** with its real cause and **Retry**; it does not select another device
or a guessed directory. Changing the Agent device keeps the same Launcher and
draft. Existing Agents keep their original two-end bindings.

## Other arrangements

In **Settings → Remote → Remote Agents**, choose the project and the device the
Agent runs on. Under **More options**, choose a project folder on any device or
where the Agent starts. This covers a local Agent working on remote project
files, two remote devices, and different directories on one device.
**Open in Launcher** continues with these selections filled in; preparing does
not create an Agent or send a task. A Launcher with such an arrangement shows it
read-only in the Agent section, with **Use project device** and a link back to
Remote Agents.

## Continue existing work

Reopen the original Agent Tab, or use **Open original work** under
**Cross-device Agents** in Settings. **Resume original** continues the original
Session and binding. **Refresh observation** only rereads status. If an operation's
result is unknown, inspect that original operation rather than creating a replacement Agent
or repeating the command. Connection issues do not require closing healthy work.

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
