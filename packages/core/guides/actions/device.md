# device

<!-- amux:content -->
Device ls/revoke require a local Unix user; managed Agents cannot administer devices.
Device link is a read-only operation for the authenticated Agent's exact execution Host or its local Unix user.
It returns hostId, url (the complete public connection link), pageUrl, relay, mobileAccess and candidates in one result.
candidates are this Mac's local-network IPv4 addresses with their interface name and OS port label; one is marked preferred.
Without --address the link uses the preferred address. --address IPV4 uses that candidate, and an address that is not a current candidate is refused with INVALID_CONTROL_REQUEST rather than replaced.
A candidate describes this Mac's adapter only; it does not prove the phone can reach it.
The existing Relay endpoint may be a domain name or IP; no public address or reachability is inferred.
A known link remains readable while the Relay is disconnected. Open the returned complete URL on a phone with access to that endpoint.
Same-origin links carry the complete Mac public-key pin; the mobile page reads the public connection description from that original Host and checks the pin before the encrypted handshake.
The description read never enrolls a device. The encrypted hello must confirm that same Host identity.
Device hello names only the device bound to its completed encrypted handshake.
No pairing code, local OS approval or certificate installation is part of the connection flow.
After a missing revocation reply, read amux device ls and compare the exact deviceId facts.
Never automatically replay a device revocation.
