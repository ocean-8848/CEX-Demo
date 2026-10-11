import type { Network } from "@web3-cex/domain";

import { CustodyError } from "../domain/errors.js";
import type { CustodyProvider, CustodyProviderResolver } from "../domain/provider.js";
import type { CreateTransferCommand, CustodyTransferRecord } from "../domain/types.js";
import type { CustodyProviderRuntimeRegistry } from "../application/custody-provider-runtime-registry.js";

export interface CustodyProviderRoutingConfig {
  defaultOrder: string[];
  orderByNetwork: Partial<Record<Network, string[]>>;
}

export class ConfiguredCustodyProviderResolver implements CustodyProviderResolver {
  private readonly providersByName: Map<string, CustodyProvider>;

  constructor(
    providers: CustodyProvider[],
    private readonly config: CustodyProviderRoutingConfig,
    private readonly runtimeRegistry?: CustodyProviderRuntimeRegistry
  ) {
    this.providersByName = new Map(
      providers.map((provider) => [provider.providerName, provider] satisfies [string, CustodyProvider])
    );
  }

  selectProviderForCreate(command: CreateTransferCommand): CustodyProvider {
    const providerNames = this.getOrderedProviderNames(command.network);
    return this.getFirstAvailableProvider(providerNames, command.network);
  }

  selectProviderForRetry(transfer: CustodyTransferRecord): CustodyProvider {
    const providerNames = this.getOrderedProviderNames(transfer.network);
    const currentIndex = providerNames.indexOf(transfer.providerName);
    const orderedCandidates =
      currentIndex >= 0
        ? [
            ...providerNames.slice(currentIndex + 1),
            transfer.providerName,
            ...providerNames.slice(0, currentIndex)
          ]
        : providerNames;

    return this.getFirstAvailableProvider(orderedCandidates, transfer.network);
  }

  getProviderByName(providerName: string): CustodyProvider {
    const provider = this.providersByName.get(providerName);
    if (!provider) {
      throw new CustodyError(
        "PROVIDER_NOT_CONFIGURED",
        `Custody provider ${providerName} is not configured`
      );
    }

    return provider;
  }

  listProviderRoutes() {
    const routes = new Map<string, { providerName: string; network: Network; priority: number }>();

    for (const network of supportedNetworks) {
      const providerNames = this.getOrderedProviderNames(network);
      providerNames.forEach((providerName, index) => {
        const key = `${providerName}:${network}`;
        if (!routes.has(key)) {
          routes.set(key, {
            providerName,
            network,
            priority: index
          });
        }
      });
    }

    return [...routes.values()];
  }

  private getOrderedProviderNames(network: Network): string[] {
    const configured = this.config.orderByNetwork[network] ?? this.config.defaultOrder;

    if (configured.length > 0) {
      return configured;
    }

    return [...this.providersByName.keys()];
  }

  private getFirstAvailableProvider(providerNames: string[], network: Network): CustodyProvider {
    const degradedProviders: CustodyProvider[] = [];
    const blockedReasons: string[] = [];

    for (const providerName of providerNames) {
      const provider = this.providersByName.get(providerName);
      if (!provider) {
        continue;
      }

      if (!provider.supportsNetwork(network)) {
        blockedReasons.push(`${providerName}:${network}=unsupported`);
        continue;
      }

      if (!this.runtimeRegistry) {
        return provider;
      }

      const availability = this.runtimeRegistry.evaluateRouteAvailability(
        provider.providerName,
        network
      );

      if (!availability.available) {
        blockedReasons.push(
          `${provider.providerName}:${network}=${availability.reason ?? "blocked"}`
        );
        continue;
      }

      if (availability.snapshot.healthStatus === "degraded") {
        degradedProviders.push(provider);
        continue;
      }

      this.runtimeRegistry.markRouteSelected(provider.providerName, network);
      return provider;
    }

    if (degradedProviders[0]) {
      this.runtimeRegistry?.markRouteSelected(degradedProviders[0].providerName, network);
      return degradedProviders[0];
    }

    throw new CustodyError(
      "PROVIDER_ROUTE_UNAVAILABLE",
      blockedReasons[0]
        ? `No custody provider is currently available for ${network}: ${blockedReasons.join(", ")}`
        : "No custody provider is configured for this transfer route"
    );
  }
}

export function loadCustodyProviderRoutingConfig(
  env: NodeJS.ProcessEnv = process.env
): CustodyProviderRoutingConfig {
  const defaultOrder = parseProviderList(
    // The demo default routes to mock-custody first and fails over to
    // mock-custody-backup when its circuit opens (see the ops fault lab).
    env.CUSTODY_PROVIDER_ORDER ?? env.CUSTODY_PROVIDER ?? "mock-custody,mock-custody-backup"
  );
  const orderByNetwork = parseProviderOrderByNetwork(env.CUSTODY_PROVIDER_ORDER_BY_NETWORK);

  return {
    defaultOrder,
    orderByNetwork
  };
}

function parseProviderOrderByNetwork(
  rawValue: string | undefined
): Partial<Record<Network, string[]>> {
  if (!rawValue) {
    return {};
  }

  const result: Partial<Record<Network, string[]>> = {};

  for (const entry of rawValue.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [network, providerList] = entry.split("=").map((item) => item.trim());
    if (!isSupportedNetwork(network) || !providerList) {
      continue;
    }

    result[network] = parseProviderList(providerList, "|");
  }

  return result;
}

function parseProviderList(rawValue: string, separator = ","): string[] {
  return rawValue
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isSupportedNetwork(value: string | undefined): value is Network {
  return value === "ethereum" || value === "bsc" || value === "base";
}

const supportedNetworks: Network[] = ["ethereum", "bsc", "base"];
