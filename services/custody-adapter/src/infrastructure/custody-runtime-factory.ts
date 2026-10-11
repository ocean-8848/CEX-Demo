import type { CustodyProvider } from "../domain/provider.js";
import { CustodyFaultInjector } from "../application/custody-fault-lab.js";
import { CustodyProviderRuntimeRegistry } from "../application/custody-provider-runtime-registry.js";
import {
  ConfiguredCustodyProviderResolver,
  loadCustodyProviderRoutingConfig
} from "./custody-provider-resolver.js";
import { EvmCustodyProvider } from "./evm-custody-provider.js";
import { loadEvmHotWalletConfig } from "./evm-provider-config.js";
import { MockCustodyProvider } from "./mock-custody-provider.js";

interface ProviderStackOptions {
  now?: () => Date;
}

export function createCustodyProviderStack(
  env: NodeJS.ProcessEnv = process.env,
  options: ProviderStackOptions = {}
): {
  providers: CustodyProvider[];
  providerResolver: ConfiguredCustodyProviderResolver;
  runtimeRegistry: CustodyProviderRuntimeRegistry;
  faultInjector: CustodyFaultInjector;
} {
  const mockProviderNames = ["mock-custody", "mock-custody-backup"];
  const faultInjector = new CustodyFaultInjector({
    now: options.now,
    enabled: env.CUSTODY_FAULT_LAB_ENABLED !== "false",
    injectableProviders: mockProviderNames,
    defaultDurationMs: parseNumber(env.CUSTODY_FAULT_INJECTION_DEFAULT_MS, 180_000),
    maxDurationMs: parseNumber(env.CUSTODY_FAULT_INJECTION_MAX_MS, 600_000)
  });
  const providers: CustodyProvider[] = [
    ...mockProviderNames.map((name) => new MockCustodyProvider(name, faultInjector)),
    new EvmCustodyProvider(loadEvmHotWalletConfig(env))
  ];
  const routingConfig = loadCustodyProviderRoutingConfig(env);
  const bootstrapResolver = new ConfiguredCustodyProviderResolver(providers, routingConfig);
  const runtimeRegistry = new CustodyProviderRuntimeRegistry(bootstrapResolver.listProviderRoutes(), {
    now: options.now,
    failureThreshold: parseNumber(env.CUSTODY_PROVIDER_FAILURE_THRESHOLD, 2),
    circuitOpenMs: parseNumber(env.CUSTODY_PROVIDER_CIRCUIT_OPEN_MS, 120_000)
  });
  const providerResolver = new ConfiguredCustodyProviderResolver(
    providers,
    routingConfig,
    runtimeRegistry
  );

  return {
    providers,
    providerResolver,
    runtimeRegistry,
    faultInjector
  };
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
