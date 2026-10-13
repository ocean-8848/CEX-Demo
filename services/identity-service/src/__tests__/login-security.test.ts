import assert from "node:assert/strict";
import test from "node:test";

import { IdentityApplicationService } from "../application/identity-application-service.js";
import { LoginSecurityService } from "../application/login-security-service.js";
import { IdentityError } from "../domain/errors.js";
import {
  describeUserAgent,
  evaluateLoginLock,
  resolveDeviceId,
  type LoginEventRecord,
  type NewDeviceLoginNotice
} from "../domain/login-security.js";
import { InMemoryIdentityRepository } from "../infrastructure/in-memory-identity-repository.js";
import { InMemoryLoginSecurityRepository } from "../infrastructure/in-memory-login-security-repository.js";

const USER_ID = "33333333-3333-4333-8333-333333333333";
const EMAIL = "device@example.com";
const PASSWORD = "DevicePass123!";
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function createHarness(options: { maxFailures?: number; lockSeconds?: number } = {}) {
  let nowMs = Date.parse("2026-06-01T08:00:00.000Z");
  const now = () => new Date(nowMs);
  const repository = new InMemoryIdentityRepository();
  const loginRepository = new InMemoryLoginSecurityRepository();
  const notices: NewDeviceLoginNotice[] = [];
  const loginSecurity = new LoginSecurityService(loginRepository, repository, {
    now,
    lockPolicy: {
      maxFailures: options.maxFailures ?? 3,
      windowSeconds: 900,
      lockSeconds: options.lockSeconds ?? 300
    },
    notifier: {
      async notifyNewDeviceLogin(notice) {
        notices.push(notice);
      }
    }
  });
  const service = new IdentityApplicationService(repository, { now, loginSecurity });
  await service.createUser({ userId: USER_ID, email: EMAIL, password: PASSWORD });
  return {
    service,
    loginSecurity,
    notices,
    advance(seconds: number) {
      nowMs += seconds * 1000;
    },
    login(deviceId?: string, password = PASSWORD, userAgent = CHROME_MAC) {
      return service.createCustomerSession({ email: EMAIL, password, deviceId, userAgent, ipAddress: "10.0.0.8" });
    }
  };
}

test("helpers: device id fallback and user agent summary", () => {
  assert.equal(resolveDeviceId("dev_abcdefgh1234", undefined), "dev_abcdefgh1234");
  assert.equal(resolveDeviceId("bad id!", "curl/8"), resolveDeviceId(undefined, "curl/8"));
  assert.match(resolveDeviceId(undefined, undefined), /^ua-[0-9a-f]{16}$/);
  assert.equal(describeUserAgent(CHROME_MAC), "Chrome · macOS");
  assert.equal(describeUserAgent("node"), "Node.js 脚本");
});

test("lock policy: counts wrong secrets since the last success inside the window", () => {
  const at = (minutesAgo: number, outcome: LoginEventRecord["outcome"], failureCode?: string): LoginEventRecord => ({
    eventId: `${minutesAgo}-${outcome}`,
    userId: USER_ID,
    email: EMAIL,
    scope: "customer_web",
    deviceId: "d",
    deviceLabel: "",
    outcome,
    failureCode,
    isNewDevice: false,
    createdAt: new Date(Date.parse("2026-06-01T08:00:00.000Z") - minutesAgo * 60_000).toISOString()
  });
  const now = new Date("2026-06-01T08:00:00.000Z");
  const policy = { maxFailures: 3, windowSeconds: 900, lockSeconds: 300 };
  const locked = evaluateLoginLock(
    [at(1, "failure", "INVALID_CREDENTIALS"), at(2, "failure", "TWO_FACTOR_INVALID_CODE"), at(3, "failure", "INVALID_CREDENTIALS")],
    now,
    policy
  );
  assert.equal(locked.locked, true);
  assert.equal(locked.remainingSeconds, 240);
  // A success in between resets the counter; missing 2FA codes never count.
  assert.equal(
    evaluateLoginLock(
      [at(1, "failure", "INVALID_CREDENTIALS"), at(2, "success"), at(3, "failure", "INVALID_CREDENTIALS"), at(4, "failure", "INVALID_CREDENTIALS")],
      now,
      policy
    ).locked,
    false
  );
  assert.equal(
    evaluateLoginLock([at(1, "failure", "TWO_FACTOR_REQUIRED"), at(2, "failure", "TWO_FACTOR_REQUIRED"), at(3, "failure", "TWO_FACTOR_REQUIRED")], now, policy).locked,
    false
  );
  // Failures older than the window drop out; maxFailures 0 disables the lock.
  assert.equal(evaluateLoginLock([at(1, "failure", "INVALID_CREDENTIALS"), at(20, "failure", "INVALID_CREDENTIALS"), at(21, "failure", "INVALID_CREDENTIALS")], now, policy).locked, false);
  assert.equal(evaluateLoginLock([at(1, "failure", "INVALID_CREDENTIALS")], now, { ...policy, maxFailures: 0 }).locked, false);
});

