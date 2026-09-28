import { JobData, QueuedashOptions, SyncResponse } from "./types";

const MAX_PAYLOAD_SIZE = 4.5 * 1024 * 1024; // 4.5MB

// Type imports for detection (these are optional peer deps)
type BullMQQueue = {
  name: string;
  opts?: { connection?: unknown; prefix?: string };
  getJob: (id: string) => Promise<any>;
  redisPrefix?: string;
};

type BullMQWorker = {
  name: string;
  opts?: { connection?: unknown };
};

type BullMQQueueEvents = {
  on: (event: string, handler: (...args: any[]) => void) => any;
  close: () => Promise<void>;
};

type BullQueue = {
  name: string;
  on: (event: string, handler: (...args: any[]) => void) => void;
  getJob: (jobId: string) => Promise<any>;
  clients?: unknown[];
};

type BeeQueue = {
  name: string;
  on: (event: string, handler: (...args: any[]) => void) => void;
  settings?: unknown;
};

export class Queuedash {
  private apiKey: string;
  private apiUrl: string;
  private batchSize: number;
  private flushInterval: number;
  private maxRetries: number;
  private requestTimeout: number;
  private maxQueueSize: number;
  private onError?: (error: Error) => void;

  // Latest unsent snapshot per `${queueName}:${jobId}`, oldest first
  private jobQueue = new Map<string, JobData>();
  private flushTimer?: NodeJS.Timeout;
  private isFlushing = false;
  private inFlightFlush?: Promise<void>;
  // Scheduled retry after a failed sync. The periodic and batch-size flushes
  // wait for it so they don't cut the backoff short
  private retryTimer?: NodeJS.Timeout;
  // Set by stop(): failed syncs are reported instead of retried
  private stopped = false;
  private retryCount = 0;
  private circuitBreakerFailures = 0;
  private circuitBreakerOpen = false;
  private circuitBreakerResetTimer?: NodeJS.Timeout;

  // Track attached resources for cleanup
  private managedQueueEvents: BullMQQueueEvents[] = [];
  private attachedQueues = new Set<string>();

  constructor(options: QueuedashOptions) {
    if (!options.apiKey) {
      throw new Error("Queuedash: apiKey is required");
    }

    this.apiKey = options.apiKey;
    this.apiUrl =
      options.baseUrl ||
      (process.env.NODE_ENV === "production"
        ? "https://sync.queuedash.com"
        : "http://localhost:4002");
    this.batchSize = options.batchSize ?? 50;
    this.flushInterval = options.flushInterval ?? 100;
    this.maxRetries = options.maxRetries ?? 5;
    this.requestTimeout = options.requestTimeout ?? 30000;
    this.maxQueueSize = options.maxQueueSize ?? 10000;
    this.onError = options.onError;

    this.startFlushTimer();
    this.setupShutdownHandlers();
  }

  /**
   * Attach a queue or worker for monitoring.
   * Auto-detects the queue library (BullMQ, Bull, Bee-Queue).
   *
   * @example
   * ```ts
   * const qd = new Queuedash({ apiKey: 'qd_...' });
   *
   * // BullMQ - we create QueueEvents internally
   * qd.attach(myBullMQQueue);
   *
   * // Bull
   * qd.attach(myBullQueue);
   *
   * // Bee-Queue
   * qd.attach(myBeeQueue);
   * ```
   */
  attach(resource: unknown, options?: { events?: BullMQQueueEvents }): this {
    const type = this.detectType(resource);

    switch (type) {
      case "bullmq-queue": {
        const queue = resource as BullMQQueue;
        // This can fail after attach() has returned, where the caller can't
        // catch it, and an unhandled rejection would crash the process
        this.attachBullMQ(queue, options?.events).catch((error) => {
          const err = error instanceof Error ? error : new Error(String(error));
          const errorMsg = `Failed to attach queue "${queue.name}"`;
          if (this.onError) {
            this.onError(new Error(`${errorMsg}: ${err.message}`));
          } else {
            console.error(`Queuedash: ${errorMsg}`, err);
          }
        });
        break;
      }
      case "bullmq-worker":
        this.attachBullMQWorker(resource as BullMQWorker);
        break;
      case "bull":
        this.attachBull(resource as BullQueue);
        break;
      case "bee":
        this.attachBee(resource as BeeQueue);
        break;
      default:
        throw new Error(
          "Queuedash: Unknown queue type. Supported: BullMQ Queue, Bull, Bee-Queue",
        );
    }

    return this;
  }

