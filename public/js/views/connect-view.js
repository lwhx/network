import { icon } from "../icons.js";
import { state } from "../state.js";
import { escapeHtml } from "../utils.js";

function renderCloudflareAccountRows() {
  return state.setupCloudflareAccounts
    .map(
      (account, index) => `
        <section class="setup-account-row" data-cf-account-row>
          <div class="setup-account-row-title">
            <strong>Cloudflare 账号 ${index + 1}</strong>
            ${
              state.setupCloudflareAccounts.length > 1
                ? `<button class="ghost-button setup-account-remove" type="button" data-remove-cf-account="${index}" ${state.setupSubmitting ? "disabled" : ""}>移除</button>`
                : ""
            }
          </div>
          <div class="setup-grid">
            <label class="connect-field">
              <span>账号名称</span>
              <input name="cloudflareName" type="text" autocomplete="off" placeholder="${index === 0 ? "主账号" : `账号 ${index + 1}`}" value="${escapeHtml(account.cloudflareName || "")}" />
            </label>
            <label class="connect-field">
              <span>Cloudflare 登录邮箱</span>
              <input name="cfEmail" type="email" autocomplete="email" placeholder="name@example.com" value="${escapeHtml(account.cfEmail || "")}" />
            </label>
          </div>
          <label class="connect-field">
            <span>Cloudflare Global API Key</span>
            <input name="cfApiKey" type="password" autocomplete="off" placeholder="仅写入服务端 SQLite" value="${escapeHtml(account.cfApiKey || "")}" />
          </label>
        </section>
      `
    )
    .join("");
}

function renderVerifierInput() {
  return state.totpEnabled ? `
    <label class="connect-field"><span>验证器验证码</span>
      <input name="auth" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位动态验证码" required />
    </label>` : "";
}

function renderRememberLogin() {
  return `<label class="login-check"><input name="remember" type="checkbox" ${state.rememberLogin !== false ? "checked" : ""} />记住登录（最长 30 天）</label>`;
}

function renderAdminSetupBody() {
  return `
    <div class="connect-heading setup-heading">
      <span class="connect-kicker">首次使用</span><h2>创建管理员</h2>
      <p>设置账号密码后即可继续，验证器可稍后开启。</p>
    </div>
    <form class="connect-card setup-card" id="panel-setup-form">
      <label class="connect-field"><span>初始化口令</span>
        <input name="setupToken" type="password" autocomplete="off" value="${escapeHtml(state.setupToken || "")}" placeholder="仅首次创建管理员时需要" required />
      </label>
      <details class="setup-token-help"><summary>如何获取初始化口令？</summary>
        <p>在服务器终端执行：</p><code>docker exec cloudflare-preferred-panel cat /data/setup-token.txt</code>
      </details>
      <label class="connect-field"><span>用户名</span><input name="username" type="text" autocomplete="username" value="admin" required /></label>
      <label class="connect-field"><span>密码</span><input name="password" type="password" autocomplete="new-password" minlength="10" placeholder="至少 10 位" required /></label>
      <label class="connect-field"><span>确认密码</span><input name="confirmPassword" type="password" autocomplete="new-password" placeholder="再次输入密码" required /></label>
      <label class="login-check"><input id="setup-use-2fa" type="checkbox" ${state.setupUseTwoFactor ? "checked" : ""} />现在绑定验证器（可选）</label>
      ${state.setupUseTwoFactor ? `
        <section class="setup-group setup-optional-totp">
          <h4>绑定验证器</h4>
          <div class="setup-secret-box"><span>${state.setupLoadingSecret ? "正在生成..." : escapeHtml(state.setupSecret || "生成密钥后添加到验证器")}</span>
            <button class="ghost-button setup-secret-refresh" id="setup-secret-refresh" type="button" ${state.setupLoadingSecret || state.setupSubmitting ? "disabled" : ""}>${state.setupSecret ? "重新生成" : "生成密钥"}</button>
          </div>
          <input name="totpSecret" type="hidden" value="${escapeHtml(state.setupSecret)}" />
          <label class="connect-field"><span>验证器验证码</span><input name="totpCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位动态验证码" required /></label>
        </section>` : ""}
      <p class="connect-help">管理员创建后自动登录。Cloudflare 账号在下一步添加。</p>
      <button class="primary-button connect-submit" type="submit" ${state.setupSubmitting || state.setupLoadingSecret || (state.setupUseTwoFactor && !state.setupSecret) ? "disabled" : ""}>${state.setupSubmitting ? "创建中..." : "创建管理员并进入下一步"}</button>
      ${state.sessionError ? `<div class="notice error-notice">${escapeHtml(state.sessionError)}</div>` : ""}
    </form>`;
}

function renderSetupSessionRecovery() {
  if (state.sessionAuthenticated) {
    return "";
  }

  return `
    <form class="connect-card setup-card setup-session-card" id="setup-session-login-form">
      <div class="connect-card-title">
        <span>${icon("shield")}</span>
        <div>
          <h3>恢复管理员会话</h3>
          <p>管理员已创建，但当前浏览器没有有效会话。请先登录，再保存 Cloudflare 账号。</p>
        </div>
      </div>

      <div class="setup-grid">
        <label class="connect-field">
          <span>用户名</span>
          <input name="user" type="text" autocomplete="username" placeholder="admin" />
        </label>
        <label class="connect-field">
          <span>密码</span>
          <input name="password" type="password" autocomplete="current-password" placeholder="面板密码" />
        </label>
      </div>
      ${renderVerifierInput()}
      ${renderRememberLogin()}

      <div class="connect-warning">
        <strong>为什么需要这一步</strong>
        <span>如果第一次创建管理员时浏览器没有保存 Cookie，第二步保存 Cloudflare 账号会缺少管理员会话。</span>
      </div>

      <button class="primary-button connect-submit" type="submit" ${state.setupLoginSubmitting ? "disabled" : ""}>
        ${state.setupLoginSubmitting ? "登录中..." : "恢复会话并继续"}
      </button>
    </form>
  `;
}

