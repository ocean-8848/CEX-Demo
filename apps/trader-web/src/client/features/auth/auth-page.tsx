import { useState, type FormEvent } from "react";

import { Button, Field } from "@web3-cex/web-ui";

import { readErrorMessage } from "../../lib/api.js";
import { navigate } from "../../lib/router.js";
import { useExchange } from "../../state/store.js";

export function AuthPage(props: { mode: "login" | "register"; redirect?: string }) {
  const { state, actions } = useExchange();
  const [mode, setMode] = useState(props.mode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needs2fa, setNeeds2fa] = useState(false);
  const [email, setEmail] = useState("");
  const demoAccount = state.config?.demo.account;
  const afterLogin = () => navigate(props.redirect ?? `/trade/${state.market}`);

  async function onLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await actions.login({
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
        twoFactorCode: String(form.get("twoFactorCode") ?? "") || undefined
      });
      afterLogin();
    } catch (loginError) {
      const message = readErrorMessage(loginError);
      if (/two.?factor|2fa|二次验证/i.test(message)) {
        setNeeds2fa(true);
      }
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function onRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const password = String(form.get("password") ?? "");
    if (password.length < 8) {
      setError("密码至少 8 位");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const registeredEmail = String(form.get("email") ?? "");
      await actions.register({
        displayName: String(form.get("displayName") ?? ""),
        email: registeredEmail,
        password
      });
      formElement.reset();
      setEmail(registeredEmail);
      setMode("login");
    } catch (registerError) {
      setError(readErrorMessage(registerError));
    } finally {
      setBusy(false);
    }
  }

  async function demoLogin() {
    if (!demoAccount) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await actions.login(demoAccount);
      afterLogin();
    } catch (loginError) {
      setError(`${readErrorMessage(loginError)}。演示账户由 pnpm demo:prepare 创建。`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-tabs" role="tablist">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setError(null); }}>
            登录
          </button>
          <button type="button" className={mode === "register" ? "active" : ""} onClick={() => { setMode("register"); setError(null); }}>
            注册
          </button>
        </div>

        {mode === "login" ? (
          <form id="login-form" onSubmit={onLogin} className="auth-form">
            <Field label="邮箱">
              <input
                name="email"
                type="email"
                required
                autoComplete="username"
                defaultValue={email}
                key={email}
                placeholder="you@example.com"
              />
            </Field>
            <Field label="密码">
              <input name="password" type="password" required autoComplete="current-password" placeholder="请输入密码" />
            </Field>
            {needs2fa ? (
              <Field label="二次验证码" hint="身份验证器 App 中的 6 位动态码；手机丢失时可输入一次性恢复码（xxxx-xxxx）">
                <input name="twoFactorCode" maxLength={9} autoComplete="one-time-code" />
              </Field>
            ) : null}
            {error ? <div className="form-error" role="alert">{error}</div> : null}
            <Button type="submit" variant="primary" size="lg" block loading={busy}>
              登录
            </Button>
          </form>
        ) : (
          <form id="register-form" onSubmit={onRegister} className="auth-form">
            <Field label="昵称">
              <input name="displayName" required placeholder="Satoshi" />
            </Field>
            <Field label="邮箱">
              <input name="email" type="email" required autoComplete="username" placeholder="you@example.com" />
            </Field>
            <Field label="密码" hint="至少 8 位">
              <input name="password" type="password" required autoComplete="new-password" minLength={8} />
            </Field>
            {error ? <div className="form-error" role="alert">{error}</div> : null}
            <Button type="submit" variant="primary" size="lg" block loading={busy}>
              创建账户
            </Button>
            <p className="form-note">新账户余额为 0，注册后可以在「资产」页领取测试币。</p>
          </form>
        )}

        {demoAccount ? (
          <div className="demo-login">
            <div className="divider"><span>或</span></div>
            <Button size="lg" block onClick={() => void demoLogin()} loading={busy} id="demo-login">
              ⚡ 一键登录演示账户
            </Button>
            <p className="form-note">
              演示账户预置 25,000 USDT 与 5 ETH：<code>{demoAccount.email}</code>
            </p>
          </div>
        ) : null}
      </div>

      <aside className="auth-aside">
        <h2>登录时发生了什么？</h2>
        <ol className="explain-list">
          <li>
            <b>trader-web</b> 把请求同源代理到 <code>api-gateway</code>，浏览器不直接接触内部服务。
          </li>
          <li>
            <b>api-gateway</b> 对登录接口做限流，再转发给 <code>identity-service</code>。
          </li>
          <li>
            <b>identity-service</b> 校验密码哈希（开启 2FA 时还会校验 TOTP），签发一个有过期时间的 Session Token。
          </li>
          <li>
            token 不交给页面：trader-web 的 Web Host 把它写进 <code>HttpOnly; SameSite=Strict</code> Cookie，页面脚本（包括 XSS 注入的脚本）读不到。
          </li>
          <li>
            之后每个私有请求由 Web Host 换成 <code>Authorization: Bearer &lt;token&gt;</code> 转给网关；写操作还要带 <code>x-csrf-token</code> 防跨站请求伪造。
          </li>
          <li>
            私有 WebSocket 也经 Web Host 代理并在握手时附上 token，订单、余额、充提变化会被实时推送。
          </li>
        </ol>
      </aside>
    </div>
  );
}