  private detectType(
    resource: any,
  ): "bullmq-queue" | "bullmq-worker" | "bull" | "bee" | "unknown" {
    if (!resource || typeof resource !== "object") {
      return "unknown";
    }

    // BullMQ Queue: has getJob method and opts.connection
    if (
      typeof resource.getJob === "function" &&
      resource.opts?.connection !== undefined
    ) {
      return "bullmq-queue";
    }

    // BullMQ Worker: has opts.connection but no getJob
    if (
      resource.opts?.connection !== undefined &&
      typeof resource.getJob !== "function" &&
      resource.name
    ) {
      return "bullmq-worker";
    }

    // Bull: has clients array (redis clients)
    if (Array.isArray(resource.clients)) {
      return "bull";
    }

    // Bee-Queue: has settings object
    if (resource.settings !== undefined && resource.name) {
      return "bee";
    }

    return "unknown";
  }

  private async attachBullMQ(
    queue: BullMQQueue,
    existingEvents?: BullMQQueueEvents,
  ): Promise<void> {
    const queueName = queue.name;

    if (this.attachedQueues.has(`bullmq:${queueName}`)) {
      console.warn(`Queuedash: Queue "${queueName}" is already attached`);
      return;
    }

    let events: BullMQQueueEvents;

    // Create QueueEvents if not provided
    if (existingEvents) {
      events = existingEvents;
    } else {
      // Dynamic import to avoid requiring bullmq as a direct dependency
      const { QueueEvents } = await import("bullmq").catch((error) => {
        throw new Error(
          `Could not load bullmq (is it installed?): ${error.message}`,
        );
      });
      // Throws if BullMQ rejects the connection, e.g. a shared ioredis instance
      // without maxRetriesPerRequest: null. attach() reports the error as is
      const queueEvents = new QueueEvents(queueName, {
        connection: queue.opts?.connection as any,
        // BullMQ keeps the key prefix in opts.prefix; without it QueueEvents
        // listens on the default "bull" keys
        prefix: queue.opts?.prefix ?? queue.redisPrefix,
      });
      this.managedQueueEvents.push(queueEvents as unknown as BullMQQueueEvents);
      events = queueEvents as unknown as BullMQQueueEvents;
    }

    this.attachedQueues.add(`bullmq:${queueName}`);

    const syncJobById = (jobId: string, status?: string) => {
      queue
        .getJob(jobId)
        .then((job: any) => {
          if (job) {
            this.syncJob(this.extractBullMQJobData(job, queueName, status));
          }
        })
        .catch((error) => this.log(`Failed to load job ${jobId}`, error));
    };

    events.on("waiting", ({ jobId }: { jobId: string }) => syncJobById(jobId, "waiting"));
    events.on("progress", ({ jobId }: { jobId: string }) => syncJobById(jobId, "active"));
    events.on("completed", ({ jobId }: { jobId: string }) =>
      syncJobById(jobId, "completed"),
    );
    events.on("failed", ({ jobId }: { jobId: string }) => syncJobById(jobId, "failed"));
    events.on("waiting-children", ({ jobId }: { jobId: string }) =>
      syncJobById(jobId, "waiting-children"),
    );
    events.on("added", ({ jobId }: { jobId: string }) => syncJobById(jobId, "waiting"));
    events.on("active", ({ jobId }: { jobId: string }) => syncJobById(jobId, "active"));
    events.on("delayed", ({ jobId }: { jobId: string }) => syncJobById(jobId, "delayed"));
    events.on("deduplicated", ({ jobId }: { jobId: string }) =>
      syncJobById(jobId),
    );
    events.on("removed", ({ jobId }: { jobId: string }) =>
      this.deleteJob(jobId, queueName),
    );
    events.on("stalled", ({ jobId }: { jobId: string }) => syncJobById(jobId, "waiting"));
    events.on("retries-exhausted", ({ jobId }: { jobId: string }) =>
      syncJobById(jobId, "failed"),
    );
  }

