import type {
  ControlSwitchEntry,
  ControlSwitchScope,
  ControlSwitchSource
} from "@web3-cex/domain";

/** One appended row of the switch audit trail (`risk_control_switch_events`). */
export interface ControlSwitchEvent {
  eventId: string;
  switchKey: string;
  scope: ControlSwitchScope;
  assetCode?: string;
  action: "enabled" | "disabled";
  reason: string | null;
  source: ControlSwitchSource;
  operator: string;
  createdAt: string;
}

export interface ControlSwitchRepository {
  listActive(): Promise<ControlSwitchEntry[]>;
  /** Upserts the active row and appends an `enabled` event, atomically. */
  enable(entry: ControlSwitchEntry): Promise<ControlSwitchEntry>;
  /** Deletes the active row (if any) and appends a `disabled` event. Returns the removed row. */
  disable(params: {
    scope: ControlSwitchScope;
    assetCode?: string;
    reason: string | null;
    source: ControlSwitchSource;
    operator: string;
    at: string;
  }): Promise<ControlSwitchEntry | null>;
  listEvents(limit: number): Promise<ControlSwitchEvent[]>;
}

export interface SetControlSwitchCommand {
  scope: ControlSwitchScope;
  assetCode?: string;
  enabled: boolean;
  reason?: string;
  operator?: string;
  source?: ControlSwitchSource;
}

export interface SetControlSwitchResult {
  /** False when the request did not change anything (already on / already off, or a manual pause kept). */
  changed: boolean;
  entry: ControlSwitchEntry | null;
}
