import { readCloudflareList } from "./cloudflare-list-reader.js";
import { HttpError } from "../../lib/http-error.js";
import { assertCloudflareId } from "./cloudflare-id.js";
import {
  automationFirewallDefinitionsByKey,
  automationPageRuleDefinitionsByKey,
  automationPresetDefinitions,
  automationSettingDefinitions,
  automationSettingsById,
  automationSettingsByKey,
} from "./automation-definitions.js";

const proxiableRecordTypes = new Set(["A", "AAAA", "CNAME"]);

function normalizeZone(zone = {}) {
  return {
    id: zone.id || "",
    name: zone.name || "",
  };
}

function normalizeSetting(setting, definition) {
  const value = setting?.value ?? definition.fallback;

  return {
    id: definition.id,
    key: definition.key,
    value: definition.fromApi ? definition.fromApi(value) : value,
    editable: setting?.editable !== false,
    modifiedOn: setting?.modified_on || null,
  };
}

function fallbackSetting(definition) {
  return {
    id: definition.id,
    key: definition.key,
    value: definition.fallback,
    editable: false,
    modifiedOn: null,
  };
}

function apiValueForDefinition(definition, value) {
  const apiValue = definition.toApi ? definition.toApi(value) : value;

  if (definition.validate) {
    if (!definition.validate(value)) {
      throw new HttpError(400, `${definition.key} 设置值无效`);
    }

    return apiValue;
  }

  if (!definition.values?.has(apiValue)) {
    throw new HttpError(400, `${definition.key} 设置值无效`);
  }

  return apiValue;
}

function normalizePatchInput(input = {}) {
  const updates = [];

  for (const [key, value] of Object.entries(input)) {
    const definition = automationSettingsByKey.get(key);

    if (!definition) {
      continue;
    }

    updates.push({
      definition,
      value: apiValueForDefinition(definition, value),
    });
  }

  if (updates.length === 0) {
    throw new HttpError(400, "没有可保存的自动优化设置");
  }

  return updates;
}

function settingIdsForUpdate(updates) {
  return new Set(updates.map(({ definition }) => definition.id));
}

function makeFirewallPayload(definition, enabled) {
  return {
    action: "block",
    description: definition.description,
    filter: {
      description: definition.description,
      expression: definition.expression,
      paused: !enabled,
    },
    paused: !enabled,
  };
}

function isFirewallRuleEnabled(rule) {
  return Boolean(rule) && rule.paused !== true;
}

function findAutomationFirewallRule(rules, definition) {
  return (
    rules.find((rule) => rule.description === definition.description) ||
    rules.find((rule) => rule.filterDescription === definition.description) ||
    rules.find((rule) => rule.expression === definition.expression) ||
    null
  );
}

function pageRuleHasCacheEverything(rule) {
  return Array.isArray(rule.actions)
    ? rule.actions.some((action) => action.id === "cache_level" && action.value === "cache_everything")
    : rule.cacheLevel === "cache_everything";
}

function findAutomationPageRule(rules, pattern) {
  return rules.find((rule) => rule.urlPattern === pattern && pageRuleHasCacheEverything(rule)) || null;
}

function isPageRuleEnabled(rule) {
  return Boolean(rule) && rule.status === "active";
}

function makePageRulePayload(pattern, status = "active") {
  return {
    targets: [
      {
        target: "url",
        constraint: {
          operator: "matches",
          value: pattern,
        },
      },
    ],
    actions: [{ id: "cache_level", value: "cache_everything" }],
    status,
  };
}

function copyRecordForProxy(record, proxied) {
  const payload = {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl || 1,
    proxied,
  };

  for (const key of ["priority", "data", "comment", "tags", "settings"]) {
    if (record[key] !== undefined && record[key] !== null) {
      payload[key] = record[key];
    }
  }

  return payload;
}

function readCloudflareErrorMessage(error) {
  return error?.message || "Cloudflare API 请求失败";
}

export class AutomationService {
  constructor({ cloudflareClient, dnsRecordsService, perPage = 100 }) {
    this.cloudflareClient = cloudflareClient;
    this.dnsRecordsService = dnsRecordsService;
    this.perPage = perPage;
  }

