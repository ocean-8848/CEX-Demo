#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";

import { renderDemoEvidenceMarkdown } from "./demo-evidence-lib.mjs";

async function readInput() {
  const filePath = process.argv[2];
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

try {
  const raw = await readInput();
  const payload = JSON.parse(raw);
  process.stdout.write(renderDemoEvidenceMarkdown(payload));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
