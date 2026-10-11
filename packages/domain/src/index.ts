import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { AssetCode, Network, SpotMarket } from "./market-config.js";

export type AccountType =
  | "main"
  | "spot"
  | "funding"
  | "fee"
  | "hot_wallet"
  | "cold_wallet"
  | "withdrawal_pending"
  | "opening_balance";

export type BalanceBucket =
  | "available"
  | "locked"
  | "pending_deposit"
  | "pending_withdrawal"
  | "on_chain";

export type OrderSide = "buy" | "sell";

export type OrderType = "limit" | "market";

export type TimeInForce = "gtc" | "ioc" | "fok";

export type OrderStatus =
  | "pending_risk"
  | "accepted"
  | "partially_filled"
  | "recovery_pending"
  | "filled"
  | "cancelled"
  | "rejected";

export type TransferDirection = "debit" | "credit";

export type DepositStatus =
  | "detected"
  | "confirming"
  | "confirmed"
  | "credited"
  | "failed";

export type WithdrawalStatus =
  | "requested"
  | "reviewing"
  | "approved"
  | "broadcasted"
  | "confirmed"
  | "failed";

export interface Money {
  assetCode: AssetCode;
  amount: string;
}

export interface Account {
  accountId: string;
  userId: string;
  type: AccountType;
  status: "active" | "suspended" | "closed";
}

export interface Balance {
  balanceId: string;
  accountId: string;
  assetCode: AssetCode;
  bucket: BalanceBucket;
  amount: string;
  updatedAt: string;
}

export interface Deposit {
  depositId: string;
  userId: string;
  assetCode: AssetCode;
  network: Network;
  txHash: string;
  amount: string;
  confirmations: number;
  status: DepositStatus;
}

export interface Withdrawal {
  withdrawalId: string;
  userId: string;
  assetCode: AssetCode;
  network: Network;
  toAddress: string;
  amount: string;
  fee: string;
  status: WithdrawalStatus;
}

export interface Order {
  orderId: string;
  userId: string;
  market: string;
  side: OrderSide;
  type: OrderType;
  price: string | null;
  quantity: string;
  filledQuantity: string;
  restingQuantity: string;
  timeInForce: TimeInForce;
  status: OrderStatus;
  createdAt: string;
}

export interface Trade {
  tradeId: string;
  market: string;
  price: string;
  quantity: string;
  makerOrderId: string;
  takerOrderId: string;
  buyerOrderId?: string;
  sellerOrderId?: string;
  buyerUserId?: string;
  sellerUserId?: string;
  buyerAccountId?: string;
  sellerAccountId?: string;
  sellerFeeRate?: string;
  /** Buyer fee rate (charged in the base asset). Optional for events published before dual fees. */
  buyerFeeRate?: string;
  executedAt: string;
  executionId?: string;
  executionBatchId?: string;
  executionSequence?: number;
  executionBatchSequence?: number;
  replayCursor?: string;
  protocolVersion?: string;
}

export interface LedgerEntry {
  entryId: string;
  journalId: string;
  accountId: string;
  assetCode: AssetCode;
  direction: TransferDirection;
  amount: string;
  referenceType: string;
  referenceId: string;
}

export interface DomainEvent<TPayload> {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  traceId: string;
  occurredAt: string;
  schemaId?: string;
  schemaVersion?: number;
  payload: TPayload;
}

export type TradingEventType =
  | "order.accepted"
  | "order.updated"
  | "order.cancelled"
  | "order.rejected"
  | "trade.executed";

export interface TradingEventPayload {
  market: SpotMarket;
  userIds: string[];
  order?: Order;
  trade?: Trade;
}

export type TradingEvent = DomainEvent<TradingEventPayload> & {
  eventType: TradingEventType;
  aggregateType: "spot_order" | "spot_trade";
};

export interface TradeEventVersionGate {
  minimumProtocolVersion: string;
  maximumProtocolVersion: string;
  supportedProtocolVersions: string[];
}