  async getState(zoneId) {
    assertCloudflareId(zoneId, "区域 ID");
    const zone = await this.getZone(zoneId);
    const settingsResult = await this.readSettings(zoneId);
    const dnsResult = await this.readDnsProxyState(zoneId);
    const firewallResult = await this.readFirewallState(zoneId);
    const pageRulesResult = await this.readPageRulesState(zoneId, zone);
    const tieredResult = await this.readTieredCaching(zoneId);

    const warnings = [
      ...settingsResult.warnings,
      ...dnsResult.warnings,
      ...firewallResult.warnings,
      ...pageRulesResult.warnings,
      ...tieredResult.warnings,
    ];

    return {
      zone,
      settings: settingsResult.settings,
      dnsProxy: dnsResult.dnsProxy,
      firewall: firewallResult.firewall,
      pageRules: this.withPageRulePatterns(pageRulesResult.pageRules, zone.name),
      tieredCaching: tieredResult.tieredCaching,
      warnings,
    };
  }

  async updateSettings(zoneId, input) {
    assertCloudflareId(zoneId, "区域 ID");
    const updates = normalizePatchInput(input);
    const applied = [];
    const warnings = await this.applySettingUpdates(zoneId, updates, { applied });

    if (warnings.length === updates.length) {
      throw new HttpError(502, warnings[0]);
    }

    const state = await this.getState(zoneId);

    return {
      ...state,
      applied,
      warnings: [...warnings, ...state.warnings],
    };
  }

  async updateDnsProxy(zoneId, input = {}) {
    assertCloudflareId(zoneId, "区域 ID");

    if (typeof input.enabled !== "boolean") {
      throw new HttpError(400, "DNS 代理开关值无效");
    }

    const records = await this.listRawDnsRecords(zoneId);
    const candidates = records.filter((record) => {
      const type = String(record.type || "").toUpperCase();
      return proxiableRecordTypes.has(type) && record.proxiable !== false;
    });
    const targets = candidates.filter((record) => Boolean(record.proxied) !== input.enabled);
    const warnings = [];

    for (const record of targets) {
      try {
        await this.cloudflareClient.patch(
          `zones/${zoneId}/dns_records/${record.id}`,
          copyRecordForProxy(record, input.enabled)
        );
      } catch (error) {
        warnings.push(`${record.name}: ${readCloudflareErrorMessage(error)}`);
      }
    }

    if (warnings.length === targets.length && targets.length > 0) {
      throw new HttpError(502, warnings[0]);
    }

    const state = await this.getState(zoneId);

    return {
      ...state,
      applied: [
        {
          id: "proxy_dns_records",
          value: input.enabled,
          count: targets.length - warnings.length,
        },
      ],
      warnings: [...warnings, ...state.warnings],
    };
  }

  async updateFirewallToggle(zoneId, key, input = {}) {
    assertCloudflareId(zoneId, "区域 ID");

    const definition = automationFirewallDefinitionsByKey.get(key);

    if (!definition) {
      throw new HttpError(404, "自动优化防火墙规则不存在");
    }

    if (typeof input.enabled !== "boolean") {
      throw new HttpError(400, "防火墙规则开关值无效");
    }

    const rules = await this.listFirewallRules(zoneId);
    const rule = findAutomationFirewallRule(rules, definition);

    if (rule) {
      await this.cloudflareClient.patch(
        `zones/${zoneId}/firewall/rules/${rule.id}`,
        makeFirewallPayload(definition, input.enabled)
      );
    } else if (input.enabled) {
      await this.cloudflareClient.post(
        `zones/${zoneId}/firewall/rules`,
        makeFirewallPayload(definition, true)
      );
    }

    return this.getState(zoneId);
  }

  async updatePageRuleToggle(zoneId, key, input = {}) {
    assertCloudflareId(zoneId, "区域 ID");
    const definition = automationPageRuleDefinitionsByKey.get(key);

    if (!definition) {
      throw new HttpError(404, "自动优化页面规则不存在");
    }

    if (typeof input.enabled !== "boolean") {
      throw new HttpError(400, "页面规则开关值无效");
    }

    const zone = await this.getZone(zoneId);
    const pattern = definition.pattern(zone.name);

    if (!pattern) {
      throw new HttpError(400, "当前域名缺少页面规则匹配信息");
    }

    const rules = await this.listPageRules(zoneId);
    const rule = findAutomationPageRule(rules, pattern);

    if (rule) {
      await this.cloudflareClient.patch(
        `zones/${zoneId}/pagerules/${rule.id}`,
        makePageRulePayload(pattern, input.enabled ? "active" : "disabled")
      );
    } else if (input.enabled) {
      await this.cloudflareClient.post(
        `zones/${zoneId}/pagerules`,
        makePageRulePayload(pattern, "active")
      );
    }

    return this.getState(zoneId);
  }

