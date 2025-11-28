# @queuedash/sdk

Official SDK for Queuedash - Real-time monitoring for BullMQ, Bull, and Bee-Queue.

## Installation

```bash
npm install @queuedash/sdk
# or
pnpm add @queuedash/sdk
# or
yarn add @queuedash/sdk
```

## Quick Start

The SDK auto-detects your queue library (BullMQ, Bull, or Bee-Queue) - just use `attach()`:

### BullMQ

```typescript
import { Queue } from "bullmq";
import { Queuedash } from "@queuedash/sdk";

const qd = new Queuedash({ apiKey: process.env.QUEUEDASH_API_KEY });

const myQueue = new Queue("my-queue", {
  connection: { host: "localhost", port: 6379 },
});

qd.attach(myQueue);

// Jobs are now automatically synced to Queuedash
```

### Bull

```typescript
import Queue from "bull";
import { Queuedash } from "@queuedash/sdk";

const qd = new Queuedash({ apiKey: process.env.QUEUEDASH_API_KEY });

const myQueue = new Queue("my-queue", "redis://localhost:6379");

qd.attach(myQueue);
```

### Bee-Queue

```typescript
import Queue from "bee-queue";
import { Queuedash } from "@queuedash/sdk";

const qd = new Queuedash({ apiKey: process.env.QUEUEDASH_API_KEY });

const myQueue = new Queue("my-queue", {
  redis: { host: "localhost", port: 6379 },
});

qd.attach(myQueue);
```

### Multiple Queues

```typescript
import { Queue } from "bullmq";
import { Queuedash } from "@queuedash/sdk";

const qd = new Queuedash({ apiKey: process.env.QUEUEDASH_API_KEY });

const connection = { host: "localhost", port: 6379 };

qd.attach(new Queue("emails", { connection }));
qd.attach(new Queue("reports", { connection }));
qd.attach(new Queue("notifications", { connection }));
```

## Configuration

### API Key

Get your API key from [Queuedash](https://queuedash.com):

1. Navigate to your project
2. Click "API Keys"
3. Generate a new API key

```bash
# Set in your environment
QUEUEDASH_API_KEY=sk_live_...
```

### Options

```typescript
const qd = new Queuedash({
  // Required: Your API key from Queuedash
  apiKey: string,

  // Optional: Custom API URL (default: https://api.queuedash.com)
  baseUrl?: string,

  // Optional: Batch size for syncing jobs (default: 50)
  batchSize?: number,

  // Optional: Flush interval in milliseconds (default: 100)
  flushInterval?: number,

  // Optional: Max retry attempts with exponential backoff (default: 5)
  maxRetries?: number,

  // Optional: Request timeout in milliseconds (default: 30000)
  requestTimeout?: number,

  // Optional: Max jobs to queue in memory (default: 10000)
  maxQueueSize?: number,

  // Optional: Error handler called on critical failures
  onError?: (error: Error) => void,
});
```

## Reliability & Robustness

The SDK is production-ready with multiple layers of protection:

**Retry Logic**

- Automatic retries up to 5 times (configurable)
- Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (capped)
- Jobs preserved in local queue until successfully synced

**Circuit Breaker**

- Opens after 10 consecutive failures to prevent overwhelming the API
- Auto-resets after 60 seconds
- Prevents cascading failures

**Memory Protection**

- Queue size limit (10,000 jobs default) prevents memory leaks
- Oldest jobs dropped first if limit reached
- Warning logged when queue limit hit

**Graceful Shutdown**

- SIGTERM/SIGINT handlers flush pending jobs before exit
- Call `await qd.stop()` to manually stop
- No jobs lost during normal shutdown

**Request Safety**

- 30-second timeout on all HTTP requests
- Duplicate detection prevents same job syncing twice
- Network errors handled gracefully

## Features

- **Auto-detection**: Works with BullMQ, Bull, and Bee-Queue automatically
- **Real-time sync**: Jobs are synced as events happen
- **Smart batching**: Events are automatically batched for performance
- **Auto-retry**: Failed syncs are automatically retried
- **Zero config**: Works out of the box with sensible defaults
- **TypeScript**: Full TypeScript support

## License

MIT