  private attachBullMQWorker(_worker: BullMQWorker): void {
    // TODO: Worker monitoring - track active jobs, stalled detection, etc.
    console.warn("Queuedash: Worker monitoring coming soon");
  }

  private attachBull(queue: BullQueue): void {
    const queueName = queue.name;

    if (this.attachedQueues.has(`bull:${queueName}`)) {
      console.warn(`Queuedash: Queue "${queueName}" is already attached`);
      return;
    }

    this.attachedQueues.add(`bull:${queueName}`);

    // Global events pass (jobId, result) rather than a Job, so load the job
    const syncJobById = (jobId: string) => {
      queue
        .getJob(jobId)
        .then((job: any) => {
          if (job) {
            this.syncJob(this.extractBullJobData(job, queueName));
          }
        })
        .catch((error) => this.log(`Failed to load job ${jobId}`, error));
    };

    queue.on("global:completed", (jobId: string) => syncJobById(jobId));
    queue.on("global:failed", (jobId: string) => syncJobById(jobId));

    queue.on("active", (job: any) => {
      this.syncJob(this.extractBullJobData(job, queueName));
    });

    queue.on("progress", (job: any) => {
      this.syncJob(this.extractBullJobData(job, queueName));
    });

    queue.on("removed", (job: any) => {
      this.syncJob(this.extractBullJobData(job, queueName));
    });
  }

  private attachBee(queue: BeeQueue): void {
    const queueName = queue.name;

    if (this.attachedQueues.has(`bee:${queueName}`)) {
      console.warn(`Queuedash: Queue "${queueName}" is already attached`);
      return;
    }

    this.attachedQueues.add(`bee:${queueName}`);

    queue.on("succeeded", (job: any) => {
      const jobData = this.extractBeeJobData(job, queueName);
      jobData.finishedAt = new Date();
      this.syncJob(jobData);
    });

    queue.on("failed", (job: any, err: Error) => {
      const jobData = this.extractBeeJobData(job, queueName);
      jobData.failedReason = err.message;
      jobData.stacktrace = err.stack ? [err.stack] : undefined;
      jobData.finishedAt = new Date();
      this.syncJob(jobData);
    });

    queue.on("retrying", (job: any) => {
      const jobData = this.extractBeeJobData(job, queueName);
      jobData.retriedAt = new Date();
      this.syncJob(jobData);
    });
  }

  private extractBullMQJobData(job: any, queueName: string, status?: string): JobData {
    return {
      jobId: job.id as string,
      name: job.name,
      queueName,
      data: job.data,
      opts: job.opts,
      addedAt: new Date(job.timestamp),
      processedAt: job.processedOn ? new Date(job.processedOn) : null,
      finishedAt: job.finishedOn ? new Date(job.finishedOn) : null,
      failedReason: job.failedReason,
      stacktrace: job.stacktrace,
      priority: job.opts?.priority,
      delay: job.opts?.delay,
      timestamp: job.timestamp,
      progress: typeof job.progress === "number" ? job.progress : null,
      status,
    };
  }

  private extractBullJobData(job: any, queueName: string): JobData {
    return {
      jobId: job.id as string,
      name: job.name || "default",
      queueName,
      data: job.data,
      opts: job.opts,
      addedAt: new Date(job.timestamp),
      processedAt: job.processedOn ? new Date(job.processedOn) : null,
      finishedAt: job.finishedOn ? new Date(job.finishedOn) : null,
      failedReason: job.failedReason,
      stacktrace: job.stacktrace,
      priority: job.opts?.priority,
      delay: job.opts?.delay,
      timestamp: job.timestamp,
      progress: job.progress(),
    };
  }

  private extractBeeJobData(job: any, queueName: string): JobData {
    return {
      jobId: String(job.id),
      name: "default",
      queueName,
      data: job.data,
      opts: job.options || {},
      addedAt: job.options?.timestamp
        ? new Date(job.options.timestamp)
        : new Date(),
      processedAt: null,
      finishedAt: null,
      priority: null,
      delay: job.options?.delay,
    };
  }

