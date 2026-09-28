---
"@queuedash/sdk": patch
---

Fix crashes, lost jobs, and missed job updates. Upgrading is recommended.

- A failure to attach a BullMQ queue now goes to `onError` (or the console), and a failed `getJob` is logged, instead of crashing the host process with an unhandled rejection.
- Jobs are no longer lost during short API outages. Retries now wait for their backoff (1s → 2s → 4s → 8s → 16s, capped at 30s); previously a failed batch was re-sent every 100ms, so every retry was used up and the batch was dropped within about 0.6s. Jobs that arrive during a backoff are sent with the retry.
- BullMQ: queues created with a custom `prefix` are now tracked. The QueueEvents listener the SDK creates uses the queue's own prefix instead of BullMQ's default.
- Bull: completed and failed jobs now reach Queuedash. Bull passes only a job ID to `global:completed` and `global:failed`, so the SDK now loads the job by that ID.
- A newer update for a job now replaces its pending one instead of being dropped, so a job that changes state before its earlier update is sent no longer stays in that earlier state.
- `requestTimeout` now also covers reading the response body, so a response that stalls after its headers no longer blocks all further syncing.
- A failed request no longer leaves its timeout timer running, which kept the process alive for up to 30s, for example after `stop()`.
- `stop()` no longer waits out a pending backoff: it makes one final attempt right away, and if that fails the jobs are reported via `onError` instead of retried. An explicit `flush()` also skips the backoff.
- The "Unknown queue type" error and the README no longer list GroupMQ, which the SDK doesn't support, and the README now gives the right `baseUrl` default.
