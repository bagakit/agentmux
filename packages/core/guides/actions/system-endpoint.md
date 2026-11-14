# system-endpoint

<!-- amux:content -->
Public methods use the same typed JSON-RPC service over Unix, HTTP, encrypted Relay, SSH or Tailcat.
Unix and SSH carry line-delimited JSON; HTTP streams use SSE. HTTP is off by default: the host
must set both AGENTMUX_RPC_HTTP_BIND (host:port) and AGENTMUX_RPC_HTTP_TOKEN, and HTTP clients
read AGENTMUX_RPC_HTTP_TOKEN. Unknown Host, missing Session, owner ambiguity and an unreachable
service keep distinct errors and are never resolved by choosing the first candidate or rerouting.
Select one transport with amux --endpoint <descriptor> <object> <action>.
Or select a bound SSH Host saved by the original local Unix configuration owner:
  amux --source-host source-b agent ls
  amux --source-host source-b file stat --input source-path.json
Use the actual saved ID and the original Source resource/Zone in the input JSON. --source-host and --endpoint
are mutually exclusive. The selector reads settings hosts ls once, preserves the full saved
SSH/Tailcat target and original caller, and fixes its Runtime/owner instance for calls and readers.
It does not install, test, register or repair a Host. Unknown effects keep their original operation IDs.
After identity is confirmed, CLI envelopes retain source:{configuredHostId,runtimeId,ownerInstanceId}.
Generic raw-frame readers emit one CLI Source association record before the unchanged JSON-RPC frames.
Keep this Source with an unknown operation. If the alias changes, use settings hosts ls to locate
the same runtimeId before inspecting; another Runtime cannot replace it. A later instance on the
same Runtime may inspect the original operation; the old instance is not a permanent recovery gate.
Local Hosts and non-Unix configuration services use the original default or explicit endpoint;
credential paths from another machine cannot be interpreted as local key files. An unbound saved
Runtime remains unknown; inspect that Host before choosing a target. A Source must authenticate
the original caller; the selector grants no person/device or cross-Host authority.
Help, skill and version remain offline. Local/static commands and the Unix stdio bridge do not
accept --source-host; system endpoint --inspect may observe the selected Source.
Run system endpoint to discover the default without connecting.
Endpoint, Host route and execution identity are separate:
--endpoint selects one AgentMux service, not an execution destination.
--host on commands that support it selects a Host ID known to that service; it is not an SSH address.
local means the receiving Core service's own machine, including when that service is remote.
agent ls and agent inspect return routeHostId for that service and retain session.hostId unchanged.
Provider turn failures appear in status.session.semanticStatus.failure with code, message, recovery and available native evidence.
An error status does not imply that its Run exited; ordinary input follows the current Run and readiness facts.
Use routeHostId with agent context --host; its hostId is the route and sourceHostId is the original source.
Keep the same endpoint for discovery and follow-up. Host IDs are not global machine IDs.

Direct remote service (build-node is a normal SSH alias):
  amux --endpoint 'ssh://user@build-node/' agent ls
  amux --endpoint 'ssh://user@build-node/' agent context --host local --session SID
Via this service's configured remote Host (use the actual returned routeHostId):
  amux agent ls
  amux agent context --host build-host --session SID
Find configured route IDs with amux settings hosts ls. A listed configuration is not a connection check.
system endpoint reports connection=not-attempted and does not verify reachability or Agent health.
system endpoint --inspect reads the owner publication observation through RPC. publication is
null when this service has no endpoint observation; it is not a Run status.
An RPC system.endpoint response reports connection=responded; this certifies that response only.
SSH uses the remote amux system endpoint --stdio bridge and requires an existing remote service.
The ssh URI may specify URI-encoded socket and command query parameters; system SSH owns aliases and credentials.
Tailcat uses the same stdio bridge and requires AgentMux already running on the target.
Use a saved client key name or absolute path, never an ephemeral key:
  amux --endpoint 'tailcat:tcADDRESS_PLACEHOLDER?key=agentmux-client' agent ls
Replace tcADDRESS_PLACEHOLDER with the private address returned by the target's listener.
The address contains secret connection material; keep it out of logs and shared examples.
Direct endpoint selection never falls back or replays an unknown operation.
Remote Host settings can explicitly select SSH-first with Tailcat backup before dispatch.
Managed Agent credentials come from AGENTMUX_AGENT_SESSION_ID and AGENTMUX_AGENT_CAPABILITY;
the service verifies them. Environment SID hints and displayed text do not prove an author.
