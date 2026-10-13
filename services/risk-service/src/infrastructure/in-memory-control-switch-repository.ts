import { controlSwitchKey, type ControlSwitchEntry } from "@web3-cex/domain";

import type { ControlSwitchEvent, ControlSwitchRepository } from "../domain/control-switches.js";

export class InMemoryControlSwitchRepository implements ControlSwitchRepository {
  private readonly active = new Map<string, ControlSwitchEntry>();
  private readonly events: ControlSwitchEvent[] = [];

  async listActive(): Promise<ControlSwitchEntry[]> {
    return [...this.active.values()].map((entry) => ({ ...entry }));
  }

  async enable(entry: ControlSwitchEntry): Promise<ControlSwitchEntry> {
    const key = controlSwitchKey(entry.scope, entry.assetCode);
    this.active.set(key, { ...entry });
    this.events.push({
      eventId: String(this.events.length + 1),
      switchKey: key,
      scope: entry.scope,
      assetCode: entry.assetCode,
      action: "enabled",
      reason: entry.reason,
      source: entry.source,
      operator: entry.updatedBy,
      createdAt: entry.updatedAt
    });
    return { ...entry };
  }

  async disable(params: Parameters<ControlSwitchRepository["disable"]>[0]): Promise<ControlSwitchEntry | null> {
    const key = controlSwitchKey(params.scope, params.assetCode);
    const existing = this.active.get(key) ?? null;
    this.active.delete(key);
    this.events.push({
      eventId: String(this.events.length + 1),
      switchKey: key,
      scope: params.scope,
      assetCode: params.assetCode,
      action: "disabled",
      reason: params.reason,
      source: params.source,
      operator: params.operator,
      createdAt: params.at
    });
    return existing;
  }

  async listEvents(limit: number): Promise<ControlSwitchEvent[]> {
    return [...this.events].reverse().slice(0, limit).map((event) => ({ ...event }));
  }
}
