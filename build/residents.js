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
  constructor(adapter, send, instance) {
    this.adapter = adapter;
    this.send = send;
    this.instance = instance;
  }
  /** Subscribe to all presence states under residents.<instance>.roomie.*.presence.state */
  async subscribe() {
    const pattern = `residents.${this.instance}.roomie.*.presence.state`;
    await this.adapter.subscribeForeignStatesAsync(pattern);
    this.adapter.log.info(`[residents] Subscribed: ${pattern}`);
  }
  /**
   * Call from onForeignStateChange when a residents state changes.
   *
   * @param id
   * @param state
   */
  onStateChange(id, state) {
    if (!state || state.val === null) {
      return;
    }
    const match = id.match(/\.roomie\.([^.]+)\.presence\.state$/);
    if (!match) {
      return;
    }
    const roomieId = match[1];
    const presenceState = typeof state.val === "number" ? state.val : parseInt(String(state.val), 10) || 0;
    this.send({
      resident_update: {
        roomie_id: roomieId,
        presence_state: presenceState,
        is_guest: false
      }
    });
    this.adapter.log.debug(`[residents] ${roomieId} \u2192 presence_state=${presenceState}`);
  }
  async unsubscribe() {
    const pattern = `residents.${this.instance}.roomie.*.presence.state`;
    await this.adapter.unsubscribeForeignStatesAsync(pattern);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ResidentsWatcher
});
//# sourceMappingURL=residents.js.map
