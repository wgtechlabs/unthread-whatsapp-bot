import { LogEngine } from "@wgtechlabs/log-engine";
import { createClient, type RedisClientType } from "redis";
import type { UnthreadQueuedEvent } from "../types";
import { processUnthreadOutboundEvent } from "./unthread-outbound";

export interface UnthreadWebhookConsumerConfig {
  redisUrl: string;
  queueName?: string;
  pollIntervalMs?: number;
}

export class UnthreadWebhookConsumer {
  private readonly redisUrl: string;
  private readonly queueName: string;
  private readonly pollIntervalMs: number;
  private isRunning = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private redisClient: RedisClientType | null = null;
  private blockingRedisClient: RedisClientType | null = null;

  constructor(config: UnthreadWebhookConsumerConfig) {
    this.redisUrl = config.redisUrl;
    this.queueName = config.queueName ?? "unthread-events";
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    await this.connect();
    this.isRunning = true;
    LogEngine.info("Webhook consumer started", {
      queueName: this.queueName,
    });
    this.scheduleNextPoll();
  }

  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.blockingRedisClient?.isOpen) {
      await this.blockingRedisClient.disconnect();
    }
    if (this.redisClient?.isOpen) {
      await this.redisClient.disconnect();
    }

    this.blockingRedisClient = null;
    this.redisClient = null;
  }

  private async connect(): Promise<void> {
    this.redisClient = createClient({ url: this.redisUrl });
    this.blockingRedisClient = createClient({ url: this.redisUrl });

    await this.redisClient.connect();
    await this.blockingRedisClient.connect();
  }

  private scheduleNextPoll(): void {
    if (!this.isRunning) {
      return;
    }

    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollForEvents();
      } catch (error) {
        LogEngine.error("Webhook consumer polling error", { error });
      } finally {
        this.scheduleNextPoll();
      }
    }, this.pollIntervalMs);
  }

  private async pollForEvents(): Promise<void> {
    if (!this.blockingRedisClient?.isOpen) {
      return;
    }

    const result = await this.blockingRedisClient.blPop(this.queueName, 1);
    if (!result?.element) {
      return;
    }

    await this.processRawEvent(result.element);
  }

  private async processRawEvent(eventData: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(eventData);
    } catch {
      LogEngine.warn("Skipping webhook queue event: invalid JSON");
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    const event = parsed as UnthreadQueuedEvent;
    if (!event.type || !event.data || typeof event.data !== "object") {
      return;
    }

    await processUnthreadOutboundEvent(event);
  }
}