export const INTERNAL_SERVICE_CALLER_HEADER = "x-internal-service-name";
export const INTERNAL_SERVICE_TIMESTAMP_HEADER = "x-internal-service-timestamp";
export const INTERNAL_SERVICE_SIGNATURE_HEADER = "x-internal-service-signature";
export const INTERNAL_SERVICE_DEFAULT_MAX_SKEW_MS = 30_000;

export interface InternalServiceAuthHeaders {
  callerName: string;
  timestamp: string;
  signature: string;
}

export function hashRequestBody(rawBody?: Buffer | string): string {
  const bodyBuffer =
    rawBody === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(rawBody)
        ? rawBody
        : Buffer.from(rawBody);

  return createHash("sha256").update(bodyBuffer).digest("hex");
}

/**
 * A bare trailing "?" is not stable on the wire: Node 22's fetch sends
 * "/p?" as "/p" while Node 26 keeps it, so signer and verifier could see
 * different paths. Both sides sign the path without it.
 */
export function normalizeInternalServicePath(path: string): string {
  return path.endsWith("?") ? path.slice(0, -1) : path;
}

export function buildInternalServiceCanonicalRequest(input: {
  callerName: string;
  method: string;
  path: string;
  timestamp: string;
  rawBody?: Buffer | string;
}): string {
  return [
    input.callerName,
    input.method.toUpperCase(),
    normalizeInternalServicePath(input.path),
    input.timestamp,
    hashRequestBody(input.rawBody)
  ].join("\n");
}

export function createInternalServiceSignature(input: {
  secret: string;
  callerName: string;
  method: string;
  path: string;
  timestamp: string;
  rawBody?: Buffer | string;
}): string {
  return createHmac("sha256", input.secret)
    .update(buildInternalServiceCanonicalRequest(input))
    .digest("hex");
}