  async updateTieredCaching(zoneId, input = {}) {
    assertCloudflareId(zoneId, "区域 ID");

    if (typeof input.enabled !== "boolean") {
      throw new HttpError(400, "分层缓存开关值无效");
    }

    await this.cloudflareClient.patch(`zones/${zoneId}/cache/tiered_cache_smart_topology_enable`, {
      value: input.enabled ? "on" : "off",
    });

    return this.getState(zoneId);
  }

  async applyPreset(zoneId, input = {}) {
    assertCloudflareId(zoneId, "区域 ID");
    const presetKey = String(input.preset || "").trim();
    const preset = automationPresetDefinitions[presetKey];

    if (!preset) {
      throw new HttpError(400, "请选择优化方向");
    }

    const updates = Object.entries(preset.settings).map(([settingId, value]) => {
      const definition = automationSettingsById.get(settingId);

      if (!definition) {
        throw new HttpError(500, `自动优化预设包含未知设置 ${settingId}`);
      }

      return { definition, value };
    });
    const applied = [];
    const warnings = await this.applySettingUpdates(zoneId, updates, { applied });
    const state = await this.getState(zoneId);

    return {
      ...state,
      preset: preset.key,
      applied,
      warnings: [...warnings, ...state.warnings],
    };
  }

  async getZone(zoneId) {
    const payload = await this.cloudflareClient.get(`zones/${zoneId}`);
    return normalizeZone(payload.result || {});
  }

  async readSettings(zoneId, onlySettingIds = null) {
    const definitions = onlySettingIds
      ? automationSettingDefinitions.filter((definition) => onlySettingIds.has(definition.id))
      : automationSettingDefinitions;

    const results = await Promise.allSettled(
      definitions.map((definition) =>
        this.cloudflareClient.get(`zones/${zoneId}/settings/${definition.id}`)
      )
    );
    const rejectedResults = results.filter((result) => result.status === "rejected");

    if (rejectedResults.length === results.length) {
      throw rejectedResults[0].reason;
    }

    const settings = {};
    const warnings = [];

    results.forEach((result, index) => {
      const definition = definitions[index];

      if (result.status === "fulfilled") {
        settings[definition.key] = normalizeSetting(result.value.result, definition);
        return;
      }

      warnings.push(`${definition.id}: ${readCloudflareErrorMessage(result.reason)}`);
      settings[definition.key] = fallbackSetting(definition);
    });

    return { settings, warnings };
  }

  async applySettingUpdates(zoneId, updates, { applied = [] } = {}) {
    const warnings = [];

    for (const { definition, value } of updates) {
      try {
        await this.cloudflareClient.patch(`zones/${zoneId}/settings/${definition.id}`, {
          value,
        });
        applied.push({ id: definition.id, key: definition.key, value });
      } catch (error) {
        warnings.push(`${definition.id}: ${readCloudflareErrorMessage(error)}`);
      }
    }

    return warnings;
  }

  async readDnsProxyState(zoneId) {
    try {
      const records = await this.listRawDnsRecords(zoneId);
      const proxiable = records.filter((record) => {
        const type = String(record.type || "").toUpperCase();
        return proxiableRecordTypes.has(type) && record.proxiable !== false;
      });
      const proxiedCount = proxiable.filter((record) => Boolean(record.proxied)).length;

      return {
        dnsProxy: {
          enabled: proxiable.length > 0 && proxiedCount === proxiable.length,
          proxiableCount: proxiable.length,
          proxiedCount,
        },
        warnings: [],
      };
    } catch (error) {
      return {
        dnsProxy: {
          enabled: false,
          proxiableCount: 0,
          proxiedCount: 0,
        },
        warnings: [`dns_records: ${readCloudflareErrorMessage(error)}`],
      };
    }
  }

  async readFirewallState(zoneId) {
    try {
      const rules = await this.listFirewallRules(zoneId);
      const firewall = {};

      for (const definition of automationFirewallDefinitionsByKey.values()) {
        const rule = findAutomationFirewallRule(rules, definition);
        firewall[definition.key] = {
          enabled: isFirewallRuleEnabled(rule),
          ruleId: rule?.id || "",
          expression: definition.expression,
          description: definition.description,
        };
      }

      return { firewall, warnings: [] };
    } catch (error) {
      const firewall = {};

      for (const definition of automationFirewallDefinitionsByKey.values()) {
        firewall[definition.key] = {
          enabled: false,
          ruleId: "",
          expression: definition.expression,
          description: definition.description,
        };
      }

      return {
        firewall,
        warnings: [`firewall_rules: ${readCloudflareErrorMessage(error)}`],
      };
    }
  }

