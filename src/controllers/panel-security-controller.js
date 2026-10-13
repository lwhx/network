import { readJsonBody } from "../lib/request-body.js";
import { createOtpAuthUrl, generateTotpSecret } from "../services/panel-auth-service.js";

export class PanelSecurityController {
  constructor({ credentialsController, panelAuthService, credentialSessionService }) {
    this.credentialsController = credentialsController;
    this.auth = panelAuthService;
    this.sessions = credentialSessionService;
  }

  secret = async ({ request }) => {
    if (!this.sessions.getCredentials(request)?.authenticated) {
      return { statusCode: 401, body: { error: "请先登录面板。" } };
    }
    const body = await readJsonBody(request);
    const limit = this.credentialsController.checkRateLimit(request, "security");
    if (!limit.allowed) return limit.response;
    if (!this.auth.verifyCurrent(body)) {
      return { statusCode: 401, body: { error: "当前密码或验证码错误。" } };
    }
    this.credentialsController.resetRateLimit(request, "security");
    const secret = generateTotpSecret();
    return { statusCode: 200, body: { secret, otpauthUrl: createOtpAuthUrl({ secret }) } };
  };

  update = async ({ request }) => {
    const current = this.sessions.getCredentials(request);
    if (!current?.authenticated) {
      return { statusCode: 401, body: { error: "请先登录面板。" } };
    }
    const body = await readJsonBody(request);
    const limit = this.credentialsController.checkRateLimit(request, "security");
    if (!limit.allowed) return limit.response;
    const result = this.auth.updateTwoFactor(body);
    if (result.error) return { statusCode: result.statusCode, body: { error: result.error } };
    this.credentialsController.resetRateLimit(request, "security");
    const session = this.sessions.create({ authenticated: true, source: "panel",
      activeCloudflareAccountId: current.activeCloudflareAccountId, remember: current.remember,
      authRevision: result.authRevision });
    return { statusCode: 200,
      headers: { "Set-Cookie": this.sessions.createCookie(request, session) },
      body: { authenticated: true, totpEnabled: result.totpEnabled,
        csrfToken: session.csrfToken, expiresAt: session.expiresAt } };
  };
}