test("login events: success and failure are recorded with device, IP and user agent", async () => {
  const harness = await createHarness();
  await assert.rejects(harness.login("device-aaaaaaaa", "wrong"), /invalid/i);
  const session = await harness.login("device-aaaaaaaa");
  assert.equal(session.device?.deviceId, "device-aaaaaaaa");
  assert.equal(session.device?.isNewDevice, false, "the first device of an account is not new");
  const events = await harness.loginSecurity.listLoginEvents({ userId: USER_ID });
  assert.deepEqual(events.items.map((event) => event.outcome), ["success", "failure"]);
  assert.equal(events.items[1]?.failureCode, "INVALID_CREDENTIALS");
  assert.equal(events.items[0]?.ipAddress, "10.0.0.8");
  assert.equal(events.items[0]?.deviceLabel, "Chrome · macOS");
});

test("new device: a second device is flagged, notified once, then known", async () => {
  const harness = await createHarness();
  await harness.login("device-aaaaaaaa");
  harness.advance(60);
  const second = await harness.login("device-bbbbbbbb");
  assert.equal(second.device?.isNewDevice, true);
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0]?.deviceId, "device-bbbbbbbb");
  harness.advance(60);
  const again = await harness.login("device-bbbbbbbb");
  assert.equal(again.device?.isNewDevice, false);
  assert.equal(harness.notices.length, 1);

  const summary = await harness.loginSecurity.getLoginSecuritySummary(USER_ID);
  assert.equal(summary.lastNewDeviceLoginAt, "2026-06-01T08:01:00.000Z");
  const devices = await harness.loginSecurity.listDevices(USER_ID);
  assert.equal(devices.length, 2);
  const b = devices.find((device) => device.deviceId === "device-bbbbbbbb");
  assert.equal(b?.flaggedNew, true);
  assert.equal(b?.loginCount, 2);
  assert.equal(b?.activeSessionCount, 2);
});

test("notifier failures never block a login", async () => {
  const repository = new InMemoryIdentityRepository();
  const loginSecurity = new LoginSecurityService(new InMemoryLoginSecurityRepository(), repository, {
    notifier: {
      async notifyNewDeviceLogin() {
        throw new Error("wallet down");
      }
    }
  });
  const service = new IdentityApplicationService(repository, { loginSecurity });
  await service.createUser({ userId: USER_ID, email: EMAIL, password: PASSWORD });
  await service.createCustomerSession({ email: EMAIL, password: PASSWORD, deviceId: "device-aaaaaaaa" });
  const session = await service.createCustomerSession({ email: EMAIL, password: PASSWORD, deviceId: "device-cccccccc" });
  assert.equal(session.device?.isNewDevice, true);
});

test("revoking a device ends its sessions only", async () => {
  const harness = await createHarness();
  const a = await harness.login("device-aaaaaaaa");
  const b = await harness.login("device-bbbbbbbb");
  const result = await harness.loginSecurity.revokeDevice(USER_ID, "device-bbbbbbbb");
  assert.equal(result.revokedSessionCount, 1);
  await assert.rejects(harness.service.introspectCustomerSession(b.token), /revoked/i);
  const stillValid = await harness.service.introspectCustomerSession(a.token);
  assert.equal(stillValid.userId, USER_ID);
  const devices = await harness.loginSecurity.listDevices(USER_ID);
  assert.equal(devices.find((device) => device.deviceId === "device-bbbbbbbb")?.activeSessionCount, 0);
  await assert.rejects(
    harness.loginSecurity.revokeDevice(USER_ID, "device-zzzzzzzz"),
    (error: unknown) => error instanceof IdentityError && error.code === "DEVICE_NOT_FOUND"
  );
});

test("lockout: repeated wrong passwords lock the account temporarily, even for the right password", async () => {
  const harness = await createHarness({ maxFailures: 3, lockSeconds: 300 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(harness.login("device-aaaaaaaa", "wrong"), /invalid/i);
  }
  await assert.rejects(
    harness.login("device-aaaaaaaa"),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "LOGIN_TEMPORARILY_LOCKED" && /remainingSeconds=300/.test(error.message)
  );
  const events = await harness.loginSecurity.listLoginEvents({ userId: USER_ID });
  assert.equal(events.items[0]?.outcome, "locked");

  harness.advance(301);
  const session = await harness.login("device-aaaaaaaa");
  assert.ok(session.token);
  // The success resets the counter: one more wrong password does not re-lock.
  await assert.rejects(harness.login("device-aaaaaaaa", "wrong"), /invalid/i);
  assert.ok((await harness.login("device-aaaaaaaa")).token);
});

test("lockout disabled with maxFailures 0", async () => {
  const harness = await createHarness({ maxFailures: 0 });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await assert.rejects(harness.login(undefined, "wrong"), /invalid/i);
  }
  assert.ok((await harness.login()).token);
});