  async readPageRulesState(zoneId, zone = null) {
    try {
      const zoneContext = zone || (await this.getZone(zoneId));
      const rules = await this.listPageRules(zoneId);
      const pageRules = {};

      for (const definition of automationPageRuleDefinitionsByKey.values()) {
        const pattern = definition.pattern(zoneContext.name);
        const rule = pattern ? findAutomationPageRule(rules, pattern) : null;

        pageRules[definition.key] = {
          enabled: isPageRuleEnabled(rule),
          ruleId: rule?.id || "",
          pattern,
        };
      }

      return { pageRules, warnings: [] };
    } catch (error) {
      const pageRules = {};

      for (const definition of automationPageRuleDefinitionsByKey.values()) {
        pageRules[definition.key] = {
          enabled: false,
          ruleId: "",
          pattern: "",
        };
      }

      return {
        pageRules,
        warnings: [`page_rules: ${readCloudflareErrorMessage(error)}`],
      };
    }
  }

  withPageRulePatterns(pageRules, zoneName) {
    const nextPageRules = { ...pageRules };

    for (const definition of automationPageRuleDefinitionsByKey.values()) {
      nextPageRules[definition.key] = {
        ...nextPageRules[definition.key],
        pattern: definition.pattern(zoneName),
      };
    }

    return nextPageRules;
  }

  async readTieredCaching(zoneId) {
    try {
      const payload = await this.cloudflareClient.get(
        `zones/${zoneId}/cache/tiered_cache_smart_topology_enable`
      );
      const value = payload.result?.value;

      if (typeof value !== "string") {
        throw new HttpError(502, "Cloudflare 分层缓存返回格式异常");
      }

      return {
        tieredCaching: {
          supported: true,
          enabled: value === "on",
        },
        warnings: [],
      };
    } catch (error) {
      return {
        tieredCaching: {
          supported: false,
          enabled: false,
        },
        warnings: [`tiered_caching: ${readCloudflareErrorMessage(error)}`],
      };
    }
  }

  async listRawDnsRecords(zoneId) {
    return readCloudflareList({ client: this.cloudflareClient, path: `zones/${zoneId}/dns_records`,
      perPage: this.perPage, query: { order: "type", direction: "asc" }, errorMessage: "Cloudflare DNS 记录读取失败" });
  }

  async listFirewallRules(zoneId) {
    const rules = [];
    let page = 1;
    let totalPages = 1;

    do {
      const payload = await this.cloudflareClient.get(`zones/${zoneId}/firewall/rules`, {
        page,
        per_page: 50,
      });

      if (!Array.isArray(payload.result)) {
        throw new HttpError(502, "Cloudflare 防火墙规则返回格式异常，请稍后重试。");
      }

      rules.push(
        ...payload.result.map((rule) => ({
          id: rule.id || "",
          action: rule.action || "block",
          description: rule.description || rule.filter?.description || "",
          filterDescription: rule.filter?.description || "",
          expression: rule.filter?.expression || rule.expression || "",
          paused: Boolean(rule.paused || rule.filter?.paused),
        }))
      );

      const totalCount = Number(payload.result_info?.total_count);
      totalPages = Number.isFinite(totalCount)
        ? Math.max(1, Math.ceil(totalCount / 50))
        : page;
      page += 1;
    } while (page <= totalPages);

    return rules;
  }

  async listPageRules(zoneId) {
    const rules = [];
    let page = 1;
    let totalPages = 1;

    do {
      const payload = await this.cloudflareClient.get(`zones/${zoneId}/pagerules`, {
        page,
        per_page: 50,
      });

      if (!Array.isArray(payload.result)) {
        throw new HttpError(502, "Cloudflare 页面规则返回格式异常，请稍后重试。");
      }

      rules.push(
        ...payload.result.map((rule) => {
          const targets = Array.isArray(rule.targets) ? rule.targets : [];
          const actions = Array.isArray(rule.actions) ? rule.actions : [];

          return {
            id: rule.id || "",
            urlPattern:
              targets.find((target) => target.target === "url")?.constraint?.value || "",
            status: rule.status || "disabled",
            targets,
            actions,
            cacheLevel:
              actions.find((action) => action.id === "cache_level")?.value || "",
          };
        })
      );

      const pageCount = Number(payload.result_info?.total_pages);
      const totalCount = Number(payload.result_info?.total_count);
      totalPages = Number.isFinite(pageCount)
        ? Math.max(1, pageCount)
        : Number.isFinite(totalCount)
          ? Math.max(1, Math.ceil(totalCount / 50))
          : page;
      page += 1;
    } while (page <= totalPages);

    return rules;
  }
}
