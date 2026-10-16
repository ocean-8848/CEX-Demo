/**
 * Fault lab: controlled, self-expiring faults for learning how the
 * exchange degrades and recovers. Each upstream owns its own switch:
 *
 * - settlement-service: pause the trade event consumer
 * - custody-adapter: make a mock custody provider fail (circuit breaker + failover)
 * - demo-simulator: halt block production / roll back blocks (chain reorg)
 * - order-service: reset the matching engine book (optionally its sequences)
 * - blockchain-indexer: acknowledge (clear) the sticky reorg cursor flag
 */
export interface OpsFaultLabClient {
  getSettlementConsumerState(): Promise<Record<string, unknown>>;
  pauseSettlementConsumer(command: {
    durationSeconds?: number;
    reason?: string;
    requestedBy?: string;
  }): Promise<Record<string, unknown>>;
  resumeSettlementConsumer(): Promise<Record<string, unknown>>;

  getCustodyLabState(network?: string): Promise<Record<string, unknown>>;
  injectCustodyFailure(command: {
    providerName?: string;
    durationSeconds?: number;
    reason?: string;
    requestedBy?: string;
  }): Promise<Record<string, unknown>>;
  clearCustodyFailure(command: { providerName?: string }): Promise<Record<string, unknown>>;
  probeCustodyBroadcast(command: { network?: string; count?: number }): Promise<Record<string, unknown>>;

  getChainLabStatus(): Promise<Record<string, unknown>>;
  haltChain(command: {
    durationSeconds?: number;
    reason?: string;
    requestedBy?: string;
  }): Promise<Record<string, unknown>>;
  resumeChain(): Promise<Record<string, unknown>>;
  seedLabDeposit(command: { confirmations?: number }): Promise<Record<string, unknown>>;
  triggerChainReorg(command: {
    depth?: number;
    seedIfEmpty?: boolean;
    requestedBy?: string;
  }): Promise<Record<string, unknown>>;
  acknowledgeIndexerReorg(command: { network: string }): Promise<Record<string, unknown>>;

  resetMatchingEngine(command: {
    market: string;
    resetSequences?: boolean;
  }): Promise<Record<string, unknown>>;
}

/** Only roles holding all three (ops_admin in the default RBAC) may inject faults. */
export const FAULT_LAB_PERMISSIONS = [
  "ops.ledger.execute",
  "ops.providers.manage",
  "ops.indexer.execute"
] as const;

export const FAULT_LAB_AUDIT_PERMISSION = FAULT_LAB_PERMISSIONS.join("+");
