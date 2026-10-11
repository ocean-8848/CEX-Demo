import type {
  CustodyProviderCreateTransferCommand,
  CustodyProviderCreateTransferResult,
  CustodyProviderHealthcheckCommand,
  CustodyProviderHealthcheckResult,
  CreateTransferCommand,
  CustodyTransferRecord,
  CustodyProviderTransferStatusCommand,
  CustodyProviderTransferStatusResult
} from "./types.js";
import type { Network } from "@web3-cex/domain";

export interface CustodyProviderRoute {
  providerName: string;
  network: Network;
  priority: number;
}

export interface CustodyProvider {
  readonly providerName: string;
  supportsNetwork(network: Network): boolean;
  createTransfer(
    command: CustodyProviderCreateTransferCommand
  ): Promise<CustodyProviderCreateTransferResult>;
  getTransferStatus(
    command: CustodyProviderTransferStatusCommand
  ): Promise<CustodyProviderTransferStatusResult>;
  checkHealth(
    command: CustodyProviderHealthcheckCommand
  ): Promise<CustodyProviderHealthcheckResult>;
}

export interface CustodyProviderResolver {
  selectProviderForCreate(command: CreateTransferCommand): CustodyProvider;
  selectProviderForRetry(transfer: CustodyTransferRecord): CustodyProvider;
  getProviderByName(providerName: string): CustodyProvider;
  listProviderRoutes(): CustodyProviderRoute[];
}
