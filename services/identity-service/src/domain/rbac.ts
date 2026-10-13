import type {
  IdentityOpsPermission,
  IdentityOpsRole
} from "./types.js";

const ROLE_PERMISSIONS: Record<IdentityOpsRole, IdentityOpsPermission[]> = {
  ops_admin: [
    "ops.dashboard.read",
    "ops.withdrawals.read",
    "ops.withdrawals.review",
    "ops.withdrawals.batch_review",
    "ops.users.read",
    "ops.users.manage",
    "ops.users.freeze",
    "ops.assets.read",
    "ops.ledger.manage",
    "ops.ledger.read",
    "ops.ledger.execute",
    "ops.deposits.read",
    "ops.notifications.read",
    "ops.notifications.manage",
    "ops.indexer.manage",
    "ops.indexer.read",
    "ops.indexer.execute",
    "ops.indexer.pending.manage",
    "ops.custody.read",
    "ops.providers.manage",
    "ops.address_book.read",
    "ops.address_book.manage",
    "ops.audit.read",
    "ops.alerts.read",
    "ops.markets.read",
    "ops.markets.manage",
    "ops.risk.read",
    "ops.risk.manage"
  ],
  ops_reviewer: [
    "ops.dashboard.read",
    "ops.withdrawals.read",
    "ops.withdrawals.review",
    "ops.withdrawals.batch_review",
    "ops.deposits.read",
    "ops.notifications.read",
    "ops.address_book.read",
    "ops.audit.read",
    "ops.alerts.read",
    "ops.risk.read"
  ],
  ops_finance_operator: [
    "ops.dashboard.read",
    "ops.withdrawals.read",
    "ops.assets.read",
    "ops.ledger.manage",
    "ops.ledger.read",
    "ops.ledger.execute",
    "ops.deposits.read",
    "ops.notifications.read",
    "ops.notifications.manage",
    "ops.address_book.read",
    "ops.audit.read",
    "ops.alerts.read"
  ],
  ops_risk_operator: [
    "ops.dashboard.read",
    "ops.withdrawals.read",
    "ops.users.read",
    "ops.users.freeze",
    "ops.deposits.read",
    "ops.address_book.read",
    "ops.address_book.manage",
    "ops.audit.read",
    "ops.alerts.read",
    "ops.markets.read",
    "ops.markets.manage",
    "ops.risk.read",
    "ops.risk.manage"
  ],
  ops_platform_operator: [
    "ops.dashboard.read",
    "ops.notifications.read",
    "ops.notifications.manage",
    "ops.indexer.manage",
    "ops.indexer.read",
    "ops.indexer.execute",
    "ops.indexer.pending.manage",
    "ops.custody.read",
    "ops.providers.manage",
    "ops.audit.read",
    "ops.alerts.read",
    "ops.markets.read"
  ],
  ops_observer: [
    "ops.dashboard.read",
    "ops.withdrawals.read",
    "ops.users.read",
    "ops.assets.read",
    "ops.ledger.read",
    "ops.deposits.read",
    "ops.notifications.read",
    "ops.indexer.read",
    "ops.custody.read",
    "ops.address_book.read",
    "ops.audit.read",
    "ops.alerts.read",
    "ops.markets.read",
    "ops.risk.read"
  ]
};

export function normalizeOpsRoles(roles: IdentityOpsRole[] | undefined): IdentityOpsRole[] {
  const nextRoles: IdentityOpsRole[] = roles?.length ? roles : ["ops_observer"];
  return [...new Set(nextRoles)];
}

export function resolveOpsPermissions(
  roles: IdentityOpsRole[]
): IdentityOpsPermission[] {
  const permissions = new Set<IdentityOpsPermission>();

  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) {
      permissions.add(permission);
    }
  }

  return [...permissions];
}