  /**
   * Delete a job (soft delete in Queuedash)
   */
  async deleteJob(jobId: string, queueName: string): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.requestTimeout,
    );

    try {
      const response = await fetch(
        `${this.apiUrl}/api/v1/jobs/${encodeURIComponent(jobId)}?queueName=${encodeURIComponent(queueName)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (this.onError) {
        this.onError(
          new Error(`Failed to delete job ${jobId}: ${err.message}`),
        );
      } else {
        console.error(`Queuedash: Failed to delete job ${jobId}`, err);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Queue a job for syncing (internal use)
   */
  syncJob(job: JobData): void {
    if (this.circuitBreakerOpen) {
      return;
    }

    const jobKey = this.jobKey(job);

    // A newer snapshot replaces the pending one and keeps its place in line.
    // If the previous snapshot is already in flight, this one waits here for
    // the next flush (the API upserts on queue + jobId).
    if (this.jobQueue.has(jobKey)) {
      this.jobQueue.set(jobKey, job);
      return;
    }

    if (this.jobQueue.size >= this.maxQueueSize) {
      const oldest = this.jobQueue.entries().next().value;
      if (oldest) {
        this.jobQueue.delete(oldest[0]);
      }
      this.log(
        `Queue size limit reached (${this.maxQueueSize}), dropping oldest job: ${oldest?.[1].jobId}`,
      );
    }

    this.jobQueue.set(jobKey, job);

    if (this.jobQueue.size >= this.batchSize && !this.retryTimer) {
      this.flush();
    }
  }

  private jobKey(job: JobData): string {
    return `${job.queueName}:${job.jobId}`;
  }

  /**
   * Manually flush all pending jobs. Unlike the periodic and batch-size
   * flushes, this doesn't wait for a pending retry backoff.
   */
  async flush(): Promise<void> {
    if (
      this.isFlushing ||
      this.jobQueue.size === 0 ||
      this.circuitBreakerOpen
    ) {
      return;
    }

    // This attempt replaces any scheduled retry; if it fails, the next retry
    // is scheduled with a longer backoff
    this.clearRetryTimer();
    this.isFlushing = true;
    this.inFlightFlush = this.syncPendingJobs();
    try {
      await this.inFlightFlush;
    } finally {
      this.isFlushing = false;
      this.inFlightFlush = undefined;
    }
  }

  private async syncPendingJobs(): Promise<void> {
    const jobsToSync = [...this.jobQueue.values()];
    this.jobQueue = new Map();

    try {
      // Check if payload is too large and split into chunks if needed
      const payload = JSON.stringify({ jobs: jobsToSync });
      if (payload.length > MAX_PAYLOAD_SIZE) {
        const chunks = this.splitIntoChunks(jobsToSync, MAX_PAYLOAD_SIZE);
        for (const chunk of chunks) {
          await this.sendBatch(chunk);
          // Remove successfully sent jobs so they aren't re-queued on later chunk failure
          jobsToSync.splice(0, chunk.length);
        }
        this.retryCount = 0;
        this.circuitBreakerFailures = 0;
        return;
      }

      await this.sendBatch(jobsToSync);

      this.retryCount = 0;
      this.circuitBreakerFailures = 0;
    } catch (error) {
      this.retryCount++;
      this.circuitBreakerFailures++;

      const err = error instanceof Error ? error : new Error(String(error));

      if (this.circuitBreakerFailures >= 10) {
        this.openCircuitBreaker();
      }

      if (this.retryCount <= this.maxRetries && !this.stopped) {
        this.requeue(jobsToSync);

        const backoffMs = Math.min(
          1000 * Math.pow(2, this.retryCount - 1),
          30000,
        );

        this.log(
          `Retry ${this.retryCount}/${this.maxRetries} after ${backoffMs}ms`,
          err,
        );

        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          if (this.jobQueue.size > 0) {
            this.flush();
          }
        }, backoffMs);
      } else {
        this.retryCount = 0;

        const errorMsg = this.stopped
          ? `Failed to sync ${jobsToSync.length} jobs while stopping`
          : `Failed to sync ${jobsToSync.length} jobs after ${this.maxRetries} retries`;

        if (this.onError) {
          this.onError(new Error(`${errorMsg}: ${err.message}`));
        } else {
          console.error(`Queuedash: ${errorMsg}`, err);
        }
      }
    }
  }

  /**
   * Put unsent jobs back at the front of the queue, unless a newer snapshot
   * of the same job was queued while they were in flight
   */
  private requeue(jobs: JobData[]): void {
    const requeued = new Map<string, JobData>();
    for (const job of jobs) {
      const jobKey = this.jobKey(job);
      if (!this.jobQueue.has(jobKey)) {
        requeued.set(jobKey, job);
      }
    }
    for (const [jobKey, job] of this.jobQueue) {
      requeued.set(jobKey, job);
    }
    this.jobQueue = requeued;
  }

  private splitIntoChunks(jobs: JobData[], maxSize: number): JobData[][] {
    const chunks: JobData[][] = [];
    let currentChunk: JobData[] = [];
    let currentSize = 0;

    for (const job of jobs) {
      const jobSize = JSON.stringify(job).length;
      if (currentSize + jobSize > maxSize && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentSize = 0;
      }
      currentChunk.push(job);
      currentSize += jobSize;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  private async sendBatch(jobs: JobData[]): Promise<void> {
    const controller = new AbortController();
    // Covers reading the body too: if a response stalled mid-body, this flush
    // would never finish and no later flush could start
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.requestTimeout,
    );

    try {
      const response = await fetch(`${this.apiUrl}/api/v1/jobs/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ jobs }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = (await response.json()) as SyncResponse;

      if (!result.success && result.errors) {
        console.warn("Queuedash: Some jobs failed to sync:", result.errors);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private openCircuitBreaker(): void {
    if (this.circuitBreakerOpen) return;

    this.circuitBreakerOpen = true;
    console.error(
      "Queuedash: Circuit breaker opened after 10 consecutive failures. Will retry in 60s.",
    );

    this.circuitBreakerResetTimer = setTimeout(() => {
      this.circuitBreakerOpen = false;
      this.circuitBreakerFailures = 0;
      console.log("Queuedash: Circuit breaker reset, resuming sync attempts");
    }, 60000);

    if (this.circuitBreakerResetTimer.unref) {
      this.circuitBreakerResetTimer.unref();
    }
  }

  private log(message: string, error?: Error): void {
    if (this.onError && error) {
      console.warn(`Queuedash: ${message}`, error);
    } else {
      console.warn(`Queuedash: ${message}`);
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  /**
   * Stop the client, close managed resources, and flush remaining jobs.
   * A pending retry backoff is skipped: remaining jobs get one final attempt,
   * and if that fails they're reported via onError instead of retried.
   */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    if (this.circuitBreakerResetTimer) {
      clearTimeout(this.circuitBreakerResetTimer);
    }

    // Close any QueueEvents we created
    for (const events of this.managedQueueEvents) {
      try {
        await events.close();
      } catch {
        // Ignore close errors
      }
    }

    // flush() is a no-op while another flush is in flight, so let that one
    // finish first; otherwise snapshots queued behind it would never be sent
    while (this.inFlightFlush) {
      await this.inFlightFlush.catch(() => {});
    }

    // Don't wait out a pending backoff (up to 30s) during shutdown
    this.stopped = true;
    this.clearRetryTimer();
    await this.flush();
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      if (this.jobQueue.size > 0 && !this.retryTimer) {
        this.flush();
      }
    }, this.flushInterval);

    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  private setupShutdownHandlers(): void {
    const shutdown = async () => {
      console.log("Queuedash: Graceful shutdown - flushing remaining jobs...");
      await this.stop();
      process.exit(0);
    };

    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    process.once("beforeExit", () => {
      if (this.jobQueue.size > 0) {
        console.warn(
          `Queuedash: Process exiting with ${this.jobQueue.size} unsync'd jobs`,
        );
      }
    });
  }
}