function renderCloudflareSetupBody() {
  const canSubmitCloudflareAccounts = state.sessionAuthenticated && !state.setupSubmitting;

  return `
    <div class="connect-heading setup-heading">
      <span class="connect-kicker">第二步</span>
      <h2>添加 Cloudflare 账号</h2>
      <p>项目支持多账户管理，可一次添加多个 Cloudflare 账号，后续登录后在顶部切换。</p>
    </div>

    ${renderSetupSessionRecovery()}

    <form class="connect-card setup-card setup-cloudflare-card" id="cloudflare-accounts-setup-form">
      <div class="connect-card-title">
        <span>${icon("cloud")}</span>
        <div>
          <h3>Cloudflare 多账号</h3>
          <p>Global API Key 只写入容器内 SQLite，不进入 Cookie、localStorage 或操作历史。</p>
        </div>
      </div>

      <div class="setup-accounts-list">
        ${renderCloudflareAccountRows()}
      </div>

      <button class="ghost-button setup-account-add" id="setup-add-cf-account" type="button" ${state.setupSubmitting || state.setupCloudflareAccounts.length >= 10 ? "disabled" : ""}>
        添加更多账号
      </button>

      <div class="connect-security">
        <strong>安全检查</strong>
        <span>账号邮箱仅在前端脱敏展示；Global API Key 不会从接口返回。</span>
        <span>至少添加一个 Cloudflare 账号后，面板才能读取域名和管理资源。</span>
      </div>

      <button class="primary-button connect-submit" type="submit" ${canSubmitCloudflareAccounts ? "" : "disabled"}>
        ${
          state.setupSubmitting
            ? "保存中..."
            : state.sessionAuthenticated
              ? "保存 Cloudflare 账号并进入面板"
              : "请先恢复管理员会话"
        }
      </button>
      ${state.sessionError ? `<div class="notice error-notice">${escapeHtml(state.sessionError)}</div>` : ""}
    </form>
  `;
}

function renderConnectBody() {
  if (state.checkingSession) {
    return `
      <div class="connect-loading">
        <div class="spinner"></div>
        <strong>正在检查面板会话</strong>
      </div>
    `;
  }

  if (state.setupRequired) {
    return state.setupStep === "cloudflare" ? renderCloudflareSetupBody() : renderAdminSetupBody();
  }

  return `
    <div class="connect-heading">
      <h2>登录蜘蛛网络面板</h2>
      <p>登录后即可选择已保存的 Cloudflare 账号</p>
    </div>

    <form class="connect-card" id="cloudflare-connect-form">
      <div class="connect-card-title">
        <span>${icon("shield")}</span>
        <div>
          <h3>面板登录</h3>
          <p>${state.totpEnabled ? "输入账号密码和验证器验证码。" : "输入账号密码即可登录。"}</p>
        </div>
      </div>

      <label class="connect-field">
        <span>用户名</span>
        <input name="user" type="text" autocomplete="username" placeholder="admin" />
      </label>
      <label class="connect-field">
        <span>密码</span>
        <input name="password" type="password" autocomplete="current-password" placeholder="面板密码" />
      </label>
      ${renderVerifierInput()}
      ${renderRememberLogin()}
      <p class="connect-help">勾选记住登录后，关闭网页或重启容器仍可继续使用。</p>

      <button class="primary-button connect-submit" type="submit" ${state.connectingSession ? "disabled" : ""}>
        ${state.connectingSession ? "登录中..." : "登录并进入管理后台"}
      </button>
      ${state.sessionError ? `<div class="notice error-notice">${escapeHtml(state.sessionError)}</div>` : ""}
    </form>

    <div class="connect-register">
      <span>还没有 Cloudflare 账号？</span>
      <a href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noreferrer">立即注册</a>
      <p>注册后，您可以免费使用 Cloudflare 的 CDN、DNS 和其他强大功能</p>
    </div>
  `;
}

export function renderConnectView() {
  const app = document.querySelector("#app");
  app.className = "connect-root";
  const wrapClass =
    state.setupRequired && state.setupStep === "cloudflare"
      ? "connect-wrap setup-cloudflare-wrap"
      : "connect-wrap";

  app.innerHTML = `
    <main class="connect-page">
      <header class="connect-header">
        <div class="connect-brand">
          <img class="connect-brand-mark" src="assets/spider-icon.png" alt="Spider" />
          <div>
            <h1>蜘蛛网络</h1>
            <p>好用的Cloudflare管理工具</p>
          </div>
        </div>
      </header>
      <section class="connect-section">
        <div class="${wrapClass}">
          ${renderConnectBody()}
        </div>
      </section>
      <footer class="connect-footer">Power by Cloudflare 致敬赛博大善人</footer>
    </main>
  `;
}
