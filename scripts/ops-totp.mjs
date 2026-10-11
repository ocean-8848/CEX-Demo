// Prints the current TOTP code for a seeded ops account (learning demo only).
//   pnpm -s ops:totp            -> ops-admin@example.com (first approver)
//   pnpm -s ops:totp reviewer   -> ops-reviewer@example.com (second approver, M5-2)
import { DEMO_OPS, DEMO_OPS_REVIEWER, generateTotpCode } from "./mvp-demo-lib.mjs";

const account = process.argv[2] === "reviewer" ? DEMO_OPS_REVIEWER : DEMO_OPS;
const secret = process.env.OPS_TOTP_SECRET ?? account.twoFactorSecret;
const now = new Date();
const { code } = generateTotpCode(secret, now);
const secondsLeft = 30 - (Math.floor(now.getTime() / 1000) % 30);
console.log(`${code}  (valid for ${secondsLeft}s, account ${account.email})`);
