## Overview

CoMapeo lets teams map their territory offline, without relying on cloud services or persistent internet connectivity. This document describes how devices discover one another, exchange observations, and reconcile conflicting edits over time. The design prioritizes peer-to-peer synchronization so that field crews working in remote areas can collaborate continuously even when no central server is reachable.

Because field work happens in places where connectivity is unreliable by default, the system assumes from the outset that any device may disappear from the network at any moment and reappear hours or days later. Every primitive in the synchronization stack is built to tolerate that reality rather than fight it. There is no assumption of a coordinated handshake, no requirement that all participants be online simultaneously, and no single device that acts as a source of truth.

### Design goals

The synchronization layer is built around three goals: eventual consistency, so that every device converges on the same data given enough time; tolerance for partition, so that work continues during network splits; and authorship preservation, so that the origin of every observation stays traceable even after edits.

## How synchronization works

Synchronization is handled by an append-only log replicated between devices. Each observation, attachment, or metadata change is recorded as an entry in a local log. When two devices meet, they exchange the entries the other is missing. Because entries are content-addressed and cryptographically signed, a device can verify that an incoming entry was produced by a legitimate participant before merging it.

The merge process is deterministic. Every device applies incoming entries in the same total order, derived from a combination of the author identifier, a monotonically increasing sequence number, and a tie-breaking hash. This guarantees that two devices holding the same set of entries will compute identical application states, regardless of the order in which entries arrived over the network. Conflicts at the field level are resolved with a last-writer-wins rule keyed by the logical clock embedded in each entry.

When a device receives an entry it already holds, the operation is a no-op and costs almost nothing. This idempotency is what makes opportunistic sync over intermittent connections practical: devices can exchange data whenever they happen to be in range, repeat the exchange later, and never worry about producing duplicates. The cost of a redundant transfer is bounded by the size of the missing-entries negotiation, which uses compact bloom-filter summaries to avoid sending data the peer already has.

The replication protocol proceeds in two phases. In the negotiation phase, each device summarizes the entries it holds using a space-efficient probabilistic structure and sends that summary to its peer. The peer compares the summary against its own log to determine which entries are absent, then requests precisely those entries. In the transfer phase, the requested entries stream over an encrypted channel, are verified against their signatures, and are appended to the local log in deterministic order. Both phases are designed to be resumable: if the connection drops mid-transfer, the next session picks up from the last entry that was acknowledged.

| Event | Trigger | Result |
| --- | --- | --- |
| Initial sync | Devices first meet | Full log exchange |
| Incremental sync | Devices reconnect | Only missing entries sent |
| Edit conflict | Two devices edit same field | Last writer wins |
| Fork resolution | Divergent histories | Deterministic merge order |
| Redundant transfer | Duplicate entry received | No-op, entry discarded |

### Performance characteristics

The amount of data transferred during a sync grows with the number of new entries since the last successful exchange, not with the total size of the database. A team that has recorded tens of thousands of observations can still complete a routine sync in seconds, because only the delta is transmitted. Attachments such as photos are negotiated separately and transferred lazily, on demand, so that a catalog can be synchronized quickly even when the media itself is large.

Memory usage during a sync is bounded by the size of the summary structure plus a small working buffer for in-flight entries. The summary never exceeds a few kilobytes regardless of how large the underlying log has grown, which keeps the negotiation phase cheap even on low-end devices. Disk writes are sequential appends, avoiding the overhead of random access and keeping flash storage healthy over the lifetime of a device.

## Peer discovery

Devices find each other through a combination of local network broadcasting and manual invitation. On a local network, a device advertises its presence at a fixed interval and listens for advertisements from peers. When two devices hear each other, they exchange identity information and, if both belong to the same team project, begin the negotiation phase automatically.

Discovery can also be initiated manually. A team member can share an invitation that encodes the project identity and a temporary credential; a recipient who accepts the invitation joins the project and begins participating in sync immediately. Manual invitations are the primary way a new device is onboarded, since the first connection must establish trust before any data is exchanged.

## Configuration

Teams can tune how aggressively devices search for peers and how much local storage is reserved for the log. The defaults are chosen to balance battery life against sync latency, but field conditions vary and the configuration is exposed through the same settings surface used by the rest of the application.

```typescript
const syncConfig = {
  discoveryIntervalMs: 30_000,
  maxStorageMb: 512,
  autoSync: true,
  // When false, sync only runs when explicitly invoked by the user.
  backgroundSync: true,
};

applySyncConfig(syncConfig);
```

### Error handling

If a sync attempt fails partway through, the partial state is preserved and the next attempt resumes from the last acknowledged entry. No entry is ever applied twice, and a failed transfer never corrupts the local log. Transient errors such as a peer disconnecting mid-exchange are retried automatically on the next discovery cycle. Permanent errors, such as a signature that fails verification, are logged and the offending entry is rejected without halting the rest of the sync.
