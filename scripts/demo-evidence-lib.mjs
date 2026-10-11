export function renderDemoEvidenceMarkdown(payload, options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const lines = [
    "# Demo Evidence Chain",
    "",
    `生成时间: \`${generatedAt}\``,
    "",
    `主市场: \`${String(payload.market ?? "unknown")}\``,
    ""
  ];

  appendSection(lines, "Flow Result", [
    `status=${String(payload.status ?? "unknown")}`,
    `resetTables=${String(payload.reset?.resetTables ?? 0)}`,
    `warnings=${JSON.stringify(payload.reset?.warnings ?? [])}`
  ]);

  appendSection(lines, "Funding Evidence", [
    `deposit txHash=${String(payload.deposit?.txHash ?? "-")}`,
    `deposit status=${String(payload.deposit?.creditedStatus ?? payload.deposit?.observationStatus ?? "-")}`,
    `deposit amount=${String(payload.deposit?.amount ?? "-")}`,
    `balance before=${String(payload.deposit?.usdtAvailableBefore ?? "-")}`,
    `balance after=${String(payload.deposit?.usdtAvailableAfter ?? "-")}`
  ]);

  appendSection(lines, "Trading Evidence", [
    `orderId=${String(payload.trade?.orderId ?? "-")}`,
    `orderStatus=${String(payload.trade?.orderStatus ?? "-")}`,
    `tradeId=${String(payload.trade?.tradeId ?? "-")}`,
    `price=${String(payload.trade?.price ?? "-")}`,
    `quantity=${String(payload.trade?.quantity ?? "-")}`
  ]);

  appendSection(lines, "Settlement Evidence", [
    `settlementId=${String(payload.settlement?.settlementId ?? "-")}`,
    `settlementStatus=${String(payload.settlement?.status ?? "-")}`,
    `quoteAmount=${String(payload.settlement?.quoteAmount ?? "-")}`,
    `feeAmount=${String(payload.settlement?.feeAmount ?? "-")}`,
    `processedCount=${String(payload.settlement?.process?.processedCount ?? 0)}`
  ]);

  appendSection(lines, "Withdrawal Evidence", [
    `withdrawalId=${String(payload.withdrawal?.withdrawalId ?? "-")}`,
    `reviewStatus=${String(payload.withdrawal?.reviewStatus ?? payload.withdrawal?.reviewQueueStatus ?? "-")}`,
    `broadcastStatus=${String(payload.withdrawal?.approveStatus ?? "-")}`,
    `finalStatus=${String(payload.withdrawal?.finalStatus ?? payload.withdrawal?.observationStatus ?? "-")}`,
    `txHash=${String(payload.withdrawal?.txHash ?? "-")}`
  ]);

  appendSection(lines, "Notification Evidence", [
    `events=${readNotificationSummary(payload.notifications)}`,
    "建议把 withdrawalId / tradeId / txHash 粘到 ops-console 的 unified trace 入口继续联查。"
  ]);

  return `${lines.join("\n")}\n`;
}

export function buildComparableDemoEvidence(payload) {
  return {
    market: String(payload.market ?? "unknown"),
    status: String(payload.status ?? "unknown"),
    reset: {
      status: String(payload.reset?.status ?? "unknown"),
      resetTables: Number(payload.reset?.resetTables ?? 0),
      warnings: Array.isArray(payload.reset?.warnings)
        ? [...payload.reset.warnings].map((item) => String(item)).sort()
        : []
    },
    deposit: {
      amount: String(payload.deposit?.amount ?? "-"),
      observationStatus: String(payload.deposit?.observationStatus ?? "-"),
      creditedStatus: String(payload.deposit?.creditedStatus ?? "-"),
      usdtAvailableBefore: String(payload.deposit?.usdtAvailableBefore ?? "-"),
      usdtAvailableAfter: String(payload.deposit?.usdtAvailableAfter ?? "-")
    },
    trade: {
      orderStatus: String(payload.trade?.orderStatus ?? "-"),
      price: String(payload.trade?.price ?? "-"),
      quantity: String(payload.trade?.quantity ?? "-")
    },
    settlement: {
      status: String(payload.settlement?.status ?? "-"),
      quoteAmount: String(payload.settlement?.quoteAmount ?? "-"),
      feeAmount: String(payload.settlement?.feeAmount ?? "-"),
      process: {
        processedCount: Number(payload.settlement?.process?.processedCount ?? 0),
        appliedCount: Number(payload.settlement?.process?.appliedCount ?? 0),
        duplicateCount: Number(payload.settlement?.process?.duplicateCount ?? 0),
        acknowledgedCount: Number(payload.settlement?.process?.acknowledgedCount ?? 0),
        failedCount: Number(payload.settlement?.process?.failedCount ?? 0),
        marketSummaries: normalizeMarketSummaries(payload.settlement?.process?.marketSummaries)
      }
    },
    withdrawal: {
      reviewQueueStatus: String(payload.withdrawal?.reviewQueueStatus ?? "-"),
      reviewStatus: String(payload.withdrawal?.reviewStatus ?? "-"),
      approveStatus: String(payload.withdrawal?.approveStatus ?? "-"),
      observationStatus: String(payload.withdrawal?.observationStatus ?? "-"),
      finalStatus: String(payload.withdrawal?.finalStatus ?? "-")
    },
    notifications: normalizeNotifications(payload.notifications)
  };
}

