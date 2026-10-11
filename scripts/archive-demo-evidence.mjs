#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  formatDemoEvidenceBaselineName,
  renderDemoEvidenceMarkdown,
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

async function readInput() {
  const filePath = process.argv
    .slice(2)
    .find(
      (arg, index, args) =>
        !arg.startsWith("--") &&
        args[index - 1] !== "--name" &&
        args[index - 1] !== "--baseline"
    );
  if (filePath) {
    return readFile(filePath, "utf8");
  }

  if (process.stdin.isTTY) {
    throw new Error("Expected demo flow JSON from stdin or a file path.");
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(String(chunk));
  }
  return chunks.join("");
}

function readSnapshotTarget() {
  const baselineName = readArgValue("--baseline") ?? process.env.DEMO_EVIDENCE_BASELINE_NAME;
  if (baselineName) {
    return {
      kind: "baseline",
      safeName: formatDemoEvidenceBaselineName(baselineName)
    };
  }

  const snapshotName = readArgValue("--name") ?? process.env.DEMO_EVIDENCE_SNAPSHOT_NAME;
  if (snapshotName) {
    return {
      kind: "snapshot",
      safeName: sanitizeSnapshotName(snapshotName, "demo-evidence")
    };
  }

  return null;
}

try {
  const raw = await readInput();
  const payload = JSON.parse(raw);
  const generatedAt = new Date().toISOString();
  const markdown = renderDemoEvidenceMarkdown(payload, { generatedAt });
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const snapshotDir = path.join(rootDir, ".runtime", "demo-evidence");
  const latestMarkdownPath = path.join(snapshotDir, "latest.md");
  const latestJsonPath = path.join(snapshotDir, "latest.json");
  const snapshotTarget = readSnapshotTarget();

  await mkdir(snapshotDir, { recursive: true });
  await writeFile(latestMarkdownPath, markdown, "utf8");
  await writeFile(`${latestJsonPath}`, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  process.stdout.write(markdown);
  process.stdout.write(`已更新 latest 快照:\n- ${latestMarkdownPath}\n- ${latestJsonPath}\n`);

  if (snapshotTarget) {
    const namedMarkdownPath = path.join(snapshotDir, `${snapshotTarget.safeName}.md`);
    const namedJsonPath = path.join(snapshotDir, `${snapshotTarget.safeName}.json`);
    await writeFile(namedMarkdownPath, markdown, "utf8");
    await writeFile(namedJsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    process.stdout.write(
      snapshotTarget.kind === "baseline" ? "已保存基线快照:\n" : "已保存命名快照:\n"
    );
    process.stdout.write(`- ${namedMarkdownPath}\n- ${namedJsonPath}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
