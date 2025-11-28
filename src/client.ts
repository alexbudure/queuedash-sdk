import { JobData, QueuedashOptions, SyncResponse } from "./types";

// Type imports for detection (these are optional peer deps)
type BullMQQueue = {
  name: string;
  opts?: { connection?: unknown };
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

  private jobQueue: JobData[] = [];
  private flushTimer?: NodeJS.Timeout;
  private isFlushing = false;
  private retryCount = 0;
  private circuitBreakerFailures = 0;
  private circuitBreakerOpen = false;
  private circuitBreakerResetTimer?: NodeJS.Timeout;
  private syncingJobIds = new Set<string>();

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
        ? "https://api.queuedash.com"
        : "http://localhost:4001");
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
      case "bullmq-queue":
        this.attachBullMQ(resource as BullMQQueue, options?.events);
        break;
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
          "Queuedash: Unknown queue type. Supported: BullMQ Queue/Worker, Bull, Bee-Queue",
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
      try {
        // Dynamic import to avoid requiring bullmq as a direct dependency
        const { QueueEvents } = await import("bullmq");
        const queueEvents = new QueueEvents(queueName, {
          connection: queue.opts?.connection as any,
          prefix: queue.redisPrefix,
        });
        this.managedQueueEvents.push(
          queueEvents as unknown as BullMQQueueEvents,
        );
        events = queueEvents as unknown as BullMQQueueEvents;
      } catch (e) {
        throw new Error(
          "Queuedash: Failed to create QueueEvents. Make sure bullmq is installed.",
        );
      }
    }

    this.attachedQueues.add(`bullmq:${queueName}`);

    const syncJobById = (jobId: string) => {
      queue.getJob(jobId).then((job: any) => {
        if (job) {
          this.syncJob(this.extractBullMQJobData(job, queueName));
        }
      });
    };

    events.on("waiting", ({ jobId }: { jobId: string }) => syncJobById(jobId));
    events.on("progress", ({ jobId }: { jobId: string }) => syncJobById(jobId));
    events.on("completed", ({ jobId }: { jobId: string }) =>
      syncJobById(jobId),
    );
    events.on("failed", ({ jobId }: { jobId: string }) => syncJobById(jobId));
    events.on("waiting-children", ({ jobId }: { jobId: string }) =>
      syncJobById(jobId),
    );
    events.on("added", ({ jobId }: { jobId: string }) => syncJobById(jobId));
    events.on("active", ({ jobId }: { jobId: string }) => syncJobById(jobId));
    events.on("delayed", ({ jobId }: { jobId: string }) => syncJobById(jobId));
    events.on("deduplicated", ({ jobId }: { jobId: string }) =>
      syncJobById(jobId),
    );
    events.on("removed", ({ jobId }: { jobId: string }) =>
      this.deleteJob(jobId, queueName),
    );
    events.on("stalled", ({ jobId }: { jobId: string }) => syncJobById(jobId));
    events.on("retries-exhausted", ({ jobId }: { jobId: string }) =>
      syncJobById(jobId),
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

    queue.on("global:completed", (job: any) => {
      this.syncJob(this.extractBullJobData(job, queueName));
    });

    queue.on("global:failed", (job: any) => {
      if (job) {
        this.syncJob(this.extractBullJobData(job, queueName));
      }
    });

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

  private extractBullMQJobData(job: any, queueName: string): JobData {
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
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.requestTimeout,
      );

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

      clearTimeout(timeoutId);

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
    }
  }

  /**
   * Queue a job for syncing (internal use)
   */
  syncJob(job: JobData): void {
    if (this.circuitBreakerOpen) {
      return;
    }

    const jobKey = `${job.queueName}:${job.jobId}`;
    if (this.syncingJobIds.has(jobKey)) {
      return;
    }
    this.syncingJobIds.add(jobKey);

    if (this.jobQueue.length >= this.maxQueueSize) {
      const dropped = this.jobQueue.shift();
      this.log(
        `Queue size limit reached (${this.maxQueueSize}), dropping oldest job: ${dropped?.jobId}`,
      );
    }

    this.jobQueue.push(job);

    if (this.jobQueue.length >= this.batchSize) {
      this.flush();
    }
  }

  /**
   * Manually flush all pending jobs
   */
  async flush(): Promise<void> {
    if (
      this.isFlushing ||
      this.jobQueue.length === 0 ||
      this.circuitBreakerOpen
    ) {
      return;
    }

    this.isFlushing = true;

    const jobsToSync = [...this.jobQueue];
    this.jobQueue = [];

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.requestTimeout,
      );

      const response = await fetch(`${this.apiUrl}/api/v1/jobs/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ jobs: jobsToSync }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = (await response.json()) as SyncResponse;

      if (!result.success && result.errors) {
        console.warn("Queuedash: Some jobs failed to sync:", result.errors);
      }

      this.retryCount = 0;
      this.circuitBreakerFailures = 0;
      jobsToSync.forEach((job) => {
        this.syncingJobIds.delete(`${job.queueName}:${job.jobId}`);
      });
    } catch (error) {
      this.retryCount++;
      this.circuitBreakerFailures++;

      const err = error instanceof Error ? error : new Error(String(error));

      if (this.circuitBreakerFailures >= 10) {
        this.openCircuitBreaker();
      }

      if (this.retryCount <= this.maxRetries) {
        this.jobQueue.unshift(...jobsToSync);

        const backoffMs = Math.min(
          1000 * Math.pow(2, this.retryCount - 1),
          30000,
        );

        this.log(
          `Retry ${this.retryCount}/${this.maxRetries} after ${backoffMs}ms`,
          err,
        );

        setTimeout(() => {
          if (this.jobQueue.length > 0) {
            this.flush();
          }
        }, backoffMs);
      } else {
        this.retryCount = 0;
        jobsToSync.forEach((job) => {
          this.syncingJobIds.delete(`${job.queueName}:${job.jobId}`);
        });

        const errorMsg = `Failed to sync ${jobsToSync.length} jobs after ${this.maxRetries} retries`;

        if (this.onError) {
          this.onError(new Error(`${errorMsg}: ${err.message}`));
        } else {
          console.error(`Queuedash: ${errorMsg}`, err);
        }
      }
    } finally {
      this.isFlushing = false;
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

  /**
   * Stop the client, close managed resources, and flush remaining jobs
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

    await this.flush();
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      if (this.jobQueue.length > 0) {
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
      if (this.jobQueue.length > 0) {
        console.warn(
          `Queuedash: Process exiting with ${this.jobQueue.length} unsync'd jobs`,
        );
      }
    });
  }
}
