# @queuedash/sdk

## 2.0.0

### Major Changes

- [`e031f2c`](https://github.com/alexbudure/queuedash-sdk/commit/e031f2c3e6dcacb51ba989522f340a5ca28f9b2b) Thanks [@alexbudure](https://github.com/alexbudure)! - Migrate to new sync endpoint and improve reliability
  - Update API URL from `api.queuedash.com` to `sync.queuedash.com`
  - Add job status tracking: BullMQ events now propagate explicit status strings (waiting, active, completed, failed, delayed, waiting-children) to synced job data
  - Add payload chunking: large batches exceeding 4.5MB are automatically split into smaller chunks, with partial-failure handling that only re-queues unsent jobs
  - Extract `sendBatch` method for cleaner flush logic
