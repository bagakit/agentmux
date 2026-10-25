# device

<!-- amux:content -->
Device ls/revoke require a local Unix user; managed Agents cannot administer devices.
Device link is a read-only operation for the authenticated Agent's exact execution Host or its local Unix user.
It returns hostId, url (the complete public offer), pageUrl, relay and mobileAccess in one result.
The existing Relay endpoint may be a domain name or IP; no public address or reachability is inferred.
A known link remains readable while the Relay is disconnected. Open the returned complete URL on a phone with access to that endpoint.
Device hello names only the device bound to its completed encrypted handshake.
No pairing code, local OS approval or certificate installation is part of the connection flow.
After a missing revocation reply, read amux device ls and compare the exact deviceId facts.
Never automatically replay a device revocation.
