import { speedOptimizedDomains } from "../constants.js";
import { icon } from "../icons.js";
import { state } from "../state.js";
import { escapeHtml } from "../utils.js";
import { renderShell } from "./shell-view.js";
import { renderSpeedTasks } from "./speed-tasks-view.js";

function currentSpeedForm() {
  return state.speedForm || {};
}

function cacheTtlLabel(cacheTtl) {
  return String(cacheTtl) === "0" ? "不开启缓存" : `${escapeHtml(cacheTtl)} 秒`;
}

function speedDomainName(domain) {
  return domain.accessDomain || domain.domain || "";
}

function renderSpeedNotice() {
  if (!state.speedNotice) {
    return "";
  }

  return `<div class="speed-notice">${escapeHtml(state.speedNotice)}</div>`;
}

function renderOptimizedDomainOptions(selectedDomain) {
  return speedOptimizedDomains
    .map(
      (domain) => `
        <option value="${escapeHtml(domain.value)}" ${domain.value === selectedDomain ? "selected" : ""}>
          ${escapeHtml(domain.label)}
        </option>
      `
    )
    .join("");
}

function customOptimizedDomain(form) {
  const value = String(form.optimizedDomainCustom || "").trim();

  if (value) {
    return value;
  }

  return speedOptimizedDomains.some((domain) => domain.value === form.optimizedDomain)
    ? ""
    : form.optimizedDomain || "";
}

function renderSpeedConfigStep() {
  const form = currentSpeedForm();

  return `
    <form class="speed-card speed-config-card" id="speed-form">
      <h2 class="speed-gradient-title">一键加速域名配置</h2>
      <p>沿用当前域名区域的 SSL/TLS 模式。部署失败时会尝试恢复本次修改，并提示恢复结果。</p>
      <div class="speed-form-stack">
        <label class="speed-field" for="accessDomain">
          <span>访问域名</span>
          <input
            id="accessDomain"
            name="accessDomain"
            type="text"
            placeholder="www.xx.com"
            value="${escapeHtml(form.accessDomain || "")}"
            autocomplete="off"
          />
          <small>访问者将使用此域名访问您的内容</small>
        </label>

        <label class="speed-field" for="targetDomain">
          <span>源站域名</span>
          <input
            id="targetDomain"
            name="targetDomain"
            type="text"
            placeholder="jiasu.xx.com"
            value="${escapeHtml(form.targetDomain || "")}"
            autocomplete="off"
          />
          <small>你需要加速的网站</small>
        </label>

        <label class="speed-field" for="cacheTtl">
          <span>缓存时间（秒）</span>
          <input
            id="cacheTtl"
            name="cacheTtl"
            type="number"
            placeholder="0"
            min="0"
            value="${escapeHtml(form.cacheTtl || "0")}"
          />
          <small>0 表示不开启缓存，2592000 为一个月。默认：0</small>
        </label>

        <label class="speed-field" for="optimizedDomain">
          <span>推荐优选域名</span>
          <select id="optimizedDomain" name="optimizedDomain">
            ${renderOptimizedDomainOptions(form.optimizedDomain)}
          </select>
          <small>默认使用 saas.sin.fan 推荐，也可以在下方输入自定义优选域名</small>
        </label>

        <label class="speed-field" for="optimizedDomainCustom">
          <span>自定义优选域名</span>
          <input
            id="optimizedDomainCustom"
            name="optimizedDomainCustom"
            type="text"
            placeholder="例如: cdn.example.com"
            value="${escapeHtml(customOptimizedDomain(form))}"
            autocomplete="off"
          />
          <small>填写后会覆盖上方推荐选项，访问域名 CNAME 将指向这里</small>
        </label>

        <button class="speed-gradient-button speed-full-button" type="submit">配置完成</button>
      </div>
    </form>
  `;
}

function renderSummaryRows(form) {
  return `
    <div class="speed-summary-row">
      <span>SSL/TLS：</span>
      <strong>保持当前区域设置</strong>
    </div>
    <div class="speed-summary-row">
      <span>访问域名：</span>
      <strong>${escapeHtml(form.accessDomain || "-")}</strong>
    </div>
    <div class="speed-summary-row">
      <span>源站域名：</span>
      <strong>${escapeHtml(form.targetDomain || "-")}</strong>
    </div>
    <div class="speed-summary-row">
      <span>优选域名：</span>
      <strong>${escapeHtml(form.optimizedDomain || "-")}</strong>
    </div>
    <div class="speed-summary-row">
      <span>缓存时间：</span>
      <strong>${cacheTtlLabel(form.cacheTtl || "0")}</strong>
    </div>
  `;
}

