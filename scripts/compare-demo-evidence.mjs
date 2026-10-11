#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  compareDemoEvidenceSnapshots,
  formatDemoEvidenceBaselineName,
  renderDemoEvidenceComparisonMarkdown,
  sanitizeSnapshotName
} from "./demo-evidence-lib.mjs";

function readArgValue(flag) {
  const inlineArg = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (inlineArg) {
    return inlineArg.slice(flag.length + 1);
  }

  const index = process.argv.indexOf(flag);
  if (index >= 0) {
    return process.argv[index + 1];
  }

  return undefined;
}

function hasFlag(flag) {
  return process.argv.includes(flag) || process.argv.some((arg) => arg.startsWith(`${flag}=`));
}

function shouldFailOnDrift() {
  if (hasFlag("--fail-on-drift")) {
    return true;
  }

  const raw = String(process.env.DEMO_EVIDENCE_FAIL_ON_DRIFT ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveSnapshotPaths() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const snapshotDir = path.join(rootDir, ".runtime", "demo-evidence");
  const baselineName = readArgValue("--baseline");
  const leftPath =
    readArgValue("--left") ??
    (baselineName
      ? path.join(snapshotDir, `${formatDemoEvidenceBaselineName(baselineName)}.json`)
      : path.join(snapshotDir, "latest.json"));
  const rightPath =
    readArgValue("--right") ??
    (() => {
      if (baselineName) {
        return path.join(snapshotDir, "latest.json");
      }
      const snapshotName = readArgValue("--name");
      if (!snapshotName) {
        throw new Error("Expected --baseline <baseline> / --name <snapshot> or explicit --right <path>.");
      }
      return path.join(snapshotDir, `${sanitizeSnapshotName(snapshotName, "demo-evidence")}.json`);
    })();

  return {
    rootDir,
    snapshotDir,
    leftPath: path.resolve(leftPath),
    rightPath: path.resolve(rightPath)
  };
}

function resolveReportName(rightPath) {
  const explicitReportName = readArgValue("--report-name");
  if (explicitReportName) {
    return sanitizeSnapshotName(explicitReportName, "demo-evidence-drift");
  }

  const baselineName = readArgValue("--baseline");
  if (baselineName) {
    return formatDemoEvidenceBaselineName(baselineName);
  }

  const snapshotName = readArgValue("--name");
  if (snapshotName) {
    return sanitizeSnapshotName(snapshotName, "demo-evidence");
  }

  return sanitizeSnapshotName(path.basename(rightPath, path.extname(rightPath)), "demo-evidence");
}

async function writeComparisonReports(params) {
  const generatedAt = new Date().toISOString();
  const reportsDir = path.join(params.snapshotDir, "reports");
  const latestMarkdownPath = path.join(reportsDir, "latest.md");
  const latestJsonPath = path.join(reportsDir, "latest.json");
  const reportName = resolveReportName(params.rightPath);
  const namedMarkdownPath = path.join(reportsDir, `${reportName}.md`);
  const namedJsonPath = path.join(reportsDir, `${reportName}.json`);
  const markdown = renderDemoEvidenceComparisonMarkdown(params.comparison, { generatedAt });
  const reportPayload = {
    generatedAt,
    failOnDrift: params.failOnDrift,
    leftPath: params.leftPath,
    rightPath: params.rightPath,
    reportName,
    comparison: params.comparison
  };

  await mkdir(reportsDir, { recursive: true });
  await writeFile(latestMarkdownPath, markdown, "utf8");
  await writeFile(latestJsonPath, `${JSON.stringify(reportPayload, null, 2)}\n`, "utf8");
  await writeFile(namedMarkdownPath, markdown, "utf8");
  await writeFile(namedJsonPath, `${JSON.stringify(reportPayload, null, 2)}\n`, "utf8");

  return {
    markdown,
    latestMarkdownPath,
    latestJsonPath,
    namedMarkdownPath,
    namedJsonPath
  };
}

try {
  const { snapshotDir, leftPath, rightPath } = resolveSnapshotPaths();
  const [leftRaw, rightRaw] = await Promise.all([readFile(leftPath, "utf8"), readFile(rightPath, "utf8")]);
  const comparison = compareDemoEvidenceSnapshots(JSON.parse(leftRaw), JSON.parse(rightRaw), {
    leftLabel: path.basename(leftPath),
    rightLabel: path.basename(rightPath)
  });
  const failOnDrift = shouldFailOnDrift();
  const reports = await writeComparisonReports({
    snapshotDir,
    leftPath,
    rightPath,
    comparison,
    failOnDrift
  });
  process.stdout.write(reports.markdown);
  process.stdout.write(`对比文件:\n- ${leftPath}\n- ${rightPath}\n`);
  process.stdout.write(
    `已归档 drift 报告:\n- ${reports.latestMarkdownPath}\n- ${reports.latestJsonPath}\n- ${reports.namedMarkdownPath}\n- ${reports.namedJsonPath}\n`
  );
  if (failOnDrift) {
    process.stdout.write(`门禁模式: enabled\n`);
  }
  if (failOnDrift && comparison.driftCount > 0) {
    process.stderr.write("Detected normalized drift and fail-on-drift is enabled.\n");
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
