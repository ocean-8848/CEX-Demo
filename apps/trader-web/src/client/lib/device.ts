/**
 * Long-lived random device id (login security / new-device detection). It is
 * not a fingerprint: clearing site data simply makes the browser a "new
 * device" again. identity-service records it with every login.
 */
const DEVICE_ID_KEY = "web3-cex:device-id";

export function getDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) {
      return existing;
    }
    const created = `web_${randomHex(16)}`;
    window.localStorage.setItem(DEVICE_ID_KEY, created);
    return created;
  } catch {
    // Storage blocked (private mode): fall back to a per-page id.
    return `web_${randomHex(16)}`;
  }
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(buffer);
  } else {
    for (let index = 0; index < bytes; index += 1) {
      buffer[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(buffer, (value) => value.toString(16).padStart(2, "0")).join("");
}