function renderSpeedDeployStep() {
  const form = currentSpeedForm();
  const progress = Math.max(0, Math.min(100, Number(state.speedProgress) || 0));

  return `
    <section class="speed-card speed-state-card speed-deploy-card">
      <h2 class="speed-gradient-title">准备部署</h2>
      <div class="speed-deploy-stack">
        <div class="speed-summary-box">
          <h3>配置摘要</h3>
          <div class="speed-summary-list">${renderSummaryRows(form)}</div>
        </div>

        <div class="speed-progress-box">
          <div class="speed-progress-heading">
            <h4>部署进度</h4>
            <span>${progress}%</span>
          </div>
          <div class="speed-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}">
            <span style="width: ${progress}%"></span>
          </div>
        </div>

        <div class="speed-action-grid">
          <button class="speed-outline-button speed-grow-button" type="button" id="speed-back" ${state.speedDeploying ? "disabled" : ""}>
            返回
          </button>
          <button class="speed-gradient-button speed-grow-button" type="button" id="speed-start" ${state.speedDeploying ? "disabled" : ""}>
            ${state.speedDeploying ? `<span class="speed-spinner"></span>加速中...` : "开始加速"}
          </button>
        </div>
      </div>
    </section>
  `;
}

function renderSpeedCompleteStep() {
  const form = currentSpeedForm();

  return `
    <section class="speed-card speed-complete-card">
      <div class="speed-success-icon">${icon("check")}</div>
      <h2>部署成功！</h2>
      <p>加速配置已提交，请等待 DNS 解析和证书验证完成后检查访问。</p>

      <div class="speed-success-summary">
        <div class="speed-success-row">
          <span>访问域名：</span>
          <a href="https://${escapeHtml(form.accessDomain || "")}" target="_blank" rel="noopener noreferrer">
            ${escapeHtml(form.accessDomain || "-")}
          </a>
        </div>
        <div class="speed-success-row">
          <span>SSL/TLS：</span>
          <strong>保持当前区域设置</strong>
        </div>
      </div>

      <button class="speed-gradient-button" type="button" id="speed-next">部署下一个加速</button>
    </section>
  `;
}

function renderSpeedStep() {
  if (state.speedStep === "deploy") {
    return renderSpeedDeployStep();
  }

  if (state.speedStep === "complete") {
    return renderSpeedCompleteStep();
  }

  return renderSpeedConfigStep();
}

