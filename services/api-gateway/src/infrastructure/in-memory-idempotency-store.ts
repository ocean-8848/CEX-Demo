import type { IdempotencyReplay, IdempotencyStore } from "../domain/types.js";

interface StoredValue {
  requestFingerprint: string;
  state: "in_progress" | "completed";
  statusCode?: number;
  responseBody?: string;
  expiresAt: number;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, StoredValue>();

  async begin(input: {
    scopeKey: string;
    idempotencyKey: string;
    requestFingerprint: string;
    ttlMs: number;
    now?: Date;
  }): Promise<IdempotencyReplay> {
    const now = input.now?.getTime() ?? Date.now();
    const key = toStoreKey(input.scopeKey, input.idempotencyKey);
    const existing = this.entries.get(key);

    if (existing && existing.expiresAt > now) {
      if (existing.requestFingerprint !== input.requestFingerprint) {
        return {
          outcome: "conflict"
        };
      }

      if (existing.state === "completed") {
        return {
          outcome: "replay",
          statusCode: existing.statusCode,
          responseBody: existing.responseBody
        };
      }

      return {
        outcome: "in_flight"
      };
    }

    this.entries.set(key, {
      requestFingerprint: input.requestFingerprint,
      state: "in_progress",
      expiresAt: now + input.ttlMs
    });

    return {
      outcome: "acquired"
    };
  }

  async complete(input: {
    scopeKey: string;
    idempotencyKey: string;
    requestFingerprint: string;
    statusCode: number;
    responseBody: string;
    ttlMs: number;
    now?: Date;
  }): Promise<void> {
    const now = input.now?.getTime() ?? Date.now();
    const key = toStoreKey(input.scopeKey, input.idempotencyKey);
    const existing = this.entries.get(key);

    if (!existing || existing.requestFingerprint !== input.requestFingerprint) {
      return;
    }

    this.entries.set(key, {
      requestFingerprint: input.requestFingerprint,
      state: "completed",
      statusCode: input.statusCode,
      responseBody: input.responseBody,
      expiresAt: now + input.ttlMs
    });
  }

  async abort(input: {
    scopeKey: string;
    idempotencyKey: string;
    requestFingerprint: string;
  }): Promise<void> {
    const key = toStoreKey(input.scopeKey, input.idempotencyKey);
    const existing = this.entries.get(key);

    if (existing?.requestFingerprint === input.requestFingerprint) {
      this.entries.delete(key);
    }
  }
}

function toStoreKey(scopeKey: string, idempotencyKey: string): string {
  return `${scopeKey}:${idempotencyKey}`;
}
