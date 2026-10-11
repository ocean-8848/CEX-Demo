import { randomBytes } from "node:crypto";

import type { Network } from "@web3-cex/domain";

import type { CustodyFaultInjector } from "../application/custody-fault-lab.js";
import type { CustodyProvider } from "../domain/provider.js";
import type {
  CustodyProviderCreateTransferCommand,
  CustodyProviderCreateTransferResult,
  CustodyProviderHealthcheckCommand,
  CustodyProviderHealthcheckResult,
  CustodyProviderTransferStatusCommand,
  CustodyProviderTransferStatusResult
} from "../domain/types.js";

/**
 * Demo custody vendor: broadcasts succeed instantly with a random tx hash.
 * The local stack runs two instances ("mock-custody" and "mock-custody-backup")
 * so the fault lab can show circuit breaking and route failover.
 */
export class MockCustodyProvider implements CustodyProvider {
  constructor(
    readonly providerName = "mock-custody",
    private readonly faultInjector?: CustodyFaultInjector
  ) {}

  supportsNetwork(_network: Network): boolean {
    return true;
  }

  async createTransfer(
    command: CustodyProviderCreateTransferCommand
  ): Promise<CustodyProviderCreateTransferResult> {
    this.faultInjector?.assertNotInjected(this.providerName, "broadcast");
    const txHash = this.generateTxHash(command.network);

    return {
      providerName: this.providerName,
      providerTransferId: txHash,
      status: "broadcasted",
      txHash,
      requestPayload: {
        referenceId: command.referenceId,
        assetCode: command.assetCode,
        network: command.network,
        toAddress: command.toAddress,
        amount: command.amount,
        fee: command.fee
      },
      responsePayload: {
        txHash
      }
    };
  }

  async getTransferStatus(
    command: CustodyProviderTransferStatusCommand
  ): Promise<CustodyProviderTransferStatusResult> {
    return {
      providerName: this.providerName,
      providerTransferId: command.providerTransferId ?? command.txHash,
      status: "confirmed",
      txHash: command.txHash,
      requestPayload: {
        txHash: command.txHash
      },
      responsePayload: {
        status: "confirmed"
      }
    };
  }

  async checkHealth(
    command: CustodyProviderHealthcheckCommand
  ): Promise<CustodyProviderHealthcheckResult> {
    const injection = this.faultInjector?.getActiveInjection(this.providerName);
    if (injection) {
      return {
        providerName: this.providerName,
        network: command.network,
        status: "unhealthy",
        latencyMs: 0,
        errorCode: "FAULT_INJECTED",
        errorMessage: `Fault lab: ${this.providerName} is down until ${injection.expiresAt}`,
        metadata: {
          mode: "mock",
          faultInjected: true
        }
      };
    }

    return {
      providerName: this.providerName,
      network: command.network,
      status: "healthy",
      latencyMs: 0,
      metadata: {
        mode: "mock"
      }
    };
  }

  private generateTxHash(network: CustodyProviderCreateTransferCommand["network"]): string {
    if (network === "ethereum" || network === "bsc" || network === "base") {
      return `0x${randomBytes(32).toString("hex")}`;
    }

    return `${network}_${randomBytes(32).toString("hex")}`;
  }
}