function renderSpeedDomainsBody() {
  if (!state.sessionHasServerCredentials && !state.connected) {
    return `
      <div class="speed-domains-empty">
        <strong>请先配置 Cloudflare 账户信息</strong>
        <p>需要配置 Account ID 和 API Token 才能查看已加速的域名</p>
      </div>
    `;
  }

  if (!state.speedAcceleratedDomains.length) {
    return state.speedDomainsLoading
      ? `<div class="speed-domains-empty speed-domains-empty-simple"><span class="spinner"></span>正在同步 Cloudflare...</div>`
      : `<div class="speed-domains-empty speed-domains-empty-simple">暂无已加速的域名</div>`;
  }

  return `
    <div class="speed-domain-list">
      ${state.speedAcceleratedDomains
        .map((domain) => {
          const domainName = speedDomainName(domain);
          return `
            <div class="speed-domain-row">
              <div class="speed-domain-main">
                <div class="speed-domain-titleline">
                  <strong>${escapeHtml(domainName)}</strong>
                  <span>已加速</span>
                </div>
                <small>
                  源站 ${escapeHtml(domain.targetDomain || domain.originUrl || "-")} ·
                  优选 ${escapeHtml(domain.optimizedDomain || domain.targetDomain || "-")}
                  ${domain.zoneName ? ` · Zone ${escapeHtml(domain.zoneName)}` : ""}
                </small>
              </div>
              <button
                class="speed-domain-delete"
                type="button"
                data-speed-domain-id="${escapeHtml(domain.id || domainName)}"
                aria-label="删除 ${escapeHtml(domainName)}"
                title="删除"
              >
                ${icon("trash")}
              </button>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderSpeedDomainsCard() {
  return `
    <article class="speed-domains-card">
      <div class="speed-domains-card-header">
        <div>
          <h3>
            <span>${icon("grid")}</span>
            已加速的域名
          </h3>
          <p>管理通过CDN加速的域名</p>
        </div>
        <button class="speed-outline-button speed-refresh-button" type="button" id="speed-refresh-domains">
          <span>${icon("refresh")}</span>
          刷新
        </button>
      </div>
      <div class="speed-domains-card-body">
        ${renderSpeedDomainsBody()}
        <div class="speed-domains-footer">
          <button class="speed-outline-button speed-close-domains" type="button" id="speed-close-domains-footer">关闭</button>
        </div>
      </div>
    </article>
  `;
}

function renderSpeedDeleteDialog() {
  if (!state.speedDomainDeleteId) {
    return "";
  }

  const domain = state.speedAcceleratedDomains.find(
    (item) => String(item.id || speedDomainName(item)) === String(state.speedDomainDeleteId)
  );
  const domainName = speedDomainName(domain || {});

  return `
    <div class="speed-dialog-backdrop speed-nested-dialog-backdrop" role="presentation">
      <section class="speed-dialog speed-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="speed-delete-title">
        <div class="speed-dialog-heading">
          <h2 id="speed-delete-title">确认删除</h2>
          <p>
            确定要删除加速域名 <strong>${escapeHtml(domainName || "-")}</strong> 吗？<br>
            此操作会删除面板管理的访问域名 CNAME 和 SaaS 自定义主机名。
          </p>
        </div>
        <div class="speed-delete-actions">
          <button class="speed-outline-button" type="button" id="speed-cancel-delete-domain">取消</button>
          <button class="speed-danger-button" type="button" id="speed-confirm-delete-domain">确认删除</button>
        </div>
      </section>
    </div>
  `;
}

function renderSpeedDomainsDialog() {
  if (!state.speedDomainsOpen) {
    return "";
  }

  return `
    <div class="speed-dialog-backdrop" role="presentation">
      <section class="speed-dialog speed-domains-dialog" role="dialog" aria-modal="true" aria-labelledby="speed-domains-title">
        <div class="speed-domains-modal-header">
          <h2 id="speed-domains-title">已加速的域名管理</h2>
          <button class="speed-dialog-close speed-close-domains" type="button" aria-label="关闭">
            ${icon("x")}
          </button>
        </div>
        ${renderSpeedDomainsCard()}
      </section>
      ${renderSpeedDeleteDialog()}
    </div>
  `;
}

function renderSpeedUsageGuide() {
  const items = [
    {
      title: "加速自己的网站",
      text:
        '假如你的服务器ip是1.1.1.1，你希望用www.xx.com访问你的网站并加速，那么需要先删除www.xx.com的A纪录，然后用其它域名指向该服务器，比如给jiasu.xx.com添加A纪录1.1.1.1，然后再将jiasu.xx.com填写在"源站域名"，将www.xx.com填写在"访问域名"，这样你的www.xx.com就被加速了。',
    },
    {
      title: "加速别人的网站",
      text:
        '比如www.cc.com这个网站大陆访问不了或者说访问很慢，你就把www.cc.com填写在"源站域名"处，然后在访问域名填写任意你自己的域名，比如cc.xx.com(无须在DNS处创建)，填写在访问域名，这样你就能够通过cc.xx.com访问被墙或者速度很慢的www.cc.com',
    },
    {
      title: "缓存使用说明",
      text:
        '网站主要是"静态内容为主"，比如企业官网、博客建议开启缓存，网站加载更快、能节省服务器带宽、抵御流量攻击。缓存时间可根据你的需要填写。如果网站内容是实时变化的，论坛、电商、聊天系统、动态数据页面，缓存时间保持默认"0"，否则缓存后容易出现内容错乱、旧数据或隐私泄露。',
    },
  ];

  return `
    <section class="speed-guide-card" aria-labelledby="speed-guide-title">
      <h2 id="speed-guide-title">
        <span>${icon("shield")}</span>
        使用前必看
      </h2>
      <div class="speed-guide-grid">
        ${items
          .map(
            (item, index) => `
              <article class="speed-guide-item">
                <h3>
                  <span>${index + 1}</span>
                  ${escapeHtml(item.title)}
                </h3>
                <p>${escapeHtml(item.text)}</p>
              </article>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

export function renderSpeedView() {
  renderShell(`
    <section class="content speed-content">
      <div class="speed-shell">
        <div class="speed-toolbar">
          <button class="speed-outline-button speed-toolbar-button" type="button" id="speed-open-domains">
            <span>${icon("grid")}</span>
            查看已加速的域名
          </button>
        </div>
        ${renderSpeedNotice()}
        ${renderSpeedStep()}
      </div>
      ${renderSpeedUsageGuide()}
      ${renderSpeedTasks()}
      ${renderSpeedDomainsDialog()}
    </section>
  `);
}
