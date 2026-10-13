import { state } from "./state.js";
import { zoneSectionTitles } from "./constants.js";

const zoneRoutePattern = /^#\/zones\/([a-z0-9]{32})(?:\/([a-z-]+))?$/i;

export function updateRoute() {
  const match = location.hash.match(zoneRoutePattern);

  if (!match) {
    state.view = "domains";
    state.selectedZone = null;
    state.zoneSection = "dns";
    return;
  }

  const zoneId = match[1];
  const section = zoneSectionTitles[match[2]] ? match[2] : "dns";
  const zone = state.zones.find((item) => item.id === zoneId);
  state.view = "zone";
  state.mainSection = "domain";
  state.zoneSection = section;
  state.selectedZone = zone || (state.selectedZone?.id === zoneId ? state.selectedZone : null) || { id: zoneId, name: "Loading" };
}

export function routeToZone(zone, section = "dns") {
  state.selectedZone = zone;
  location.hash = `#/zones/${zone.id}/${section}`;
}

export function routeToZoneSection(section) {
  if (!state.selectedZone?.id || !zoneSectionTitles[section]) {
    return;
  }

  location.hash = `#/zones/${state.selectedZone.id}/${section}`;
}

export function backToDomains() {
  state.mainSection = "domain";
  location.hash = "";
}
