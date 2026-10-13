import { HttpError } from "../lib/http-error.js";
import { readJsonBody } from "../lib/request-body.js";

export class CloudflareAccountsController {
  constructor({ cloudflareAccountService, credentialSessionService, panelAuthService, cloudflareClient }) {
    this.cloudflareAccountService = cloudflareAccountService;
    this.credentialSessionService = credentialSessionService;
    this.panelAuthService = panelAuthService;
    this.cloudflareClient = cloudflareClient;
  }

  requireSession(request) {
    const session = this.credentialSessionService.getCredentials(request);
    if (!session?.authenticated) throw new HttpError(401, "请先登录面板。");
    return session;
  }

  status(request) {
    const session = this.requireSession(request);
    const activeAccountId = this.cloudflareAccountService.resolveSelectedAccountId(session.activeCloudflareAccountId);
    const activeCloudflareAccount = activeAccountId ? this.cloudflareAccountService.getSafeAccount(activeAccountId) : null;
    const setupState = this.panelAuthService.getSetupState();
    return {
      accounts: this.cloudflareAccountService.listSafe(activeAccountId),
      activeCloudflareAccount,
      authenticated: true,
      totpEnabled: this.panelAuthService.isTwoFactorEnabled(),
      csrfToken: session.csrfToken || "",
      email: activeCloudflareAccount?.email || "",
      expiresAt: session.expiresAt || "",
      hasCredentials: this.cloudflareAccountService.hasAccounts(),
      loginRequired: this.panelAuthService.isConfigured(),
      setupRequired: setupState.setupRequired,
      setupState,
      source: "cookie",
    };
  }

  detail = async ({ request, params = {} }) => {
    this.requireSession(request);
    const account = this.cloudflareAccountService.getEditableAccount(params.accountId);
    if (!account) throw new HttpError(404, "Cloudflare 账号不存在。");
    return { statusCode: 200, body: { account } };
  };

  update = async ({ request, params = {} }) => {
    this.requireSession(request);
    const input = await readJsonBody(request);
    const account = this.cloudflareAccountService.updateAccount(params.accountId, input, {
      authorize: () => this.requireSession(request),
    });
    return { statusCode: 200, body: { ...this.status(request), account } };
  };

  delete = async ({ request, params = {} }) => {
    this.requireSession(request);
    this.cloudflareAccountService.deleteAccount(params.accountId, {
      authorize: () => this.requireSession(request),
      onDeleted: () => {
        const session = this.requireSession(request);
        const activeCloudflareAccountId = this.cloudflareAccountService.resolveSelectedAccountId(session.activeCloudflareAccountId);
        if (!this.credentialSessionService.update(request, { activeCloudflareAccountId })) {
          throw new HttpError(401, "请先登录面板。");
        }
      },
    });
    return { statusCode: 200, body: this.status(request) };
  };

  test = async ({ request, params = {} }) => {
    this.requireSession(request);
    const input = await readJsonBody(request);
    this.requireSession(request);
    const candidate = this.cloudflareAccountService.prepareUpdate(params.accountId, input);
    let result;
    try {
      result = await this.cloudflareClient.withCredentials(
        { email: candidate.email, globalApiKey: candidate.globalApiKey },
        () => this.cloudflareClient.get("zones", { per_page: 1 })
      );
    } catch (error) {
      this.requireSession(request);
      // Upstream responses can contain submitted credentials. Return only fixed, safe descriptions.
      const code = Number(error?.statusCode);
      const statusCode = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 502;
      const messages = {
        400: "Cloudflare 拒绝了连接测试，请检查登录邮箱和 Global API Key。",
        401: "Cloudflare 身份验证失败，请检查登录邮箱和 Global API Key。",
        403: "Cloudflare 拒绝访问，请检查 Global API Key 和账号权限。",
        429: "Cloudflare 请求过于频繁，请稍后重试。",
        504: "Cloudflare 连接测试超时，请稍后重试。",
      };
      return { statusCode, body: { ok: false, error: messages[statusCode] || "无法完成 Cloudflare 连接测试，请检查凭据或稍后重试。" } };
    }
    this.requireSession(request);
    const total = Number(result?.result_info?.total_count);
    const zoneCount = Number.isSafeInteger(total) && total >= 0 ? total : Array.isArray(result?.result) ? result.result.length : 0;
    return { statusCode: 200, body: { ok: true, message: "连接正常，Cloudflare 账号凭据验证通过。", zoneCount } };
  };
}
