import { createZone, fetchZones } from "../api.js";
import { routeToZone, updateRoute } from "../router.js";
import { state } from "../state.js";
import { beginScopedRequest, captureRequestContext } from "../request-scope.js";

export function createDomainActions({ loadZoneSectionData, renderApp, showNotice }) {
  async function loadZones({ throwOnError = false } = {}) {
    const request = beginScopedRequest("zones", () => "", { navigation: false });
    state.loadingZones = true;
    state.zoneError = "";
    renderApp();

    try {
      const zones = await fetchZones({ signal: request.signal });
      if (!request.isCurrent()) return;
      state.zones = zones;
      updateRoute();

      if (state.view === "zone") {
        state.selectedZone =
          state.zones.find((zone) => zone.id === state.selectedZone?.id) || state.selectedZone;

        await loadZoneSectionData();
      }
    } catch (error) {
      if (!request.isCurrent()) return;
      state.zoneError = error.message;

      if (throwOnError) {
        throw error;
      }
    } finally {
      if (request.isCurrent()) {
        state.loadingZones = false;
        renderApp();
      }
    }
  }

  async function addDomain(event) {
    event.preventDefault();
    const input = document.querySelector("#domain-input");
    const domain = input.value.trim().toLowerCase();
    state.domainDraft = domain;

    if (!domain) {
      showNotice("请输入要添加的域名");
      return;
    }
    const request = captureRequestContext(() => `${state.mainSection}:${state.view}`);

    state.addingDomain = true;
    state.notice = "";
    renderApp();

    try {
      const zone = await createZone({
        name: domain,
        type: "full",
        jumpStart: false,
      });
      if (!request.isCurrent()) return;
      state.domainDraft = "";
      state.notice = `${zone.name || domain} 已提交到 Cloudflare`;
      await loadZones({ throwOnError: false });
    } catch (error) {
      if (!request.isCurrent()) return;
      state.notice = error.message;
    } finally {
      if (request.isCurrent()) {
        state.addingDomain = false;
        renderApp();
      }
    }
  }

  function openMainSection(section) {
    state.mainSection = section || "domain";
    state.view = "domains";
    state.selectedZone = null;

    if (location.hash) {
      history.replaceState(null, "", location.pathname);
    }

    renderApp();
  }

  function openZone(zoneId) {
    const zone = state.zones.find((item) => item.id === zoneId);

    if (zone) {
      routeToZone(zone);
    }
  }

  async function copyToClipboard(event, value) {
    event.stopPropagation();
    await navigator.clipboard.writeText(value);
    showNotice("已复制到剪贴板");
  }

  return {
    addDomain,
    copyToClipboard,
    loadZones,
    openMainSection,
    openZone,
  };
}
