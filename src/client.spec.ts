import { EventEmitter } from "events";
import { QueueEvents } from "bullmq";
import { Queuedash } from "./client";
import { JobData } from "./types";

// Stub QueueEvents so attaching a BullMQ queue doesn't connect to Redis
jest.mock("bullmq", () => ({
  QueueEvents: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));
const MockQueueEvents = QueueEvents as unknown as jest.Mock;

// Increase max listeners to avoid warnings from multiple SDK instances
process.setMaxListeners(100);

// Mock timers for testing
jest.useFakeTimers();

describe("Queuedash SDK", () => {
  let sdk: Queuedash;
  let mockFetch: jest.Mock;
  let originalFetch: typeof global.fetch;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    // Store original fetch
    originalFetch = global.fetch;

    // Mock fetch
    mockFetch = jest.fn();
    global.fetch = mockFetch;

    // Spy on console methods
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation();
  });

  afterEach(async () => {
    // Restore console methods first
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();

    // Clean up SDK if it exists
    if (sdk) {
      try {
        // Temporarily restore real timers for cleanup
        jest.useRealTimers();
        // Add timeout protection for stop()
        await Promise.race([
          sdk.stop(),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      } catch {
        // Ignore cleanup errors
      }
      jest.useFakeTimers();
    }

    // Restore original fetch
    global.fetch = originalFetch;

    // Clear all timers
    jest.clearAllTimers();
  });

  describe("Constructor & Configuration", () => {
    it("should throw error when apiKey is missing", () => {
      expect(() => new Queuedash({} as any)).toThrow(
        "Queuedash: apiKey is required",
      );
    });

    it("should throw error when apiKey is empty string", () => {
      expect(() => new Queuedash({ apiKey: "" })).toThrow(
        "Queuedash: apiKey is required",
      );
    });

    it("should initialize with required apiKey", () => {
      sdk = new Queuedash({ apiKey: "test-api-key" });
      expect(sdk).toBeInstanceOf(Queuedash);
    });

    it("should use default values when not provided", () => {
      sdk = new Queuedash({ apiKey: "test-api-key" });

      // We can't directly access private properties, but we can verify behavior
      // by checking that flush is called with default batch size
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, synced: 50 }),
      });

      // Add 50 jobs (default batch size) to trigger flush
      for (let i = 0; i < 50; i++) {
        sdk.syncJob(createMockJobData(`job-${i}`));
      }

      expect(mockFetch).toHaveBeenCalled();
    });

    it("should use production URL in production environment", () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, synced: 1 }),
      });

      sdk = new Queuedash({ apiKey: "test-api-key" });
      sdk.syncJob(createMockJobData("job-1"));
      // Trigger flush by advancing timer
      jest.advanceTimersByTime(100);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("https://sync.queuedash.com"),
        expect.any(Object),
      );

      process.env.NODE_ENV = originalEnv;
    });

    it("should use localhost URL in non-production environment", () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, synced: 1 }),
      });

      sdk = new Queuedash({ apiKey: "test-api-key" });
      sdk.syncJob(createMockJobData("job-1"));
      jest.advanceTimersByTime(100);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("http://localhost:4002"),
        expect.any(Object),
      );

      process.env.NODE_ENV = originalEnv;
    });

    it("should override default URL with baseUrl option", () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, synced: 1 }),
      });

      sdk = new Queuedash({
        apiKey: "test-api-key",
        baseUrl: "https://custom.api.com",
      });
      sdk.syncJob(createMockJobData("job-1"));
      jest.advanceTimersByTime(100);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("https://custom.api.com"),
        expect.any(Object),
      );
    });

    it("should use custom batchSize", () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, synced: 10 }),
      });

      sdk = new Queuedash({ apiKey: "test-api-key", batchSize: 10 });

      // Add 9 jobs - should not trigger flush
      for (let i = 0; i < 9; i++) {
        sdk.syncJob(createMockJobData(`job-${i}`));
      }
      expect(mockFetch).not.toHaveBeenCalled();

      // Add 10th job - should trigger flush
      sdk.syncJob(createMockJobData("job-9"));
      expect(mockFetch).toHaveBeenCalled();
    });

    it("should use custom flushInterval", () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, synced: 1 }),
      });

      sdk = new Queuedash({ apiKey: "test-api-key", flushInterval: 500 });
      sdk.syncJob(createMockJobData("job-1"));

      // Should not flush at 100ms (default)
      jest.advanceTimersByTime(100);
      expect(mockFetch).not.toHaveBeenCalled();

      // Should flush at 500ms (custom)
      jest.advanceTimersByTime(400);
      expect(mockFetch).toHaveBeenCalled();
    });

    it("should call custom onError handler on error", async () => {
      const onError = jest.fn();
      mockFetch.mockRejectedValue(new Error("Network error"));

      sdk = new Queuedash({
        apiKey: "test-api-key",
        maxRetries: 0,
        onError,
      });

      sdk.syncJob(createMockJobData("job-1"));

      // Use real timers for async operations
      jest.useRealTimers();
      await sdk.flush();
      jest.useFakeTimers();

      expect(onError).toHaveBeenCalled();
      expect(onError.mock.calls[0][0].message).toContain("Network error");
    });
  });

  describe("Queue Type Detection", () => {
    beforeEach(() => {
      sdk = new Queuedash({ apiKey: "test-api-key" });
    });

    it("should detect BullMQ Queue (has getJob and opts.connection)", () => {
      const mockBullMQQueue = {
        name: "test-queue",
        getJob: jest.fn(),
        opts: { connection: {} },
        redisPrefix: "bull",
      };

      // BullMQ detection works - attach returns this for chaining
      // and doesn't throw "Unknown queue type"
      const result = sdk.attach(mockBullMQQueue);
      expect(result).toBe(sdk);
    });

    it("should detect BullMQ Worker (has opts.connection, no getJob)", () => {
      const mockBullMQWorker = {
        name: "test-queue",
        opts: { connection: {} },
      };

      // Worker monitoring shows warning
      sdk.attach(mockBullMQWorker);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "Queuedash: Worker monitoring coming soon",
      );
    });

    it("should detect Bull queue (has clients array)", () => {
      const mockBullQueue = {
        name: "test-queue",
        clients: [{}],
        on: jest.fn(),
      };

      sdk.attach(mockBullQueue);
      expect(mockBullQueue.on).toHaveBeenCalled();
    });

    it("should detect Bee-Queue (has settings property)", () => {
      const mockBeeQueue = {
        name: "test-queue",
        settings: {},
        on: jest.fn(),
      };

      sdk.attach(mockBeeQueue);
      expect(mockBeeQueue.on).toHaveBeenCalled();
    });

    it("should throw for unknown queue type", () => {
      const unknownQueue = { name: "test-queue" };

      expect(() => sdk.attach(unknownQueue)).toThrow(
        "Queuedash: Unknown queue type",
      );
    });

    it("should throw for null/undefined resource", () => {
      expect(() => sdk.attach(null)).toThrow("Queuedash: Unknown queue type");
      expect(() => sdk.attach(undefined)).toThrow(
        "Queuedash: Unknown queue type",
      );
    });

    it("should throw for non-object resource", () => {
      expect(() => sdk.attach("not-a-queue")).toThrow(
        "Queuedash: Unknown queue type",
      );
      expect(() => sdk.attach(123)).toThrow("Queuedash: Unknown queue type");
    });
  });

  describe("BullMQ QueueEvents", () => {
    beforeEach(() => {
      MockQueueEvents.mockClear();
      sdk = new Queuedash({ apiKey: "test-api-key" });
    });

    // attach() creates QueueEvents after an async import of bullmq
    const attachAndWait = async (queue: object) => {
      sdk.attach(queue);
      jest.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      jest.useFakeTimers();
    };

    it("should listen with the queue's custom prefix", async () => {
      // Shaped like a BullMQ 5 Queue: the prefix lives in opts, no redisPrefix
      await attachAndWait({
        name: "prefixed-queue",
        getJob: jest.fn(),
        opts: { connection: {}, prefix: "myapp" },
      });

      expect(MockQueueEvents).toHaveBeenCalledTimes(1);
      expect(MockQueueEvents).toHaveBeenCalledWith(
        "prefixed-queue",
        expect.objectContaining({ prefix: "myapp" }),
      );
    });

    it("should fall back to redisPrefix when opts.prefix is not set", async () => {
      await attachAndWait({
        name: "legacy-queue",
        getJob: jest.fn(),
        opts: { connection: {} },
        redisPrefix: "legacy",
      });

      expect(MockQueueEvents).toHaveBeenCalledWith(
        "legacy-queue",
        expect.objectContaining({ prefix: "legacy" }),
      );
    });

    // e.g. the queue shares an ioredis instance with default options: fine
    // for a Queue, but BullMQ rejects it for QueueEvents' blocking connection
    const connectionError = () =>
      new Error(
        "BullMQ: Your redis options maxRetriesPerRequest must be null.",
      );

    it("should report a QueueEvents failure instead of crashing the process", async () => {
      MockQueueEvents.mockImplementationOnce(() => {
        throw connectionError();
      });

      // attach() has already returned when this fails; Jest fails this test
      // if the rejection goes unhandled
      await attachAndWait({
        name: "shared-connection-queue",
        getJob: jest.fn(),
        opts: { connection: {} },
      });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Queuedash: Failed to attach queue "shared-connection-queue"',
        connectionError(),
      );
    });

    it("should pass a QueueEvents failure to onError", async () => {
      const onError = jest.fn();
      sdk = new Queuedash({ apiKey: "test-api-key", onError });
      MockQueueEvents.mockImplementationOnce(() => {
        throw connectionError();
      });

      await attachAndWait({
        name: "shared-connection-queue",
        getJob: jest.fn(),
        opts: { connection: {} },
      });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].message).toBe(
        'Failed to attach queue "shared-connection-queue": ' +
          connectionError().message,
      );
    });

    it("should warn instead of leaving an unhandled rejection when getJob fails", async () => {
      // e.g. the app closed its Queue before calling qd.stop()
      const queue = {
        name: "closed-queue",
        opts: { connection: {} },
        getJob: jest.fn().mockRejectedValue(new Error("Connection is closed.")),
      };
      // Shaped like QueueEvents: an EventEmitter with close()
      const events = Object.assign(new EventEmitter(), {
        close: async () => {},
      });

      sdk.attach(queue, { events });
      events.emit("completed", { jobId: "1" });

      // Let the rejection settle; Jest fails this test if it goes unhandled
      jest.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      jest.useFakeTimers();

      expect(queue.getJob).toHaveBeenCalledWith("1");
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load job 1"),
      );
    });
  });

  describe("attach() Method", () => {
    beforeEach(() => {
      sdk = new Queuedash({ apiKey: "test-api-key" });
    });

    it("should support method chaining", () => {
      const mockBullQueue = {
        name: "test-queue",
        clients: [{}],
        on: jest.fn(),
      };

      const result = sdk.attach(mockBullQueue);
      expect(result).toBe(sdk);
    });

    it("should prevent duplicate Bull queue attachments", () => {
      const mockBullQueue = {
        name: "test-queue",
        clients: [{}],
        on: jest.fn(),
      };

      sdk.attach(mockBullQueue);
      sdk.attach(mockBullQueue);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Queuedash: Queue "test-queue" is already attached',
      );
    });

    it("should prevent duplicate Bee-Queue attachments", () => {
      const mockBeeQueue = {
        name: "test-queue",
        settings: {},
        on: jest.fn(),
      };

      sdk.attach(mockBeeQueue);
      sdk.attach(mockBeeQueue);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Queuedash: Queue "test-queue" is already attached',
      );
    });

    it("should attach Bull queue and listen to events", () => {
      const mockBullQueue = {
        name: "test-queue",
        clients: [{}],
        on: jest.fn(),
      };

      sdk.attach(mockBullQueue);

      expect(mockBullQueue.on).toHaveBeenCalledWith(
        "global:completed",
        expect.any(Function),
      );
      expect(mockBullQueue.on).toHaveBeenCalledWith(
        "global:failed",
        expect.any(Function),
      );
      expect(mockBullQueue.on).toHaveBeenCalledWith(
        "active",
        expect.any(Function),
      );
      expect(mockBullQueue.on).toHaveBeenCalledWith(
        "progress",
        expect.any(Function),
      );
      expect(mockBullQueue.on).toHaveBeenCalledWith(
        "removed",
        expect.any(Function),
      );
    });

    it("should attach Bee-Queue and listen to events", () => {
      const mockBeeQueue = {
        name: "test-queue",
        settings: {},
        on: jest.fn(),
      };

      sdk.attach(mockBeeQueue);

      expect(mockBeeQueue.on).toHaveBeenCalledWith(
        "succeeded",
        expect.any(Function),
      );
      expect(mockBeeQueue.on).toHaveBeenCalledWith(
        "failed",
        expect.any(Function),
      );
      expect(mockBeeQueue.on).toHaveBeenCalledWith(
        "retrying",
        expect.any(Function),
      );
    });
  });

  describe("syncJob() Method", () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, synced: 1 }),
      });

      sdk = new Queuedash({ apiKey: "test-api-key", batchSize: 5 });
    });

    it("should queue job for sync", () => {
      sdk.syncJob(createMockJobData("job-1"));

      // Job should be queued, not flushed yet
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should trigger flush when batch size is reached", () => {
      for (let i = 0; i < 5; i++) {
        sdk.syncJob(createMockJobData(`job-${i}`));
      }

      expect(mockFetch).toHaveBeenCalled();
    });

    it("should deduplicate jobs with same queueName:jobId", () => {
      const job = createMockJobData("job-1");

      sdk.syncJob(job);
      sdk.syncJob(job);
      sdk.syncJob(job);

      // Trigger flush
      jest.advanceTimersByTime(100);

      // Should only sync once
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.jobs).toHaveLength(1);
    });

    it("should respect maxQueueSize and drop oldest jobs", () => {
      sdk = new Queuedash({
        apiKey: "test-api-key",
        batchSize: 100,
        maxQueueSize: 3,
      });

      sdk.syncJob(createMockJobData("job-1"));
      sdk.syncJob(createMockJobData("job-2"));
      sdk.syncJob(createMockJobData("job-3"));
      sdk.syncJob(createMockJobData("job-4")); // Should drop job-1

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Queue size limit reached"),
      );
    });

    it("should not sync when circuit breaker is open", async () => {
      // Open circuit breaker by simulating 10 failures
      mockFetch.mockRejectedValue(new Error("Network error"));

      for (let i = 0; i < 10; i++) {
        sdk.syncJob(createMockJobData(`job-${i}`));
        jest.useRealTimers();
        await sdk.flush();
        jest.useFakeTimers();
      }

      // Reset mock
      mockFetch.mockClear();
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, synced: 1 }),
      });

      // This should be ignored due to circuit breaker
      sdk.syncJob(createMockJobData("job-after-circuit-open"));

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("Snapshot Updates", () => {
    const okResponse = {
      ok: true,
      json: () => Promise.resolve({ success: true, synced: 1 }),
    };

    // Keeps the next sync request in flight until the test settles it
    const holdNextFetch = () => {
      const request = {
        resolve: (_response: unknown) => {},
        reject: (_error: Error) => {},
      };
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            request.resolve = resolve;
            request.reject = reject;
          }),
      );
      return request;
    };

    const sentJobs = (call: number) =>
      JSON.parse(mockFetch.mock.calls[call][1].body).jobs;

    const snapshot = (jobId: string, status: string): JobData => ({
      ...createMockJobData(jobId),
      status,
    });

    beforeEach(() => {
      mockFetch.mockResolvedValue(okResponse);
      sdk = new Queuedash({ apiKey: "test-api-key" });
    });

    it("should replace a pending snapshot with a newer one", () => {
      sdk.syncJob(snapshot("job-1", "waiting"));
      sdk.syncJob(snapshot("job-1", "completed"));

      jest.advanceTimersByTime(100);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(sentJobs(0)).toEqual([
        expect.objectContaining({ jobId: "job-1", status: "completed" }),
      ]);
    });

    it("should send a snapshot that arrives while the job's batch is in flight", async () => {
      const request = holdNextFetch();
      sdk.syncJob(snapshot("job-1", "waiting"));
      const inFlight = sdk.flush();

      sdk.syncJob(snapshot("job-1", "completed"));
      request.resolve(okResponse);
      await inFlight;

      jest.advanceTimersByTime(100);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(sentJobs(1)).toEqual([
        expect.objectContaining({ jobId: "job-1", status: "completed" }),
      ]);
    });

    it("should not requeue a failed snapshot over a newer one", async () => {
      const request = holdNextFetch();
      sdk.syncJob(snapshot("job-1", "waiting"));
      const inFlight = sdk.flush();

      sdk.syncJob(snapshot("job-1", "completed"));
      request.reject(new Error("Network error"));
      await inFlight;

      // Retried once the 1s backoff elapses
      jest.advanceTimersByTime(1000);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(sentJobs(1)).toEqual([
        expect.objectContaining({ jobId: "job-1", status: "completed" }),
      ]);
    });

    it("should send snapshots queued behind an in-flight flush on stop()", async () => {
      const request = holdNextFetch();
      sdk.syncJob(snapshot("job-1", "waiting"));
      const inFlight = sdk.flush();

      sdk.syncJob(snapshot("job-1", "completed"));
      const stopped = sdk.stop();
      request.resolve(okResponse);
      await Promise.all([inFlight, stopped]);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(sentJobs(1)).toEqual([
        expect.objectContaining({ jobId: "job-1", status: "completed" }),
      ]);
    });

    it("should accept new snapshots for a job dropped by maxQueueSize", () => {
      sdk = new Queuedash({
        apiKey: "test-api-key",
        batchSize: 100,
        maxQueueSize: 2,
      });

      sdk.syncJob(snapshot("job-1", "waiting"));
      sdk.syncJob(snapshot("job-2", "waiting"));
      sdk.syncJob(snapshot("job-3", "waiting")); // drops job-1
      sdk.syncJob(snapshot("job-1", "completed")); // drops job-2

      jest.advanceTimersByTime(100);

      expect(sentJobs(0)).toEqual([
        expect.objectContaining({ jobId: "job-3", status: "waiting" }),
        expect.objectContaining({ jobId: "job-1", status: "completed" }),
      ]);
    });
  });

  describe("flush() Method", () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, synced: 1 }),
      });

      sdk = new Queuedash({ apiKey: "test-api-key" });
    });

    it("should make POST request to correct endpoint", async () => {
      sdk.syncJob(createMockJobData("job-1"));

      jest.useRealTimers();
      await sdk.flush();
      jest.useFakeTimers();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/jobs/sync"),
        expect.objectContaining({
          method: "POST",
        }),
      );
    });

    it("should include Authorization header", async () => {
      sdk.syncJob(createMockJobData("job-1"));

      jest.useRealTimers();
      await sdk.flush();
      jest.useFakeTimers();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-api-key",
          }),
        }),
      );
    });

    it("should include Content-Type header", async () => {
      sdk.syncJob(createMockJobData("job-1"));

      jest.useRealTimers();
      await sdk.flush();
      jest.useFakeTimers();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        }),
      );
    });

    it("should send jobs in request body", async () => {
      sdk.syncJob(createMockJobData("job-1"));

      jest.useRealTimers();
      await sdk.flush();
      jest.useFakeTimers();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.jobs).toBeDefined();
      expect(body.jobs).toHaveLength(1);
      expect(body.jobs[0].jobId).toBe("job-1");
    });

    it("should clear jobs from queue after successful sync", async () => {
      sdk.syncJob(createMockJobData("job-1"));

      jest.useRealTimers();
      await sdk.flush();
      jest.useFakeTimers();

      // Flush again - should not make another request
      jest.useRealTimers();
      await sdk.flush();
      jest.useFakeTimers();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should not flush when queue is empty", async () => {
      jest.useRealTimers();
      await sdk.flush();
      jest.useFakeTimers();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should not flush when already flushing", async () => {
      // Create a slow fetch
      mockFetch.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  json: () => Promise.resolve({ success: true, synced: 1 }),
                }),
              100,
            ),
          ),
      );

      sdk.syncJob(createMockJobData("job-1"));
      sdk.syncJob(createMockJobData("job-2"));

      jest.useRealTimers();
      // Start two flushes concurrently
      const flush1 = sdk.flush();
      const flush2 = sdk.flush();

      await Promise.all([flush1, flush2]);
      jest.useFakeTimers();

      // Only one fetch should have been made
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should warn on partial success", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            success: false,
            synced: 0,
            errors: ["Queue not found"],
          }),
      });

      sdk.syncJob(createMockJobData("job-1"));

      jest.useRealTimers();
      await sdk.flush();
      jest.useFakeTimers();

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Some jobs failed to sync"),
        expect.any(Array),
      );
    });

    it("should retry on failure with exponential backoff", async () => {
      let attempts = 0;
      mockFetch.mockImplementation(() => {
        attempts++;
        if (attempts < 3) {
          return Promise.reject(new Error("Network error"));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, synced: 1 }),
        });
      });

      sdk = new Queuedash({ apiKey: "test-api-key", maxRetries: 5 });
      sdk.syncJob(createMockJobData("job-1"));

      jest.useRealTimers();
      await sdk.flush();

      // Wait for retries
      await new Promise((resolve) => setTimeout(resolve, 5000));
      jest.useFakeTimers();

      expect(attempts).toBeGreaterThanOrEqual(3);
    });

    it("should handle HTTP error responses", async () => {
      const onError = jest.fn();
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });

      sdk = new Queuedash({
        apiKey: "invalid-key",
        maxRetries: 0,
        onError,
      });
      sdk.syncJob(createMockJobData("job-1"));

      jest.useRealTimers();
      await sdk.flush();
      jest.useFakeTimers();

      expect(onError).toHaveBeenCalled();
      expect(onError.mock.calls[0][0].message).toContain("401");
    });

    it("should clear the request timeout when fetch rejects", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));
      sdk = new Queuedash({ apiKey: "test-api-key", maxRetries: 0 });
      sdk.syncJob(createMockJobData("job-1"));
      const timerCount = jest.getTimerCount();

      await sdk.flush();

      // A leftover abort timer would keep the process alive for 30s
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(timerCount);
    });

    it("should time out a response body that stalls", async () => {
      mockFetch.mockImplementation((_url: string, { signal }: RequestInit) =>
        Promise.resolve(stalledResponse(signal!, { ok: true })),
      );
      const onError = jest.fn();
      sdk = new Queuedash({
        apiKey: "test-api-key",
        maxRetries: 0,
        requestTimeout: 5000,
        onError,
      });
      sdk.syncJob(createMockJobData("job-1"));

      sdk.flush();
      await jest.advanceTimersByTimeAsync(4999);
      expect(onError).not.toHaveBeenCalled();

      // Fails at requestTimeout instead of blocking every later flush
      await jest.advanceTimersByTimeAsync(1);
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });

  describe("Retry Backoff", () => {
    const okResponse = {
      ok: true,
      json: () => Promise.resolve({ success: true, synced: 1 }),
    };
    let onError: jest.Mock;

    beforeEach(() => {
      onError = jest.fn();
      mockFetch.mockRejectedValue(new Error("Network error"));
    });

    it("should not retry before each backoff elapses", async () => {
      sdk = new Queuedash({ apiKey: "test-api-key", onError });
      sdk.syncJob(createMockJobData("job-1"));

      await jest.advanceTimersByTimeAsync(100); // periodic flush: attempt 1
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // The periodic flush keeps ticking every 100ms throughout
      for (const backoffMs of [1000, 2000, 4000, 8000, 16000]) {
        const attempts = mockFetch.mock.calls.length;

        await jest.advanceTimersByTimeAsync(backoffMs - 1);
        expect(mockFetch).toHaveBeenCalledTimes(attempts);

        await jest.advanceTimersByTimeAsync(1);
        expect(mockFetch).toHaveBeenCalledTimes(attempts + 1);
      }

      // The sixth failed attempt uses up maxRetries (5)
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].message).toContain(
        "Failed to sync 1 jobs after 5 retries",
      );
    });

    it("should not flush a full batch before the backoff elapses", async () => {
      // No periodic flush within the test, only batch-size flushes
      sdk = new Queuedash({
        apiKey: "test-api-key",
        batchSize: 2,
        flushInterval: 60000,
        onError,
      });

      sdk.syncJob(createMockJobData("job-1"));
      sdk.syncJob(createMockJobData("job-2"));
      await jest.advanceTimersByTimeAsync(0); // attempt 1 fails

      sdk.syncJob(createMockJobData("job-3"));
      sdk.syncJob(createMockJobData("job-4"));
      await jest.advanceTimersByTimeAsync(999);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // The retry also sends the jobs held back during the backoff
      mockFetch.mockResolvedValue(okResponse);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(mockFetch.mock.calls[1][1].body).jobs).toHaveLength(4);
    });

    it("should not wait for the backoff on an explicit flush()", async () => {
      sdk = new Queuedash({ apiKey: "test-api-key", onError });
      sdk.syncJob(createMockJobData("job-1"));
      await jest.advanceTimersByTimeAsync(100); // attempt 1 fails

      mockFetch.mockResolvedValue(okResponse);
      await sdk.flush();
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // The success cancels the backoff, so periodic flushes resume
      sdk.syncJob(createMockJobData("job-2"));
      await jest.advanceTimersByTimeAsync(100);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("should resume flushing held jobs after the circuit breaker resets", async () => {
      sdk = new Queuedash({ apiKey: "test-api-key", maxRetries: 20, onError });
      sdk.syncJob(createMockJobData("job-1"));

      // 10 consecutive failures, 1s, 2s, 4s, 8s, 16s, then 30s (capped) apart
      await jest.advanceTimersByTimeAsync(
        100 + 1000 + 2000 + 4000 + 8000 + 16000 + 30000 * 4,
      );
      expect(mockFetch).toHaveBeenCalledTimes(10);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Circuit breaker opened"),
      );

      // Nothing is sent while it's open, including the retry due 30s later
      await jest.advanceTimersByTimeAsync(59999);
      expect(mockFetch).toHaveBeenCalledTimes(10);

      // It resets after 60s and the next periodic flush sends the held job
      mockFetch.mockResolvedValue(okResponse);
      await jest.advanceTimersByTimeAsync(101);
      expect(mockFetch).toHaveBeenCalledTimes(11);
    });

    it("should make one final attempt on stop() instead of waiting out the backoff", async () => {
      sdk = new Queuedash({ apiKey: "test-api-key", onError });
      sdk.syncJob(createMockJobData("job-1"));
      await jest.advanceTimersByTimeAsync(100); // attempt 1 fails

      mockFetch.mockResolvedValue(okResponse);
      await sdk.stop();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(mockFetch.mock.calls[1][1].body).jobs).toEqual([
        expect.objectContaining({ jobId: "job-1" }),
      ]);
      expect(onError).not.toHaveBeenCalled();
    });

    it("should report instead of retrying when the final attempt on stop() fails", async () => {
      sdk = new Queuedash({ apiKey: "test-api-key", onError });
      sdk.syncJob(createMockJobData("job-1"));
      await jest.advanceTimersByTimeAsync(100); // attempt 1 fails

      await sdk.stop();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].message).toContain(
        "Failed to sync 1 jobs while stopping",
      );

      await jest.advanceTimersByTimeAsync(60000);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("deleteJob() Method", () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      sdk = new Queuedash({ apiKey: "test-api-key" });
    });

    it("should make DELETE request to correct endpoint", async () => {
      jest.useRealTimers();
      await sdk.deleteJob("job-123", "test-queue");
      jest.useFakeTimers();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/jobs/job-123"),
        expect.objectContaining({
          method: "DELETE",
        }),
      );
    });

    it("should include queue name in query string", async () => {
      jest.useRealTimers();
      await sdk.deleteJob("job-123", "test-queue");
      jest.useFakeTimers();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("queueName=test-queue"),
        expect.any(Object),
      );
    });

    it("should URL encode job ID and queue name", async () => {
      jest.useRealTimers();
      await sdk.deleteJob("job/with/slashes", "queue with spaces");
      jest.useFakeTimers();

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain("job%2Fwith%2Fslashes");
      expect(url).toContain("queue%20with%20spaces");
    });

    it("should include Authorization header", async () => {
      jest.useRealTimers();
      await sdk.deleteJob("job-123", "test-queue");
      jest.useFakeTimers();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-api-key",
          }),
        }),
      );
    });

    it("should call onError on failure", async () => {
      const onError = jest.fn();
      mockFetch.mockRejectedValue(new Error("Network error"));

      sdk = new Queuedash({ apiKey: "test-api-key", onError });

      jest.useRealTimers();
      await sdk.deleteJob("job-123", "test-queue");
      jest.useFakeTimers();

      expect(onError).toHaveBeenCalled();
      expect(onError.mock.calls[0][0].message).toContain(
        "Failed to delete job",
      );
    });

    it("should log error when no onError handler", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      jest.useRealTimers();
      await sdk.deleteJob("job-123", "test-queue");
      jest.useFakeTimers();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to delete job"),
        expect.any(Error),
      );
    });

    it("should clear the request timeout when fetch rejects", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));
      const timerCount = jest.getTimerCount();

      await sdk.deleteJob("job-123", "test-queue");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(timerCount);
    });

    it("should time out an error response body that stalls", async () => {
      mockFetch.mockImplementation((_url: string, { signal }: RequestInit) =>
        Promise.resolve(stalledResponse(signal!, { ok: false, status: 500 })),
      );
      const onError = jest.fn();
      sdk = new Queuedash({
        apiKey: "test-api-key",
        requestTimeout: 5000,
        onError,
      });

      sdk.deleteJob("job-123", "test-queue");
      await jest.advanceTimersByTimeAsync(4999);
      expect(onError).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });

  describe("Circuit Breaker", () => {
    beforeEach(() => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      sdk = new Queuedash({
        apiKey: "test-api-key",
        maxRetries: 0, // No retries for faster testing
      });
    });

    it("should open after 10 consecutive failures", async () => {
      jest.useRealTimers();

      for (let i = 0; i < 10; i++) {
        sdk.syncJob(createMockJobData(`job-${i}`));
        await sdk.flush();
      }

      jest.useFakeTimers();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Circuit breaker opened"),
      );
    });

    it("should stop syncing when open", async () => {
      jest.useRealTimers();

      // Open circuit breaker
      for (let i = 0; i < 10; i++) {
        sdk.syncJob(createMockJobData(`job-${i}`));
        await sdk.flush();
      }

      // Clear mock
      mockFetch.mockClear();

      // This should not make a request
      sdk.syncJob(createMockJobData("job-after-open"));
      await sdk.flush();

      jest.useFakeTimers();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should auto-reset after 60 seconds", async () => {
      // Create SDK with fake timers active so circuit breaker timer uses fake timers
      sdk = new Queuedash({
        apiKey: "test-api-key",
        maxRetries: 0,
      });

      // Open circuit breaker with fake timers
      for (let i = 0; i < 10; i++) {
        sdk.syncJob(createMockJobData(`job-${i}`));
        // Manually trigger the flush promise
        const flushPromise = sdk.flush();
        // Run the promise to completion
        await Promise.resolve();
        try {
          await flushPromise;
        } catch {
          // Expected to fail
        }
      }

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Circuit breaker opened"),
      );

      // Advance time by 60 seconds
      jest.advanceTimersByTime(60000);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Circuit breaker reset"),
      );
    });

    it("should reset failure counter on successful sync", async () => {
      let attempts = 0;
      mockFetch.mockImplementation(() => {
        attempts++;
        if (attempts <= 5) {
          return Promise.reject(new Error("Network error"));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, synced: 1 }),
        });
      });

      sdk = new Queuedash({
        apiKey: "test-api-key",
        maxRetries: 0,
      });

      jest.useRealTimers();

      // 5 failures
      for (let i = 0; i < 5; i++) {
        sdk.syncJob(createMockJobData(`job-${i}`));
        await sdk.flush();
      }

      // 1 success - should reset counter
      sdk.syncJob(createMockJobData("job-success"));
      await sdk.flush();

      // 5 more failures - should not open circuit breaker
      for (let i = 0; i < 5; i++) {
        sdk.syncJob(createMockJobData(`job-after-${i}`));
        await sdk.flush();
      }

      jest.useFakeTimers();

      // Circuit breaker should NOT be open
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Circuit breaker opened"),
      );
    });
  });

  describe("Job Data Extraction", () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, synced: 1 }),
      });

      sdk = new Queuedash({ apiKey: "test-api-key" });
    });

    it("should handle Bull job events and extract data", () => {
      const mockBullQueue = {
        name: "test-queue",
        clients: [{}],
        on: jest.fn(),
      };

      sdk.attach(mockBullQueue);

      // Get the active handler
      const activeHandler = mockBullQueue.on.mock.calls.find(
        (call) => call[0] === "active",
      )[1];

      // Simulate job event
      const mockJob = {
        id: "123",
        name: "test-job",
        data: { foo: "bar" },
        opts: { priority: 1 },
        timestamp: Date.now(),
        processedOn: Date.now(),
        finishedOn: null,
        failedReason: null,
        stacktrace: [],
        progress: () => 50,
      };

      activeHandler(mockJob);

      // Advance timer to trigger flush
      jest.advanceTimersByTime(100);

      expect(mockFetch).toHaveBeenCalled();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.jobs[0].jobId).toBe("123");
      expect(body.jobs[0].name).toBe("test-job");
      expect(body.jobs[0].data).toEqual({ foo: "bar" });
      expect(body.jobs[0].progress).toBe(50);
    });

    it("should load the job for Bull global events, which pass a job id", async () => {
      const mockBullQueue = {
        name: "test-queue",
        clients: [{}],
        on: jest.fn(),
        getJob: jest.fn((jobId: string) =>
          Promise.resolve({
            id: jobId,
            name: "test-job",
            data: { foo: "bar" },
            opts: {},
            timestamp: Date.now(),
            finishedOn: Date.now(),
            progress: () => 100,
          }),
        ),
      };

      sdk.attach(mockBullQueue);

      const handler = (event: string) =>
        mockBullQueue.on.mock.calls.find((call) => call[0] === event)[1];

      // Bull emits global events as (jobId, result, previousState)
      handler("global:completed")("123", '"done"', "active");
      handler("global:failed")("456", "boom", "active");
      await Promise.all(mockBullQueue.getJob.mock.results.map((r) => r.value));

      jest.useRealTimers();
      await sdk.flush();
      jest.useFakeTimers();

      expect(mockBullQueue.getJob).toHaveBeenCalledWith("123");
      expect(mockBullQueue.getJob).toHaveBeenCalledWith("456");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.jobs).toEqual([
        expect.objectContaining({ jobId: "123", data: { foo: "bar" } }),
        expect.objectContaining({ jobId: "456", data: { foo: "bar" } }),
      ]);
    });

    it("should handle Bee-Queue succeeded event and set finishedAt", () => {
      const mockBeeQueue = {
        name: "test-queue",
        settings: {},
        on: jest.fn(),
      };

      sdk.attach(mockBeeQueue);

      // Get the succeeded handler
      const succeededHandler = mockBeeQueue.on.mock.calls.find(
        (call) => call[0] === "succeeded",
      )[1];

      const mockJob = {
        id: 123,
        data: { foo: "bar" },
        options: { timestamp: Date.now() },
      };

      succeededHandler(mockJob);

      jest.advanceTimersByTime(100);

      expect(mockFetch).toHaveBeenCalled();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.jobs[0].jobId).toBe("123");
      expect(body.jobs[0].finishedAt).toBeDefined();
    });

    it("should handle Bee-Queue failed event with error info", () => {
      const mockBeeQueue = {
        name: "test-queue",
        settings: {},
        on: jest.fn(),
      };

      sdk.attach(mockBeeQueue);

      // Get the failed handler
      const failedHandler = mockBeeQueue.on.mock.calls.find(
        (call) => call[0] === "failed",
      )[1];

      const mockJob = {
        id: 456,
        data: { foo: "bar" },
        options: {},
      };

      const error = new Error("Job processing failed");
      error.stack = "Error: Job processing failed\n    at test.js:1:1";

      failedHandler(mockJob, error);

      jest.advanceTimersByTime(100);

      expect(mockFetch).toHaveBeenCalled();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.jobs[0].failedReason).toBe("Job processing failed");
      expect(body.jobs[0].stacktrace).toHaveLength(1);
    });

    it("should handle Bee-Queue retrying event", () => {
      const mockBeeQueue = {
        name: "test-queue",
        settings: {},
        on: jest.fn(),
      };

      sdk.attach(mockBeeQueue);

      // Get the retrying handler
      const retryingHandler = mockBeeQueue.on.mock.calls.find(
        (call) => call[0] === "retrying",
      )[1];

      const mockJob = {
        id: 789,
        data: { foo: "bar" },
        options: {},
      };

      retryingHandler(mockJob);

      jest.advanceTimersByTime(100);

      expect(mockFetch).toHaveBeenCalled();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.jobs[0].retriedAt).toBeDefined();
    });
  });

  describe("Graceful Shutdown", () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, synced: 1 }),
      });

      sdk = new Queuedash({ apiKey: "test-api-key" });
    });

    it("should stop flush timer on stop()", async () => {
      sdk.syncJob(createMockJobData("job-1"));

      jest.useRealTimers();
      await sdk.stop();
      jest.useFakeTimers();

      // The job should have been flushed
      expect(mockFetch).toHaveBeenCalled();
    });

    it("should flush remaining jobs on stop()", async () => {
      sdk.syncJob(createMockJobData("job-1"));
      sdk.syncJob(createMockJobData("job-2"));

      // Don't wait for timer, call stop directly
      jest.useRealTimers();
      await sdk.stop();
      jest.useFakeTimers();

      expect(mockFetch).toHaveBeenCalled();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.jobs).toHaveLength(2);
    });

    it("should close managed QueueEvents on stop()", async () => {
      // We can't easily test this without real BullMQ, but we can ensure stop() doesn't throw
      jest.useRealTimers();
      await expect(sdk.stop()).resolves.not.toThrow();
      jest.useFakeTimers();
    });
  });

  describe("Periodic Flush", () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, synced: 1 }),
      });

      sdk = new Queuedash({
        apiKey: "test-api-key",
        flushInterval: 100,
        batchSize: 1000, // High batch size so it doesn't auto-flush
      });
    });

    it("should flush periodically based on flushInterval", () => {
      sdk.syncJob(createMockJobData("job-1"));

      expect(mockFetch).not.toHaveBeenCalled();

      // Advance time by flush interval
      jest.advanceTimersByTime(100);

      expect(mockFetch).toHaveBeenCalled();
    });

    it("should not flush when queue is empty during periodic flush", () => {
      // Advance time without adding any jobs
      jest.advanceTimersByTime(100);

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});

// Helper function to create mock job data
function createMockJobData(
  jobId: string,
  queueName: string = "test-queue",
): JobData {
  return {
    jobId,
    name: "test-job",
    queueName,
    data: { test: true },
    opts: {},
    addedAt: new Date(),
    processedAt: null,
    finishedAt: null,
  };
}

// Mock response whose headers arrived but whose body never finishes, unless
// the request is aborted
function stalledResponse(signal: AbortSignal, fields: object) {
  const readBody = () =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () =>
        reject(new Error("This operation was aborted")),
      );
    });
  return { ...fields, json: readBody, text: readBody };
}
