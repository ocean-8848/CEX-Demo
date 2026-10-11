import { useState, type FormEvent } from "react";

import { Button, Field } from "@web3-cex/web-ui";

import { readErrorMessage } from "../lib/api.js";
import { useSession } from "../state/session.js";

export function LoginPage() {
  const { login, theme, toggleTheme } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await login({
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
        twoFactorCode: String(form.get("twoFactorCode") ?? "")
      });
    } catch (loginError) {
      setError(readErrorMessage(loginError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <button type="button" className="icon-btn theme-corner" aria-label="切换主题" onClick={toggleTheme}>
        {theme === "dark" ? "☀" : "☾"}
      </button>
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark big" aria-hidden="true">
            ◆
          </span>
          <div>
            <h1>运营后台</h1>
            <p className="muted">Web3 CEX Learning Demo · 内部系统</p>
          </div>
        </div>
        <form id="ops-login-form" className="login-form" onSubmit={onSubmit}>
          <Field label="邮箱">
            <input name="email" type="email" required autoComplete="username" defaultValue="ops-admin@example.com" />
          </Field>
          <Field label="密码">
            <input name="password" type="password" required autoComplete="current-password" placeholder="请输入密码" />
          </Field>
          <Field label="二次验证码（TOTP）" hint="运营账户强制开启 2FA；同一个验证码只能使用一次">
            <input
              name="twoFactorCode"
              inputMode="numeric"
              maxLength={6}
              autoComplete="one-time-code"
              placeholder="6 位动态码"
              required
            />
          </Field>
          {error ? (
            <div className="form-error" role="alert">
              {error}
            </div>
          ) : null}
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            登录
          </Button>
        </form>
        <details className="login-help">
          <summary>演示账户与验证码</summary>
          <p>
            账户 <code>ops-admin@example.com</code> / <code>OpsAdminPass123!</code>，TOTP 种子
            <code>JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP</code>（由 <code>pnpm demo:prepare</code> 创建）。
          </p>
          <p>用任意身份验证器 App 添加该种子即可获得动态码，或在仓库根目录运行：</p>
          <pre>pnpm -s ops:totp</pre>
        </details>
      </div>
    </div>
  );
}
