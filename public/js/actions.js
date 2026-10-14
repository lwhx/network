import { createLoginSettingsActions } from "./actions/login-settings-actions.js";
import { createAccountManagementActions } from "./actions/account-management-actions.js";
import { createAnalyticsActions } from "./actions/analytics-actions.js";
import { createAutomationActions } from "./actions/automation-actions.js";
import { createDeveloperResourcesActions } from "./actions/developer-resources-actions.js";
import { createDnsActions } from "./actions/dns-actions.js";
import { createDomainActions } from "./actions/domain-actions.js";
import { createHistoryActions } from "./actions/history-actions.js";
import { createNoticeActions } from "./actions/notice-actions.js";
import { createSessionActions } from "./actions/session-actions.js";
import { createSpeedActions } from "./actions/speed-actions.js";
import { createSpeedTasksActions } from "./actions/speed-tasks-actions.js";
import { createWorkersActions } from "./actions/workers-actions.js";
import { createZoneSettingsActions } from "./actions/zone-settings-actions.js";
import { backToDomains, routeToZoneSection, updateRoute } from "./router.js";
import { resetDnsForm, resetFirewallForm, resetPageRuleForm, resetPendingResourceState, state } from "./state.js";
import { invalidateReadRequests } from "./request-scope.js";

export function createActions({ renderApp }) {
  const noticeActions = createNoticeActions({ renderApp });
  const analyticsActions = createAnalyticsActions({ renderApp });
  const automationActions = createAutomationActions({ renderApp });
  const developerResourcesActions = createDeveloperResourcesActions({ renderApp });
  const dnsActions = createDnsActions({ renderApp });
  const historyActions = createHistoryActions({ renderApp });
  const speedTasksActions = createSpeedTasksActions({ renderApp });
  const speedActions = createSpeedActions({ renderApp, onTaskChange: speedTasksActions.ensureSpeedTasksLoaded });
  const workersActions = createWorkersActions({ renderApp });
  const zoneSettingsActions = createZoneSettingsActions({ renderApp });

  async function loadActiveZoneData() {
    if (state.zoneSection === "analytics") {
      await analyticsActions.loadZoneAnalytics();
      return;
    }

    if (state.zoneSection === "dns") {
      await dnsActions.loadDnsRecords();
      return;
    }

    if (state.zoneSection === "cache") {
      await zoneSettingsActions.loadCacheSettings();
      return;
    }

    if (state.zoneSection === "ssl") {
      await zoneSettingsActions.loadSslSettings();
      return;
    }

    if (state.zoneSection === "firewall") {
      await zoneSettingsActions.loadFirewallRules();
      return;
    }

    if (state.zoneSection === "rules") {
      await zoneSettingsActions.loadPageRules();
      return;
    }

    if (state.zoneSection === "certificates") {
      await zoneSettingsActions.loadCertificates();
    }
  }

  const domainActions = createDomainActions({
    loadZoneSectionData: loadActiveZoneData,
    renderApp,
    showNotice: noticeActions.showNotice,
  });
  const sessionActions = createSessionActions({
    loadZones: domainActions.loadZones,
    renderApp,
  });

  async function handleRouteChange() {
    invalidateReadRequests({ navigationOnly: true });
    resetPendingResourceState();
    state.notice = "";
    state.dnsBulkResult = null;
    updateRoute();

    if (state.view === "zone") {
      resetDnsForm();
      resetFirewallForm();
      resetPageRuleForm();
      await loadActiveZoneData();
    }

    renderApp();

    await automationActions.ensureAutomationLoaded();
    await developerResourcesActions.ensureDeveloperResourcesLoaded();
    await historyActions.ensureOperationHistoryLoaded();
    await workersActions.ensureWorkersLoaded();
    await speedTasksActions.ensureSpeedTasksLoaded();
  }

  async function refreshZoneSettings() {
    await loadActiveZoneData();
  }

  async function openMainSection(section) {
    if (state.mainSection !== section || state.view === "zone") {
      invalidateReadRequests({ navigationOnly: true });
      resetPendingResourceState();
    }
    domainActions.openMainSection(section);
    await automationActions.ensureAutomationLoaded();
    await developerResourcesActions.ensureDeveloperResourcesLoaded();
    await historyActions.ensureOperationHistoryLoaded();
    await workersActions.ensureWorkersLoaded();
    await speedTasksActions.ensureSpeedTasksLoaded();
  }

  return {
    ...createAccountManagementActions({ renderApp, loadZones: domainActions.loadZones }),
    ...createLoginSettingsActions({ renderApp }),
    ...analyticsActions,
    ...automationActions,
    ...developerResourcesActions,
    ...domainActions,
    ...dnsActions,
    ...historyActions,
    ...sessionActions,
    ...speedActions,
    ...speedTasksActions,
    ...workersActions,
    ...zoneSettingsActions,
    backToDomains: () => {
      invalidateReadRequests({ navigationOnly: true });
      resetPendingResourceState();
      backToDomains();
    },
    handleRouteChange,
    openMainSection,
    openZoneSection: routeToZoneSection,
    refreshZoneSettings,
  };
}