export function verifyInternalServiceSignature(input: {
  secret: string;
  callerName: string;
  method: string;
  path: string;
  timestamp: string;
  rawBody?: Buffer | string;
  signature: string;
}): boolean {
  const expected = createInternalServiceSignature(input);
  const received = input.signature.trim().toLowerCase();

  if (received.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

export function createInternalServiceAuthHeaders(input: {
  secret: string;
  callerName: string;
  method: string;
  path: string;
  timestamp?: string;
  rawBody?: Buffer | string;
  headers?: Record<string, string>;
}): Record<string, string> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  return {
    ...(input.headers ?? {}),
    [INTERNAL_SERVICE_CALLER_HEADER]: input.callerName,
    [INTERNAL_SERVICE_TIMESTAMP_HEADER]: timestamp,
    [INTERNAL_SERVICE_SIGNATURE_HEADER]: createInternalServiceSignature({
      secret: input.secret,
      callerName: input.callerName,
      method: input.method,
      path: input.path,
      timestamp,
      rawBody: input.rawBody
    })
  };
}

export function readInternalServiceAuthHeaders(
  headers: Record<string, string | string[] | undefined>
): InternalServiceAuthHeaders | undefined {
  const callerName = readHeaderValue(headers, INTERNAL_SERVICE_CALLER_HEADER);
  const timestamp = readHeaderValue(headers, INTERNAL_SERVICE_TIMESTAMP_HEADER);
  const signature = readHeaderValue(headers, INTERNAL_SERVICE_SIGNATURE_HEADER);

  if (!callerName && !timestamp && !signature) {
    return undefined;
  }

  if (!callerName || !timestamp || !signature) {
    return undefined;
  }

  return {
    callerName,
    timestamp,
    signature
  };
}

export function isInternalServiceTimestampFresh(input: {
  timestamp: string;
  now?: number;
  maxSkewMs?: number;
}): boolean {
  const issuedAt = Date.parse(input.timestamp);
  if (!Number.isFinite(issuedAt)) {
    return false;
  }

  const now = input.now ?? Date.now();
  const maxSkewMs = input.maxSkewMs ?? INTERNAL_SERVICE_DEFAULT_MAX_SKEW_MS;
  return Math.abs(now - issuedAt) <= maxSkewMs;
}

function readHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  key: string
): string | undefined {
  const value = headers[key];
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

export interface TradeExecutedEventSchema {
  eventType: "trade.executed";
  schemaId: "trade.executed";
  schemaVersion: number;
  protocolVersion: string;
  aggregateType: "spot_trade";
  requiredTradeFields: string[];
}

export interface TradeEventConsumerCheckpoint {
  consumerId: string;
  eventType: "trade.executed";
  market: SpotMarket;
  schemaId: string;
  schemaVersion: number;
  protocolVersion: string;
  lastEventId: string;
  lastTradeId: string;
  lastExecutionSequence: number;
  lastReplayCursor: string;
  lastStreamEntryId?: string;
  lastStreamPublishedAt?: string;
  updatedAt: string;
}

const TRADE_EXECUTED_EVENT_REQUIRED_FIELDS = [
  "tradeId",
  "market",
  "price",
  "quantity",
  "makerOrderId",
  "takerOrderId",
  "buyerOrderId",
  "sellerOrderId",
  "buyerUserId",
  "sellerUserId",
  "buyerAccountId",
  "sellerAccountId",
  "sellerFeeRate",
  "executedAt",
  "executionId",
  "executionBatchId",
  "executionSequence",
  "executionBatchSequence",
  "replayCursor",
  "protocolVersion"
] as const;

export const TRADE_EXECUTED_EVENT_SCHEMAS: TradeExecutedEventSchema[] = [
  {
    eventType: "trade.executed",
    schemaId: "trade.executed",
    schemaVersion: 2,
    protocolVersion: "v2",
    aggregateType: "spot_trade",
    requiredTradeFields: [...TRADE_EXECUTED_EVENT_REQUIRED_FIELDS]
  }
];

export const DEFAULT_TRADE_EVENT_VERSION_GATE: TradeEventVersionGate = {
  minimumProtocolVersion: "v2",
  maximumProtocolVersion: "v2",
  supportedProtocolVersions: ["v2"]
};

type RequiredTradeExecutedEventFields = Pick<
  Trade,
  (typeof TRADE_EXECUTED_EVENT_REQUIRED_FIELDS)[number]
>;

export function getTradeExecutedEventSchema(
  protocolVersion: string
): TradeExecutedEventSchema | undefined {
  return TRADE_EXECUTED_EVENT_SCHEMAS.find((schema) => schema.protocolVersion === protocolVersion);
}

export function isTradeExecutedEvent(
  event: TradingEvent
): event is TradingEvent & { eventType: "trade.executed"; payload: TradingEventPayload & { trade: Trade } } {
  return event.eventType === "trade.executed" && !!event.payload.trade;
}

export function validateTradeExecutedEvent(
  event: TradingEvent,
  versionGate: TradeEventVersionGate = DEFAULT_TRADE_EVENT_VERSION_GATE
): {
  event: TradingEvent & {
    eventType: "trade.executed";
    payload: TradingEventPayload & { trade: Trade & Required<RequiredTradeExecutedEventFields> };
  };
  schema: TradeExecutedEventSchema;
  trade: Trade & Required<RequiredTradeExecutedEventFields>;
  protocolVersion: string;
} {
  if (!isTradeExecutedEvent(event)) {
    throw new Error(`Expected trade.executed event, received ${event.eventType}`);
  }

  const trade = event.payload.trade;
  const protocolVersion = trade.protocolVersion ?? "v1";
  if (!isProtocolVersionSupported(protocolVersion, versionGate)) {
    throw new Error(`Unsupported trade event protocol version ${protocolVersion}`);
  }

  const schema = getTradeExecutedEventSchema(protocolVersion);
  if (!schema) {
    throw new Error(`Schema registry does not contain protocol version ${protocolVersion}`);
  }

  if (event.aggregateType !== schema.aggregateType) {
    throw new Error(
      `trade.executed aggregateType ${event.aggregateType} does not match schema ${schema.aggregateType}`
    );
  }
  if (event.schemaId && event.schemaId !== schema.schemaId) {
    throw new Error(`trade.executed schemaId ${event.schemaId} does not match ${schema.schemaId}`);
  }
  if (event.schemaVersion && event.schemaVersion !== schema.schemaVersion) {
    throw new Error(
      `trade.executed schemaVersion ${event.schemaVersion.toString()} does not match ${schema.schemaVersion.toString()}`
    );
  }
  if (trade.market !== event.payload.market) {
    throw new Error(`trade.executed market ${trade.market} does not match payload market ${event.payload.market}`);
  }

  for (const field of schema.requiredTradeFields) {
    const value = trade[field as keyof Trade];
    if (typeof value === "string" && value.trim().length === 0) {
      throw new Error(`trade.executed is missing required field ${field}`);
    }
    if (value === undefined || value === null) {
      throw new Error(`trade.executed is missing required field ${field}`);
    }
  }

  if (!Number.isFinite(trade.executionSequence) || !Number.isInteger(trade.executionSequence)) {
    throw new Error("trade.executed executionSequence must be an integer");
  }
  if (!Number.isFinite(trade.executionBatchSequence) || !Number.isInteger(trade.executionBatchSequence)) {
    throw new Error("trade.executed executionBatchSequence must be an integer");
  }

  return {
    event: event as TradingEvent & {
      eventType: "trade.executed";
      payload: TradingEventPayload & { trade: Trade & Required<RequiredTradeExecutedEventFields> };
    },
    schema,
    trade: trade as Trade & Required<RequiredTradeExecutedEventFields>,
    protocolVersion
  };
}

export function compareTradeExecutedEvents(left: TradingEvent, right: TradingEvent): number {
  const leftEvent = validateTradeExecutedEvent(left);
  const rightEvent = validateTradeExecutedEvent(right);

  if (leftEvent.trade.market !== rightEvent.trade.market) {
    return leftEvent.trade.market.localeCompare(rightEvent.trade.market);
  }
  if (leftEvent.trade.executionSequence !== rightEvent.trade.executionSequence) {
    return leftEvent.trade.executionSequence - rightEvent.trade.executionSequence;
  }
  return leftEvent.trade.replayCursor.localeCompare(rightEvent.trade.replayCursor);
}

export function buildTradeEventConsumerCheckpoint(
  consumerId: string,
  event: TradingEvent,
  updatedAt?: string,
  options: {
    lastStreamEntryId?: string;
    lastStreamPublishedAt?: string;
  } = {}
): TradeEventConsumerCheckpoint {
  const validated = validateTradeExecutedEvent(event);
  return {
    consumerId,
    eventType: "trade.executed",
    market: validated.trade.market as SpotMarket,
    schemaId: validated.schema.schemaId,
    schemaVersion: validated.schema.schemaVersion,
    protocolVersion: validated.protocolVersion,
    lastEventId: validated.event.eventId,
    lastTradeId: validated.trade.tradeId,
    lastExecutionSequence: validated.trade.executionSequence,
    lastReplayCursor: validated.trade.replayCursor,
    lastStreamEntryId: options.lastStreamEntryId,
    lastStreamPublishedAt: options.lastStreamPublishedAt,
    updatedAt: updatedAt ?? validated.event.occurredAt
  };
}

export function isProtocolVersionSupported(
  protocolVersion: string,
  versionGate: TradeEventVersionGate = DEFAULT_TRADE_EVENT_VERSION_GATE
): boolean {
  if (!versionGate.supportedProtocolVersions.includes(protocolVersion)) {
    return false;
  }

  return (
    compareProtocolVersions(protocolVersion, versionGate.minimumProtocolVersion) >= 0 &&
    compareProtocolVersions(protocolVersion, versionGate.maximumProtocolVersion) <= 0
  );
}

export function compareProtocolVersions(left: string, right: string): number {
  return parseProtocolVersion(left) - parseProtocolVersion(right);
}

function parseProtocolVersion(version: string): number {
  const match = /^v(\d+)$/.exec(version.trim());
  if (!match) {
    throw new Error(`Unsupported protocol version format: ${version}`);
  }

  return Number(match[1]);
}

export * from "./decimal.js";
export * from "./market-config.js";
