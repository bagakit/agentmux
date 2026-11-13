# Remote Agents

<!-- amux:content -->
## Use another device's Agent for this project

Tasks, files and commands stay on the project machine. The Agent device chooses where
the Agent process, model access and native configuration run. The common arrangement
keeps the project on this Mac and runs the Agent on a remote Host.

These choices belong to the person in AgentMux Desktop. An Agent does not make them on the
person's behalf: name the location below and ask the person to complete it there. The
equivalent agent open workspace flags also require an authenticated user or device.

- The remote Host is configured in Settings → Remote → Hosts. AgentMux must already run
  on that Host; choosing a device neither installs nor upgrades its Core.
- The Agent device is the Runs on field in the Launcher that New Tab or New Agent opens
  for the project in Space. The field appears when more than one device is configured.
  The device's confirmed home directory is the default Agent startup directory; the device
  does not need a copy of the project. The Agent list then shows that device's
  configurations. Choosing a device starts no Agent; only Launch does.

The task draft stays editable while a device is being prepared. A preparation failure
stays next to Runs on with its real cause and a Retry action; it never selects another
device or a guessed directory. Changing the Agent device keeps the same Launcher and
draft. Existing Agents keep their original two-end bindings.

## Other arrangements

Settings → Remote → Remote Agents selects the project and the Agent device. Its More
options also select a project folder on any device or the Agent's startup directory.
This covers a local Agent working on remote project files, two remote devices, and
different directories on one device. Open in Launcher carries these selections into a
Launcher; preparing creates no Agent and sends no task. That Launcher shows the
arrangement read-only, with Use project device and a link back to Remote Agents.

## Continue existing work

Reopen the original Agent Tab, or ask the person to use Open original work under
Cross-device Agents in Settings → Remote → Remote Agents. Resume original continues the
original Session and binding; Refresh observation only rereads status. If an operation's
result is unknown, inspect that original operation rather than creating a replacement
Agent or repeating the command. Connection issues do not require closing healthy work.

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
