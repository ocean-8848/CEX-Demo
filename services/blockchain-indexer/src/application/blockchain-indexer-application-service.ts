import { randomUUID } from "node:crypto";

import type { AssetCode, Network } from "@web3-cex/domain";

import { BlockchainIndexerError } from "../domain/errors.js";
import type { EvmClient, EvmLog, EvmNetwork } from "../domain/evm-client.js";
import type { BlockchainIndexerRepository } from "../domain/repository.js";
import type {
  CloseDepositObservationCommand,
  DepositWatchAddress,
  EvmDepositScanResult,
  EvmTokenContractConfig,
  EvmWithdrawalScanResult,
  IndexedDepositObservation,
  IndexedWithdrawalObservation,
  ListDepositObservationsQuery,
  ObservationType,
  ObserveDepositCommand,
  ObserveWithdrawalCommand,
  PagedResult,
  ReplayDepositObservationCommand,
  ScanCursor,
  ScanEvmDepositsCommand,
  ScanEvmWithdrawalsCommand,
  WithdrawalWatchTransaction
} from "../domain/types.js";
import type { WalletClient } from "../domain/wallet-client.js";

interface ServiceOptions {
  now?: () => Date;
  createId?: () => string;
  confirmationThreshold?: number;
  maxScanBlockRange?: number;
  walletPageSize?: number;
  evmRpcUrls?: Partial<Record<EvmNetwork, string>>;
  evmNativeAssetCodes?: Partial<Record<EvmNetwork, AssetCode>>;
  evmTokenContracts?: Partial<Record<EvmNetwork, EvmTokenContractConfig[]>>;
  evmClientFactory?: (params: { network: EvmNetwork; rpcUrl: string }) => EvmClient;
}

interface CanonicalDepositMatch {
  network: EvmNetwork;
  assetCode: AssetCode;
  address: string;
  txHash: string;
  amount: string;
  blockNumber: number;
  blockHash: string;
}

