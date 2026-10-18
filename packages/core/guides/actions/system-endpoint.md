# system-endpoint

<!-- amux:content -->
Public methods use the same typed JSON-RPC service over Unix, HTTP, encrypted Relay or SSH.
Select one transport with amux --endpoint <descriptor> <object> <action>.
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
system endpoint --inspect reads the owner publication observation through RPC.
An RPC system.endpoint response reports connection=responded; this certifies that response only.
SSH uses the remote amux system endpoint --stdio bridge and requires an existing remote service.
The ssh URI may specify URI-encoded socket and command query parameters; system SSH owns aliases and credentials.
Managed Agent credentials come from AGENTMUX_AGENT_SESSION_ID and AGENTMUX_AGENT_CAPABILITY;
the service verifies them. Environment SID hints and displayed text do not prove an author.
