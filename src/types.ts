export interface QueuedashOptions {
  /** Your Queuedash API key */
  apiKey: string;
  /** Override the API URL (defaults to https://api.queuedash.com in production) */
  baseUrl?: string;
  /** Number of jobs to batch before syncing (default: 50) */
  batchSize?: number;
  /** How often to flush batched jobs in ms (default: 100) */
  flushInterval?: number;
  /** Max retry attempts for failed syncs (default: 5) */
  maxRetries?: number;
  /** HTTP request timeout in ms (default: 30000) */
  requestTimeout?: number;
  /** Max jobs to queue in memory (default: 10000) */
  maxQueueSize?: number;
  /** Custom error handler */
  onError?: (error: Error) => void;
}

export interface JobData {
  jobId: string;
  name: string;
  queueName: string;
  data?: Record<string, unknown>;
  opts?: Record<string, unknown>;
  addedAt: Date;
  processedAt?: Date | null;
  finishedAt?: Date | null;
  failedReason?: string;
  stacktrace?: string[];
  logs?: string[];
  retriedAt?: Date | null;
  priority?: number | null;
  delay?: number | null;
  timestamp?: number | null;
  progress?: number | null;
}

export interface SyncResponse {
  success: boolean;
  synced: number;
  errors?: string[];
}