const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export class BlockchainIndexerApplicationService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly confirmationThreshold: number;
  private readonly maxScanBlockRange: number;
  private readonly walletPageSize: number;
  private readonly evmRpcUrls: Partial<Record<EvmNetwork, string>>;
  private readonly evmNativeAssetCodes: Partial<Record<EvmNetwork, AssetCode>>;
  private readonly evmTokenContracts: Partial<Record<EvmNetwork, EvmTokenContractConfig[]>>;
  private readonly evmClientFactory: (params: { network: EvmNetwork; rpcUrl: string }) => EvmClient;

  constructor(
    private readonly repository: BlockchainIndexerRepository,
    private readonly walletClient: WalletClient,
    options: ServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.confirmationThreshold = options.confirmationThreshold ?? 12;
    this.maxScanBlockRange = options.maxScanBlockRange ?? 200;
    this.walletPageSize = options.walletPageSize ?? 200;
    this.evmRpcUrls = options.evmRpcUrls ?? {};
    this.evmNativeAssetCodes = options.evmNativeAssetCodes ?? {};
    this.evmTokenContracts = options.evmTokenContracts ?? {};
    this.evmClientFactory =
      options.evmClientFactory ??
      (() => {
        throw new BlockchainIndexerError(
          "EVM_RPC_NOT_CONFIGURED",
          "No EVM client factory configured"
        );
      });
  }

  async observeDeposit(command: ObserveDepositCommand): Promise<IndexedDepositObservation> {
    if (command.confirmations < 0) {
      throw new BlockchainIndexerError(
        "INVALID_CONFIRMATION_COUNT",
        "Confirmations must be greater than or equal to zero"
      );
    }

    if (Number(command.amount) <= 0) {
      throw new BlockchainIndexerError("INVALID_AMOUNT", "Amount must be greater than zero");
    }

    const now = this.now().toISOString();
    const observation = await this.repository.withTransaction(async (repository) => {
      const existing = await repository.findDepositObservationByUniqueKey(
        command.network,
        normalizeHex(command.txHash),
        normalizeHex(command.address)
      );
      const reorgFields = this.buildReorgFields({
        existingBlockNumber: existing?.blockNumber,
        nextBlockNumber: command.blockNumber,
        existingBlockHash: existing?.blockHash,
        nextBlockHash: command.blockHash,
        now
      });
      const nextObservation: IndexedDepositObservation = {
        observationId: existing?.observationId ?? this.createId(),
        network: command.network,
        assetCode: command.assetCode,
        address: normalizeHex(command.address),
        txHash: normalizeHex(command.txHash),
        amount: command.amount,
        confirmations: command.confirmations,
        blockNumber: command.blockNumber,
        blockHash: command.blockHash ? normalizeHex(command.blockHash) : undefined,
        status:
          existing?.status === "credited"
            ? "credited"
            : existing?.status === "closed"
              ? "closed"
            : command.confirmations >= this.confirmationThreshold
              ? "confirming"
              : "detected",
        walletDepositId: existing?.walletDepositId,
        reorgDetectedAt: reorgFields.reorgDetectedAt ?? existing?.reorgDetectedAt,
        reorgedFromBlockNumber:
          reorgFields.reorgedFromBlockNumber ?? existing?.reorgedFromBlockNumber,
        lastManualAction: existing?.lastManualAction,
        lastManualActionAt: existing?.lastManualActionAt,
        lastManualActionBy: existing?.lastManualActionBy,
        lastManualActionNote: existing?.lastManualActionNote,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };

      await repository.upsertDepositObservation(nextObservation);
      await this.saveCursor(repository, {
        observationType: "deposit",
        network: command.network,
        blockNumber: command.blockNumber,
        finalized: false,
        now,
        reorgDetectedAt: reorgFields.reorgDetectedAt,
        reorgDetectedBlock: command.blockNumber
      });

      return nextObservation;
    });

    if (observation.status === "credited") {
      return observation;
    }

    if (command.confirmations < this.confirmationThreshold) {
      return {
        ...observation,
        status: "detected"
      };
    }

    const deposit = await this.walletClient.confirmDeposit({
      network: command.network,
      txHash: normalizeHex(command.txHash),
      address: normalizeHex(command.address),
      amount: command.amount,
      confirmations: command.confirmations,
      blockNumber: command.blockNumber,
      blockHash: command.blockHash ? normalizeHex(command.blockHash) : undefined
    });

    return this.repository.withTransaction(async (repository) => {
      const latest =
        (await repository.findDepositObservationById(observation.observationId)) ?? observation;
      const updatedAt = this.now().toISOString();
      const creditedObservation: IndexedDepositObservation = {
        ...latest,
        status: "credited",
        walletDepositId: deposit.depositId,
        updatedAt
      };

      await repository.upsertDepositObservation(creditedObservation);
      await this.saveCursor(repository, {
        observationType: "deposit",
        network: command.network,
        blockNumber: command.blockNumber,
        finalized: true,
        now: updatedAt,
        reorgDetectedAt: creditedObservation.reorgDetectedAt,
        reorgDetectedBlock: command.blockNumber
      });

      return creditedObservation;
    });
  }

  async observeWithdrawal(
    command: ObserveWithdrawalCommand
  ): Promise<IndexedWithdrawalObservation> {
    if (command.confirmations < 0) {
      throw new BlockchainIndexerError(
        "INVALID_CONFIRMATION_COUNT",
        "Confirmations must be greater than or equal to zero"
      );
    }

    const now = this.now().toISOString();
    const observation = await this.repository.withTransaction(async (repository) => {
      const existing = await repository.findWithdrawalObservationByUniqueKey(
        command.network,
        normalizeHex(command.txHash)
      );
      const reorgFields = this.buildReorgFields({
        existingBlockNumber: existing?.blockNumber,
        nextBlockNumber: command.blockNumber,
        existingBlockHash: existing?.blockHash,
        nextBlockHash: command.blockHash,
        now
      });
      const nextObservation: IndexedWithdrawalObservation = {
        observationId: existing?.observationId ?? this.createId(),
        network: command.network,
        assetCode: command.assetCode,
        txHash: normalizeHex(command.txHash),
        confirmations: command.confirmations,
        blockNumber: command.blockNumber,
        blockHash: command.blockHash ? normalizeHex(command.blockHash) : undefined,
        status:
          existing?.status === "confirmed"
            ? "confirmed"
            : command.confirmations >= this.confirmationThreshold
              ? "confirming"
              : "detected",
        walletWithdrawalId: existing?.walletWithdrawalId,
        reorgDetectedAt: reorgFields.reorgDetectedAt ?? existing?.reorgDetectedAt,
        reorgedFromBlockNumber:
          reorgFields.reorgedFromBlockNumber ?? existing?.reorgedFromBlockNumber,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };

      await repository.upsertWithdrawalObservation(nextObservation);
      await this.saveCursor(repository, {
        observationType: "withdrawal",
        network: command.network,
        blockNumber: command.blockNumber,
        finalized: false,
        now,
        reorgDetectedAt: reorgFields.reorgDetectedAt,
        reorgDetectedBlock: command.blockNumber
      });

      return nextObservation;
    });

    if (observation.status === "confirmed") {
      return observation;
    }

    if (command.confirmations < this.confirmationThreshold) {
      return {
        ...observation,
        status: "detected"
      };
    }

    const withdrawal = await this.walletClient.confirmWithdrawal({
      network: command.network,
      txHash: normalizeHex(command.txHash),
      confirmations: command.confirmations,
      blockNumber: command.blockNumber,
      blockHash: command.blockHash ? normalizeHex(command.blockHash) : undefined
    });

    return this.repository.withTransaction(async (repository) => {
      const latest =
        (await repository.findWithdrawalObservationById(observation.observationId)) ?? observation;
      const updatedAt = this.now().toISOString();
      const confirmedObservation: IndexedWithdrawalObservation = {
        ...latest,
        status: "confirmed",
        walletWithdrawalId: withdrawal.withdrawalId,
        updatedAt
      };

      await repository.upsertWithdrawalObservation(confirmedObservation);
      await this.saveCursor(repository, {
        observationType: "withdrawal",
        network: command.network,
        blockNumber: command.blockNumber,
        finalized: true,
        now: updatedAt,
        reorgDetectedAt: confirmedObservation.reorgDetectedAt,
        reorgDetectedBlock: command.blockNumber
      });

      return confirmedObservation;
    });
  }

  async scanEvmDeposits(command: ScanEvmDepositsCommand): Promise<EvmDepositScanResult> {
    const network = assertEvmNetwork(command.network);
    const client = this.resolveEvmClient(network, command.rpcUrl);
    const headBlock = await client.getBlockNumber();
    const toBlock = normalizeBlockNumber(command.toBlock ?? headBlock, "toBlock");
    const fromBlock = this.resolveDepositFromBlock(
      await this.repository.findScanCursor("deposit", network),
      normalizeOptionalBlockNumber(command.fromBlock, "fromBlock"),
      toBlock
    );
    this.assertValidScanRange(fromBlock, toBlock);

    const watchAddresses = await this.loadDepositWatchAddresses(network, command.watchAddresses);
    const nativeAssetCode = command.nativeAssetCode ?? this.evmNativeAssetCodes[network];
    const tokenContracts = command.tokenContracts ?? this.evmTokenContracts[network] ?? [];
    const pendingObservations = await this.repository.listPendingDepositObservations(
      network,
      fromBlock,
      toBlock
    );
    const pendingByKey = new Map(
      pendingObservations.map((observation) => [
        depositObservationKey(observation.network, observation.txHash, observation.address),
        observation
      ])
    );
    const canonicalMatches = await this.collectEvmDepositMatches({
      client,
      network,
      fromBlock,
      toBlock,
      watchAddresses,
      nativeAssetCode,
      tokenContracts
    });
    const seenObservationKeys = new Set<string>();
    const reorgBlocks: number[] = [];

    for (const match of canonicalMatches) {
      const observationKey = depositObservationKey(match.network, match.txHash, match.address);
      const existing = pendingByKey.get(observationKey);

      if (this.hasReorged(existing, match.blockNumber, match.blockHash)) {
        reorgBlocks.push(existing?.blockNumber ?? match.blockNumber);
      }

      seenObservationKeys.add(observationKey);
      await this.observeDeposit({
        network: match.network,
        assetCode: match.assetCode,
        address: match.address,
        txHash: match.txHash,
        amount: match.amount,
        confirmations: calculateConfirmations(headBlock, match.blockNumber),
        blockNumber: match.blockNumber,
        blockHash: match.blockHash
      });
    }

    const staleObservations = pendingObservations.filter(
      (observation) =>
        observation.blockNumber !== undefined &&
        !seenObservationKeys.has(
          depositObservationKey(observation.network, observation.txHash, observation.address)
        )
    );

    if (staleObservations.length > 0) {
      reorgBlocks.push(
        ...staleObservations
          .map((observation) => observation.blockNumber)
          .filter((blockNumber): blockNumber is number => blockNumber !== undefined)
      );
      await this.repository.deleteDepositObservations(
        staleObservations.map((observation) => observation.observationId)
      );
    }

    const cursor = await this.saveScanCursorSnapshot({
      observationType: "deposit",
      network,
      lastScannedBlock: toBlock,
      lastFinalizedBlock: resolveFinalizedBlock(headBlock, this.confirmationThreshold, toBlock),
      now: this.now().toISOString(),
      reorgDetectedBlock: minDefined(reorgBlocks)
    });

    return {
      network,
      headBlock,
      fromBlock,
      toBlock,
      scannedBlockCount: toBlock - fromBlock + 1,
      matchedObservationCount: canonicalMatches.length,
      rolledBackObservationCount: staleObservations.length,
      reorgDetected: reorgBlocks.length > 0,
      reorgDetectedBlock: minDefined(reorgBlocks),
      cursor
    };
  }

  async scanEvmWithdrawals(command: ScanEvmWithdrawalsCommand): Promise<EvmWithdrawalScanResult> {
    const network = assertEvmNetwork(command.network);
    const client = this.resolveEvmClient(network, command.rpcUrl);
    const headBlock = await client.getBlockNumber();
    const trackedWithdrawals = await this.loadBroadcastedWithdrawals(
      network,
      command.trackedWithdrawals
    );
    const pendingObservations = await this.repository.listPendingWithdrawalObservations(network);
    const pendingByKey = new Map(
      pendingObservations.map((observation) => [
        withdrawalObservationKey(observation.network, observation.txHash),
        observation
      ])
    );
    const matchedObservationKeys = new Set<string>();
    const reorgBlocks: number[] = [];

    for (const withdrawal of trackedWithdrawals) {
      const normalizedTxHash = normalizeHex(withdrawal.txHash);
      const observationKey = withdrawalObservationKey(network, normalizedTxHash);
      const existing = pendingByKey.get(observationKey);
      const receipt = await client.getTransactionReceipt(normalizedTxHash);

      if (!receipt || receipt.status === 0) {
        continue;
      }

      if (this.hasReorged(existing, receipt.blockNumber, receipt.blockHash)) {
        reorgBlocks.push(existing?.blockNumber ?? receipt.blockNumber);
      }

      matchedObservationKeys.add(observationKey);
      await this.observeWithdrawal({
        network,
        assetCode: withdrawal.assetCode,
        txHash: normalizedTxHash,
        confirmations: calculateConfirmations(headBlock, receipt.blockNumber),
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash
      });
    }

    const staleObservations = pendingObservations.filter((observation) => {
      if (observation.blockNumber === undefined) {
        return false;
      }

      const key = withdrawalObservationKey(observation.network, observation.txHash);
      return !matchedObservationKeys.has(key);
    });

    if (staleObservations.length > 0) {
      reorgBlocks.push(
        ...staleObservations
          .map((observation) => observation.blockNumber)
          .filter((blockNumber): blockNumber is number => blockNumber !== undefined)
      );
      await this.repository.deleteWithdrawalObservations(
        staleObservations.map((observation) => observation.observationId)
      );
    }

    const cursor = await this.saveScanCursorSnapshot({
      observationType: "withdrawal",
      network,
      lastScannedBlock: headBlock,
      lastFinalizedBlock: resolveFinalizedBlock(headBlock, this.confirmationThreshold, headBlock),
      now: this.now().toISOString(),
      reorgDetectedBlock: minDefined(reorgBlocks)
    });

    return {
      network,
      headBlock,
      trackedTransactionCount: trackedWithdrawals.length,
      matchedObservationCount: matchedObservationKeys.size,
      rolledBackObservationCount: staleObservations.length,
      reorgDetected: reorgBlocks.length > 0,
      reorgDetectedBlock: minDefined(reorgBlocks),
      cursor
    };
  }

  async runEvmReplay(command: {
    network: EvmNetwork;
    observationType?: ObservationType | "both";
    fromBlock?: number;
    toBlock?: number;
    rpcUrl?: string;
  }): Promise<{
    generatedAt: string;
    network: EvmNetwork;
    observationType: ObservationType | "both";
    depositResult?: EvmDepositScanResult;
    withdrawalResult?: EvmWithdrawalScanResult;
  }> {
    const observationType = command.observationType ?? "both";
    const generatedAt = this.now().toISOString();
    const result: {
      generatedAt: string;
      network: EvmNetwork;
      observationType: ObservationType | "both";
      depositResult?: EvmDepositScanResult;
      withdrawalResult?: EvmWithdrawalScanResult;
    } = {
      generatedAt,
      network: command.network,
      observationType
    };

    if (observationType === "deposit" || observationType === "both") {
      result.depositResult = await this.scanEvmDeposits({
        network: command.network,
        fromBlock: command.fromBlock,
        toBlock: command.toBlock,
        rpcUrl: command.rpcUrl
      });
    }

    if (observationType === "withdrawal" || observationType === "both") {
      result.withdrawalResult = await this.scanEvmWithdrawals({
        network: command.network,
        rpcUrl: command.rpcUrl
      });
    }

    return result;
  }

  async repairEvmBacklog(command: {
    network: EvmNetwork;
    observationType?: ObservationType | "both";
    lookbackBlocks?: number;
    rpcUrl?: string;
  }): Promise<{
    generatedAt: string;
    network: EvmNetwork;
    observationType: ObservationType | "both";
    lookbackBlocks: number;
    depositFromBlock?: number;
    headBlock: number;
    depositResult?: EvmDepositScanResult;
    withdrawalResult?: EvmWithdrawalScanResult;
  }> {
    const client = this.resolveEvmClient(command.network, command.rpcUrl);
    const headBlock = await client.getBlockNumber();
    const observationType = command.observationType ?? "both";
    const lookbackBlocks = command.lookbackBlocks ?? this.maxScanBlockRange;
    if (!Number.isInteger(lookbackBlocks) || lookbackBlocks < 0) {
      throw new BlockchainIndexerError(
        "INVALID_BLOCK_RANGE",
        "lookbackBlocks must be greater than or equal to zero"
      );
    }
    const generatedAt = this.now().toISOString();
    const depositCursor = await this.repository.findScanCursor("deposit", command.network);
    const cursorAnchor = Math.min(
      headBlock,
      depositCursor?.lastFinalizedBlock ?? depositCursor?.lastScannedBlock ?? headBlock
    );
    const fromBlock = Math.max(
      0,
      cursorAnchor - lookbackBlocks
    );

    const result: {
      generatedAt: string;
      network: EvmNetwork;
      observationType: ObservationType | "both";
      lookbackBlocks: number;
      depositFromBlock?: number;
      headBlock: number;
      depositResult?: EvmDepositScanResult;
      withdrawalResult?: EvmWithdrawalScanResult;
    } = {
      generatedAt,
      network: command.network,
      observationType,
      lookbackBlocks,
      depositFromBlock: fromBlock,
      headBlock
    };

    if (observationType === "deposit" || observationType === "both") {
      result.depositResult = await this.scanEvmDeposits({
        network: command.network,
        fromBlock,
        toBlock: headBlock,
        rpcUrl: command.rpcUrl
      });
    }

    if (observationType === "withdrawal" || observationType === "both") {
      result.withdrawalResult = await this.scanEvmWithdrawals({
        network: command.network,
        rpcUrl: command.rpcUrl
      });
    }

    return result;
  }

  async getDepositObservation(observationId: string): Promise<IndexedDepositObservation | null> {
    return this.repository.findDepositObservationById(observationId);
  }

  async listDepositObservations(
    query: ListDepositObservationsQuery
  ): Promise<PagedResult<IndexedDepositObservation>> {
    return this.repository.listDepositObservations({
      ...query,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0
    });
  }

  async replayDepositObservation(
    command: ReplayDepositObservationCommand
  ): Promise<IndexedDepositObservation> {
    const existing = await this.repository.findDepositObservationById(command.observationId);
    if (!existing) {
      throw new BlockchainIndexerError(
        "OBSERVATION_NOT_FOUND",
        `Deposit observation ${command.observationId} not found`
      );
    }

    if (existing.status === "credited") {
      throw new BlockchainIndexerError(
        "OBSERVATION_ALREADY_FINALIZED",
        `Deposit observation ${command.observationId} is already credited`
      );
    }

    const confirmations = command.confirmations ?? existing.confirmations;
    if (confirmations < 0) {
      throw new BlockchainIndexerError(
        "INVALID_CONFIRMATION_COUNT",
        "Confirmations must be greater than or equal to zero"
      );
    }

    const blockHash = command.blockHash
      ? normalizeHex(command.blockHash)
      : existing.blockHash;
    const blockNumber = command.blockNumber ?? existing.blockNumber;
    const now = this.now().toISOString();
    const replayed = await this.repository.withTransaction(async (repository) => {
      const latest = await repository.findDepositObservationById(command.observationId);
      if (!latest) {
        throw new BlockchainIndexerError(
          "OBSERVATION_NOT_FOUND",
          `Deposit observation ${command.observationId} not found`
        );
      }

      const reorgFields = this.buildReorgFields({
        existingBlockNumber: latest.blockNumber,
        nextBlockNumber: blockNumber,
        existingBlockHash: latest.blockHash,
        nextBlockHash: blockHash,
        now
      });
      const nextObservation: IndexedDepositObservation = {
        ...latest,
        confirmations,
        blockNumber,
        blockHash,
        status: confirmations >= this.confirmationThreshold ? "confirming" : "detected",
        reorgDetectedAt: reorgFields.reorgDetectedAt ?? latest.reorgDetectedAt,
        reorgedFromBlockNumber:
          reorgFields.reorgedFromBlockNumber ?? latest.reorgedFromBlockNumber,
        lastManualAction: "replayed",
        lastManualActionAt: now,
        lastManualActionBy: command.operatedBy,
        lastManualActionNote: command.note,
        updatedAt: now
      };

      await repository.upsertDepositObservation(nextObservation);
      await this.saveCursor(repository, {
        observationType: "deposit",
        network: nextObservation.network,
        blockNumber,
        finalized: false,
        now,
        reorgDetectedAt: nextObservation.reorgDetectedAt,
        reorgDetectedBlock: blockNumber
      });

      return nextObservation;
    });

    if (replayed.confirmations < this.confirmationThreshold) {
      return replayed;
    }

    const deposit = await this.walletClient.confirmDeposit({
      network: replayed.network,
      txHash: replayed.txHash,
      address: replayed.address,
      amount: replayed.amount,
      confirmations: replayed.confirmations,
      blockNumber: replayed.blockNumber,
      blockHash: replayed.blockHash
    });

    return this.repository.withTransaction(async (repository) => {
      const latest = await repository.findDepositObservationById(replayed.observationId);
      if (!latest) {
        throw new BlockchainIndexerError(
          "OBSERVATION_NOT_FOUND",
          `Deposit observation ${command.observationId} not found`
        );
      }

      const updatedAt = this.now().toISOString();
      const creditedObservation: IndexedDepositObservation = {
        ...latest,
        status: "credited",
        walletDepositId: deposit.depositId,
        lastManualAction: "replayed",
        lastManualActionAt: updatedAt,
        lastManualActionBy: command.operatedBy,
        lastManualActionNote: command.note,
        updatedAt
      };

      await repository.upsertDepositObservation(creditedObservation);
      await this.saveCursor(repository, {
        observationType: "deposit",
        network: creditedObservation.network,
        blockNumber: creditedObservation.blockNumber,
        finalized: true,
        now: updatedAt,
        reorgDetectedAt: creditedObservation.reorgDetectedAt,
        reorgDetectedBlock: creditedObservation.blockNumber
      });

      return creditedObservation;
    });
  }

  async closeDepositObservation(
    command: CloseDepositObservationCommand
  ): Promise<IndexedDepositObservation> {
    const existing = await this.repository.findDepositObservationById(command.observationId);
    if (!existing) {
      throw new BlockchainIndexerError(
        "OBSERVATION_NOT_FOUND",
        `Deposit observation ${command.observationId} not found`
      );
    }

    if (existing.status === "credited") {
      throw new BlockchainIndexerError(
        "OBSERVATION_ALREADY_FINALIZED",
        `Deposit observation ${command.observationId} is already credited`
      );
    }

    const updatedAt = this.now().toISOString();
    const closedObservation: IndexedDepositObservation = {
      ...existing,
      status: "closed",
      lastManualAction: "closed",
      lastManualActionAt: updatedAt,
      lastManualActionBy: command.operatedBy,
      lastManualActionNote: command.note,
      updatedAt
    };

    await this.repository.upsertDepositObservation(closedObservation);
    return closedObservation;
  }

  async getWithdrawalObservation(
    observationId: string
  ): Promise<IndexedWithdrawalObservation | null> {
    return this.repository.findWithdrawalObservationById(observationId);
  }

  async getScanCursor(
    observationType: ObservationType,
    network: Network
  ): Promise<ScanCursor | null> {
    return this.repository.findScanCursor(observationType, network);
  }

  /**
   * A reorg flag on a scan cursor is sticky (it drives the reorg alert). Once
   * an operator has checked that the affected observations were re-confirmed
   * on the new canonical chain, this clears the flags for one network.
   * Observation-level reorg metadata is kept as history.
   */
  async acknowledgeReorg(network: Network): Promise<{
    network: Network;
    acknowledgedAt: string;
    clearedCursors: Array<{
      observationType: ObservationType;
      reorgDetectedAt?: string;
      reorgDetectedBlock?: number;
    }>;
  }> {
    const acknowledgedAt = this.now().toISOString();
    const clearedCursors = await this.repository.withTransaction(async (repository) => {
      const cleared: Array<{
        observationType: ObservationType;
        reorgDetectedAt?: string;
        reorgDetectedBlock?: number;
      }> = [];
      for (const observationType of ["deposit", "withdrawal"] as ObservationType[]) {
        const cursor = await repository.findScanCursor(observationType, network);
        if (!cursor?.reorgDetectedAt) {
          continue;
        }
        cleared.push({
          observationType,
          reorgDetectedAt: cursor.reorgDetectedAt,
          reorgDetectedBlock: cursor.reorgDetectedBlock
        });
        await repository.saveScanCursor({
          ...cursor,
          reorgDetectedAt: undefined,
          reorgDetectedBlock: undefined,
          updatedAt: acknowledgedAt
        });
      }
      return cleared;
    });

    return { network, acknowledgedAt, clearedCursors };
  }

  private resolveEvmClient(network: EvmNetwork, rpcUrlOverride?: string): EvmClient {
    const rpcUrl = rpcUrlOverride ?? this.evmRpcUrls[network];
    if (!rpcUrl) {
      throw new BlockchainIndexerError(
        "EVM_RPC_NOT_CONFIGURED",
        `No EVM RPC configured for ${network}`
      );
    }

    return this.evmClientFactory({
      network,
      rpcUrl
    });
  }

  private async loadDepositWatchAddresses(
    network: EvmNetwork,
    explicitWatchAddresses?: DepositWatchAddress[]
  ): Promise<DepositWatchAddress[]> {
    if (explicitWatchAddresses && explicitWatchAddresses.length > 0) {
      return explicitWatchAddresses.map((item) => ({
        address: normalizeHex(item.address),
        assetCode: item.assetCode
      }));
    }

    return this.loadAllWalletPages((query) =>
      this.walletClient.listDepositAddresses({
        network,
        ...query
      })
    );
  }

  private async loadBroadcastedWithdrawals(
    network: EvmNetwork,
    explicitTrackedWithdrawals?: WithdrawalWatchTransaction[]
  ): Promise<WithdrawalWatchTransaction[]> {
    if (explicitTrackedWithdrawals && explicitTrackedWithdrawals.length > 0) {
      return explicitTrackedWithdrawals.map((item) => ({
        txHash: normalizeHex(item.txHash),
        assetCode: item.assetCode
      }));
    }

    return this.loadAllWalletPages((query) =>
      this.walletClient.listBroadcastedWithdrawals({
        network,
        ...query
      })
    );
  }

  private async loadAllWalletPages<T>(
    loader: (query: { limit: number; offset: number }) => Promise<{ items: T[]; total: number }>
  ): Promise<T[]> {
    const items: T[] = [];
    let offset = 0;

    while (true) {
      const page = await loader({
        limit: this.walletPageSize,
        offset
      });
      items.push(...page.items);
      offset += page.items.length;

      if (page.items.length === 0 || items.length >= page.total) {
        return items;
      }
    }
  }

  private async collectEvmDepositMatches(input: {
    client: EvmClient;
    network: EvmNetwork;
    fromBlock: number;
    toBlock: number;
    watchAddresses: DepositWatchAddress[];
    nativeAssetCode?: AssetCode;
    tokenContracts: EvmTokenContractConfig[];
  }): Promise<CanonicalDepositMatch[]> {
    if (input.watchAddresses.length === 0) {
      return [];
    }

    const watchAssetCodesByAddress = new Map<string, Set<AssetCode>>();
    for (const watchAddress of input.watchAddresses) {
      const normalizedAddress = normalizeHex(watchAddress.address);
      watchAssetCodesByAddress.set(
        normalizedAddress,
        new Set([
          ...(watchAssetCodesByAddress.get(normalizedAddress) ?? []),
          watchAddress.assetCode
        ])
      );
    }

    const matches: CanonicalDepositMatch[] = [];

    if (input.nativeAssetCode) {
      matches.push(
        ...(await this.collectNativeDepositMatches({
          client: input.client,
          network: input.network,
          fromBlock: input.fromBlock,
          toBlock: input.toBlock,
          watchAssetCodesByAddress,
          nativeAssetCode: input.nativeAssetCode
        }))
      );
    }

    if (input.tokenContracts.length > 0) {
      matches.push(
        ...(await this.collectTokenDepositMatches({
          client: input.client,
          network: input.network,
          fromBlock: input.fromBlock,
          toBlock: input.toBlock,
          watchAssetCodesByAddress,
          tokenContracts: input.tokenContracts
        }))
      );
    }

    return matches.sort((left, right) => {
      if (left.blockNumber !== right.blockNumber) {
        return left.blockNumber - right.blockNumber;
      }

      return left.txHash.localeCompare(right.txHash) || left.address.localeCompare(right.address);
    });
  }

  private async collectNativeDepositMatches(input: {
    client: EvmClient;
    network: EvmNetwork;
    fromBlock: number;
    toBlock: number;
    watchAssetCodesByAddress: Map<string, Set<AssetCode>>;
    nativeAssetCode: AssetCode;
  }): Promise<CanonicalDepositMatch[]> {
    const matches: CanonicalDepositMatch[] = [];

    for (let blockNumber = input.fromBlock; blockNumber <= input.toBlock; blockNumber += 1) {
      const block = await input.client.getBlockByNumber(blockNumber, true);

      if (!block) {
        throw new BlockchainIndexerError(
          "EVM_RPC_FAILED",
          `Block ${blockNumber} is not available on the RPC endpoint`
        );
      }

      for (const transaction of block.transactions) {
        const toAddress = transaction.to ? normalizeHex(transaction.to) : undefined;
        if (!toAddress) {
          continue;
        }

        const acceptedAssets = input.watchAssetCodesByAddress.get(toAddress);
        if (!acceptedAssets?.has(input.nativeAssetCode)) {
          continue;
        }

        const amount = formatAtomicAmount(BigInt(transaction.value), 18);
        if (amount === "0") {
          continue;
        }

        matches.push({
          network: input.network,
          assetCode: input.nativeAssetCode,
          address: toAddress,
          txHash: normalizeHex(transaction.hash),
          amount,
          blockNumber: block.number,
          blockHash: normalizeHex(block.hash)
        });
      }
    }

    return matches;
  }

  private async collectTokenDepositMatches(input: {
    client: EvmClient;
    network: EvmNetwork;
    fromBlock: number;
    toBlock: number;
    watchAssetCodesByAddress: Map<string, Set<AssetCode>>;
    tokenContracts: EvmTokenContractConfig[];
  }): Promise<CanonicalDepositMatch[]> {
    const matches: CanonicalDepositMatch[] = [];
    const normalizedWatchAddresses = [...input.watchAssetCodesByAddress.keys()];

    for (const tokenContractChunk of chunk(input.tokenContracts, 20)) {
      for (const watchAddressChunk of chunk(normalizedWatchAddresses, 50)) {
        const logs = await input.client.getLogs({
          fromBlock: input.fromBlock,
          toBlock: input.toBlock,
          addresses: tokenContractChunk.map((item) => normalizeHex(item.contractAddress)),
          topics: [
            ERC20_TRANSFER_TOPIC,
            null,
            watchAddressChunk.map((address) => encodeAddressTopic(address))
          ]
        });

        const tokenConfigByAddress = new Map(
          tokenContractChunk.map((item) => [normalizeHex(item.contractAddress), item])
        );

        for (const entry of logs) {
          const tokenConfig = tokenConfigByAddress.get(normalizeHex(entry.address));
          if (!tokenConfig) {
            continue;
          }

          const toAddress = decodeAddressTopic(entry.topics[2]);
          if (!toAddress) {
            continue;
          }

          const acceptedAssets = input.watchAssetCodesByAddress.get(toAddress);
          if (!acceptedAssets?.has(tokenConfig.assetCode)) {
            continue;
          }

          const amount = formatAtomicAmount(BigInt(entry.data), tokenConfig.decimals);
          if (amount === "0") {
            continue;
          }

          matches.push({
            network: input.network,
            assetCode: tokenConfig.assetCode,
            address: toAddress,
            txHash: normalizeHex(entry.transactionHash),
            amount,
            blockNumber: entry.blockNumber,
            blockHash: normalizeHex(entry.blockHash)
          });
        }
      }
    }

    return matches;
  }

  private buildReorgFields(input: {
    existingBlockNumber?: number;
    nextBlockNumber?: number;
    existingBlockHash?: string;
    nextBlockHash?: string;
    now: string;
  }): Pick<IndexedDepositObservation, "reorgDetectedAt" | "reorgedFromBlockNumber"> {
    const blockNumberChanged =
      input.existingBlockNumber !== undefined &&
      input.nextBlockNumber !== undefined &&
      input.existingBlockNumber !== input.nextBlockNumber;
    const blockHashChanged =
      input.existingBlockHash !== undefined &&
      input.nextBlockHash !== undefined &&
      normalizeHex(input.existingBlockHash) !== normalizeHex(input.nextBlockHash);

    if (blockNumberChanged || blockHashChanged) {
      return {
        reorgDetectedAt: input.now,
        reorgedFromBlockNumber: input.existingBlockNumber
      };
    }

    return {
      reorgDetectedAt: undefined,
      reorgedFromBlockNumber: undefined
    };
  }

  private hasReorged(
    existing: IndexedDepositObservation | IndexedWithdrawalObservation | undefined,
    nextBlockNumber: number,
    nextBlockHash: string
  ): boolean {
    if (!existing) {
      return false;
    }

    if (existing.blockNumber !== undefined && existing.blockNumber !== nextBlockNumber) {
      return true;
    }

    return (
      existing.blockHash !== undefined &&
      normalizeHex(existing.blockHash) !== normalizeHex(nextBlockHash)
    );
  }

  private resolveDepositFromBlock(
    cursor: ScanCursor | null,
    requestedFromBlock: number | undefined,
    toBlock: number
  ): number {
    if (requestedFromBlock !== undefined) {
      return requestedFromBlock;
    }

    if (cursor) {
      return Math.min((cursor.lastFinalizedBlock ?? -1) + 1, toBlock);
    }

    return Math.max(0, toBlock - this.maxScanBlockRange + 1);
  }

  private assertValidScanRange(fromBlock: number, toBlock: number): void {
    if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock) || fromBlock < 0 || toBlock < 0) {
      throw new BlockchainIndexerError(
        "INVALID_SCAN_RANGE",
        "Scan range must use non-negative integer block numbers"
      );
    }

    if (fromBlock > toBlock) {
      throw new BlockchainIndexerError(
        "INVALID_SCAN_RANGE",
        "fromBlock must be less than or equal to toBlock"
      );
    }

    if (toBlock - fromBlock + 1 > this.maxScanBlockRange) {
      throw new BlockchainIndexerError(
        "INVALID_SCAN_RANGE",
        `Scan range exceeds max block range ${this.maxScanBlockRange}`
      );
    }
  }

  private async saveCursor(
    repository: BlockchainIndexerRepository,
    input: {
      observationType: ObservationType;
      network: Network;
      blockNumber?: number;
      finalized: boolean;
      now: string;
      reorgDetectedAt?: string;
      reorgDetectedBlock?: number;
    }
  ): Promise<void> {
    if (input.blockNumber === undefined) {
      return;
    }

    const existing = await repository.findScanCursor(input.observationType, input.network);
    const nextCursor: ScanCursor = {
      cursorId: existing?.cursorId ?? this.createId(),
      observationType: input.observationType,
      network: input.network,
      lastScannedBlock: Math.max(existing?.lastScannedBlock ?? input.blockNumber, input.blockNumber),
      lastFinalizedBlock:
        !input.finalized
          ? existing?.lastFinalizedBlock
          : Math.max(existing?.lastFinalizedBlock ?? input.blockNumber, input.blockNumber),
      reorgDetectedAt: input.reorgDetectedAt ?? existing?.reorgDetectedAt,
      reorgDetectedBlock: input.reorgDetectedAt
        ? input.reorgDetectedBlock
        : existing?.reorgDetectedBlock,
      updatedAt: input.now
    };

    await repository.saveScanCursor(nextCursor);
  }

  private async saveScanCursorSnapshot(input: {
    observationType: ObservationType;
    network: Network;
    lastScannedBlock: number;
    lastFinalizedBlock?: number;
    now: string;
    reorgDetectedBlock?: number;
  }): Promise<ScanCursor> {
    const existing = await this.repository.findScanCursor(input.observationType, input.network);
    const nextCursor: ScanCursor = {
      cursorId: existing?.cursorId ?? this.createId(),
      observationType: input.observationType,
      network: input.network,
      lastScannedBlock: Math.max(
        existing?.lastScannedBlock ?? input.lastScannedBlock,
        input.lastScannedBlock
      ),
      lastFinalizedBlock:
        input.lastFinalizedBlock === undefined
          ? existing?.lastFinalizedBlock
          : Math.max(existing?.lastFinalizedBlock ?? input.lastFinalizedBlock, input.lastFinalizedBlock),
      reorgDetectedAt: input.reorgDetectedBlock !== undefined ? input.now : existing?.reorgDetectedAt,
      reorgDetectedBlock:
        input.reorgDetectedBlock !== undefined ? input.reorgDetectedBlock : existing?.reorgDetectedBlock,
      updatedAt: input.now
    };

    await this.repository.saveScanCursor(nextCursor);
    return nextCursor;
  }
}