export function compareDemoEvidenceSnapshots(leftPayload, rightPayload, options = {}) {
  const leftComparable = buildComparableDemoEvidence(leftPayload);
  const rightComparable = buildComparableDemoEvidence(rightPayload);
  const differences = [];
  collectComparableDiffs(leftComparable, rightComparable, "", differences);

  return {
    leftLabel: options.leftLabel ?? "left",
    rightLabel: options.rightLabel ?? "right",
    leftComparable,
    rightComparable,
    differences,
    driftCount: differences.length,
    ignoredFields: [
      "depositId / withdrawalId / settlementId / orderId / tradeId 等随机主键",
      "txHash / custodyRequestId 等一次性运行标识",
      "cycleStartedAt / cycleCompletedAt / streamEntryId / replayCursor 等运行时漂移字段"
    ]
  };
}

export function renderDemoEvidenceComparisonMarkdown(comparison, options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const lines = [
    "# Demo Evidence Drift Report",
    "",
    `生成时间: \`${generatedAt}\``,
    "",
    `基线: \`${comparison.leftLabel}\``,
    `对比: \`${comparison.rightLabel}\``,
    `归一化 drift 数量: \`${comparison.driftCount}\``,
    "",
    "## Ignored Runtime-only Fields",
    "",
    ...comparison.ignoredFields.map((item) => `- ${item}`),
    ""
  ];

  if (comparison.differences.length === 0) {
    lines.push("## Drift Summary");
    lines.push("");
    lines.push("- 没有发现归一化后的 drift。");
    lines.push("- 当前差异仅可能来自被忽略的随机主键、时间戳或运行时游标。");
    lines.push("");
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Drift Summary");
  lines.push("");
  for (const difference of comparison.differences) {
    lines.push(
      `- ${difference.path}: baseline=${JSON.stringify(difference.left)} | current=${JSON.stringify(
        difference.right
      )}`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function sanitizeSnapshotName(input, fallback = "snapshot") {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

export function formatDemoEvidenceBaselineName(input) {
  return `baseline-${sanitizeSnapshotName(input, "mainflow")}`;
}

function appendSection(lines, title, items) {
  lines.push(`## ${title}`);
  lines.push("");
  for (const item of items) {
    lines.push(`- ${item}`);
  }
  lines.push("");
}

function readNotificationSummary(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "none";
  }

  return items
    .map((item) => `${String(item.eventType ?? "event")}(${String(item.status ?? "unknown")})`)
    .join(", ");
}

function normalizeNotifications(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return [...items]
    .map((item) => ({
      eventType: String(item?.eventType ?? "event"),
      status: String(item?.status ?? "unknown")
    }))
    .sort((left, right) =>
      `${left.eventType}:${left.status}`.localeCompare(`${right.eventType}:${right.status}`)
    );
}

function normalizeMarketSummaries(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return [...items]
    .map((item) => ({
      market: String(item?.market ?? "unknown"),
      fetchedCount: Number(item?.fetchedCount ?? 0),
      appliedCount: Number(item?.appliedCount ?? 0),
      duplicateCount: Number(item?.duplicateCount ?? 0),
      acknowledgedCount: Number(item?.acknowledgedCount ?? 0),
      failedCount: Number(item?.failedCount ?? 0),
      lastExecutionSequence: Number(item?.lastExecutionSequence ?? 0)
    }))
    .sort((left, right) => left.market.localeCompare(right.market));
}

function collectComparableDiffs(leftValue, rightValue, path, differences) {
  if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
    const limit = Math.max(leftValue.length, rightValue.length);
    for (let index = 0; index < limit; index += 1) {
      collectComparableDiffs(leftValue[index], rightValue[index], `${path}[${index}]`, differences);
    }
    return;
  }

  if (isPlainObject(leftValue) && isPlainObject(rightValue)) {
    const keys = [...new Set([...Object.keys(leftValue), ...Object.keys(rightValue)])].sort();
    for (const key of keys) {
      collectComparableDiffs(
        leftValue[key],
        rightValue[key],
        path ? `${path}.${key}` : key,
        differences
      );
    }
    return;
  }

  if (!Object.is(leftValue, rightValue)) {
    differences.push({
      path: path || "root",
      left: leftValue,
      right: rightValue
    });
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
