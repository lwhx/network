import { fetchZoneAnalytics } from "../api.js";
import { state } from "../state.js";
import { beginScopedRequest } from "../request-scope.js";

const rangeDays = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
};

function readSelectedZoneId() {
  return state.selectedZone?.id || "";
}

function readAnalyticsContext() {
  return JSON.stringify([state.view, state.mainSection, state.zoneSection,
    readSelectedZoneId(), state.analyticsRange, state.analyticsStartDate, state.analyticsEndDate]);
}

export function createAnalyticsActions({ renderApp }) {
  async function loadZoneAnalytics(range = state.analyticsRange || "7d") {
    const zoneId = readSelectedZoneId();

    if (!zoneId) {
      return;
    }

    state.analyticsRange = rangeDays[range] ? range : "7d";
    state.loadingAnalytics = true;
    state.analyticsError = "";
    state.analytics = null;
    renderApp();

    const requestScope = beginScopedRequest("analytics:loadZoneAnalytics", readAnalyticsContext);

    try {
      const payload = await fetchZoneAnalytics(zoneId, {
        days: rangeDays[state.analyticsRange],
        startDate: state.analyticsStartDate,
        endDate: state.analyticsEndDate,
      });
      if (!requestScope.isCurrent()) {
        return;
      }
      state.analytics = payload;
    } catch (error) {
      if (!requestScope.isCurrent()) {
        return;
      }
      state.analyticsError = error.message;
    } finally {
      if (requestScope.isCurrent()) {
        state.loadingAnalytics = false;
        renderApp();
      }
    }
  }

  async function changeAnalyticsRange(range) {
    state.analyticsStartDate = "";
    state.analyticsEndDate = "";
    await loadZoneAnalytics(range);
  }

  async function submitAnalyticsRange(event) {
    event.preventDefault();
    const form = document.querySelector("#analytics-range-form");
    const formData = form ? new FormData(form) : new FormData();
    state.analyticsRange = "custom";
    state.analyticsStartDate = String(formData.get("startDate") || "").trim();
    state.analyticsEndDate = String(formData.get("endDate") || "").trim();
    await loadZoneAnalytics("custom");
  }

  return {
    changeAnalyticsRange,
    loadZoneAnalytics,
    submitAnalyticsRange,
  };
}