function normalizeOptionalBlockNumber(
  value: number | undefined,
  fieldName: "fromBlock" | "toBlock"
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return normalizeBlockNumber(value, fieldName);
}

function normalizeBlockNumber(value: number, fieldName: "fromBlock" | "toBlock"): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new BlockchainIndexerError(
      "INVALID_SCAN_RANGE",
      `${fieldName} must be a non-negative integer`
    );
  }

  return value;
}

function assertEvmNetwork(network: Network): EvmNetwork {
  if (network === "ethereum" || network === "bsc" || network === "base") {
    return network;
  }

  throw new BlockchainIndexerError(
    "UNSUPPORTED_NETWORK",
    `Network ${network} is not supported by the EVM scanner`
  );
}

function depositObservationKey(network: Network, txHash: string, address: string): string {
  return `${network}:${normalizeHex(txHash)}:${normalizeHex(address)}`;
}

function withdrawalObservationKey(network: Network, txHash: string): string {
  return `${network}:${normalizeHex(txHash)}`;
}

function normalizeHex(value: string): string {
  return value.toLowerCase();
}

function calculateConfirmations(headBlock: number, blockNumber: number): number {
  return Math.max(0, headBlock - blockNumber + 1);
}

function resolveFinalizedBlock(
  headBlock: number,
  confirmationThreshold: number,
  scannedToBlock: number
): number | undefined {
  const finalizedBlock = headBlock - confirmationThreshold + 1;
  if (finalizedBlock < 0) {
    return undefined;
  }

  return Math.min(finalizedBlock, scannedToBlock);
}

function encodeAddressTopic(address: string): string {
  const normalized = normalizeHex(address).replace(/^0x/, "");
  return `0x${normalized.padStart(64, "0")}`;
}

function decodeAddressTopic(topic: string | undefined): string | undefined {
  if (!topic) {
    return undefined;
  }

  const normalized = normalizeHex(topic).replace(/^0x/, "");
  if (normalized.length < 40) {
    return undefined;
  }

  return `0x${normalized.slice(-40)}`;
}

function formatAtomicAmount(value: bigint, decimals: number): string {
  if (decimals === 0) {
    return value.toString();
  }

  const divisor = 10n ** BigInt(decimals);
  const integerPart = value / divisor;
  const fractionalPart = (value % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");

  return fractionalPart ? `${integerPart.toString()}.${fractionalPart}` : integerPart.toString();
}

function minDefined(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  return values.reduce((current, next) => Math.min(current, next));
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}
