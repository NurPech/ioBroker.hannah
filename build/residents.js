"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var residents_exports = {};
__export(residents_exports, {
  ResidentsWatcher: () => ResidentsWatcher
});
module.exports = __toCommonJS(residents_exports);
class ResidentsWatcher {
  adapter;
  send;
  instance;
  /**
   * @param adapter - ioBroker adapter instance
   * @param send - Function to send messages to Hannah Core
   * @param instance - Residents adapter instance number (e.g. "0")
   */
  constructor(adapter, send, instance) {
    this.adapter = adapter;
    this.send = send;
    this.instance = instance;
  }
  /** Subscribe to all presence states under residents.<instance>.*.*.presence.state */
  async subscribe() {
    const pattern = `residents.${this.instance}.*.*.presence.state`;
    await this.adapter.subscribeForeignStatesAsync(pattern);
    this.adapter.log.info(`[residents] Subscribed: ${pattern}`);
  }
  /**
   * Call from onForeignStateChange when a residents state changes.
   *
   * @param id - State ID that changed
   * @param state - New state value, or null/undefined if deleted
   */
  onStateChange(id, state) {
    if (!state || state.val === null) {
      return;
    }
    const match = id.match(/\.(roomie|guest)\.([^.]+)\.presence\.state$/);
    if (!match) {
      return;
    }
    const residentType = match[1];
    const residentId = match[2];
    const presenceState = typeof state.val === "number" ? state.val : parseInt(String(state.val), 10) || 0;
    this.send({
      resident_update: {
        roomie_id: residentId,
        presence_state: presenceState,
        is_guest: residentType === "guest"
      }
    });
    this.adapter.log.debug(`[residents] ${residentType}/${residentId} \u2192 presence_state=${presenceState}`);
  }
  /** Unsubscribe from all presence states. */
  async unsubscribe() {
    const pattern = `residents.${this.instance}.*.*.presence.state`;
    await this.adapter.unsubscribeForeignStatesAsync(pattern);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ResidentsWatcher
});
//# sourceMappingURL=residents.js.map
