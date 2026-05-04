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
  lastSent = /* @__PURE__ */ new Map();
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
    await this.adapter.subscribeForeignObjectsAsync(`residents.${this.instance}.*.*`);
    this.adapter.log.info(`[residents] Subscribed: ${pattern}`);
    await this._sendSnapshot();
    this.adapter.log.info(`[residents] sent snapshot`);
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
    const key = `${residentType}/${residentId}`;
    if (this.lastSent.get(key) === presenceState) {
      return;
    }
    this.lastSent.set(key, presenceState);
    this.send({
      resident_update: {
        roomie_id: residentId,
        presence_state: presenceState,
        is_guest: residentType === "guest"
      }
    });
    this.adapter.log.info(`[residents] ${key} \u2192 presence_state=${presenceState}`);
  }
  /**
   * Call from onForeignObjectChange when a residents object changes.
   *
   * @param id - State ID that changed
   */
  onObjectChange(id) {
    const parts = id.split(".");
    if (parts.length !== 4) {
      return;
    }
    if (id.startsWith(`residents.${this.instance}.roomie.`) || id.startsWith(`residents.${this.instance}.guest.`)) {
      this.adapter.log.info(`[residents] Resident added/removed: ${id} \u2014 sending updated snapshot`);
      void this._sendSnapshot();
    }
  }
  _getObjectName(obj, fallback) {
    var _a, _b, _c, _d;
    const name = (_a = obj.common) == null ? void 0 : _a.name;
    if (typeof name === "string") {
      return name;
    }
    if (name && typeof name === "object") {
      return (_d = (_c = (_b = name.de) != null ? _b : name.en) != null ? _c : Object.values(name)[0]) != null ? _d : fallback;
    }
    return fallback;
  }
  /**
   * resident state changes from Hannah Core (via set_resident command) are handled here.
   *
   * @param residentId - ID of the resident (e.g. "john_doe")
   * @param value - JSON-encoded value to set (e.g. {"presence_state": 1, "is_guest": false})
   */
  /**
   * Hannah instructs the adapter to set a resident's presence state.
   * is_guest determines the path: .roomie. for roomies, .guest. for guests.
   *
   * @param residentId - Resident ID (e.g. "leonie", "hannah")
   * @param presenceState - Presence value from the residents adapter
   * @param isGuest - True for guests, false for roomies
   */
  async handleSetResident(residentId, presenceState, isGuest) {
    const type = isGuest ? "guest" : "roomie";
    const stateId = `residents.${this.instance}.${type}.${residentId}.presence.state`;
    try {
      await this.adapter.setForeignStateAsync(stateId, { val: presenceState, ack: false });
      this.adapter.log.debug(`[residents] SetResident ${type}/${residentId} \u2192 ${presenceState}`);
    } catch (e) {
      this.adapter.log.error(`[residents] SetResident failed for ${stateId}: ${e.message}`);
    }
  }
  async _sendSnapshot() {
    const patterns = [`residents.${this.instance}.roomie.*`, `residents.${this.instance}.guest.*`];
    const residents = [];
    let sent = 0;
    for (const pattern of patterns) {
      const objects = await this.adapter.getForeignObjectsAsync(pattern, "device");
      for (const [id, obj] of Object.entries(objects)) {
        const parts = id.split(".");
        if (parts.length !== 4) {
          continue;
        }
        residents.push({
          name: this._getObjectName(obj, parts[3]),
          roomie_id: parts[3],
          is_guest: parts[2] == "roomie" ? false : true
        });
        sent++;
      }
    }
    this.send({
      send_residents: {
        residents
      }
    });
    this.adapter.log.info(`[residents] Snapshot: ${sent} current device states sent.`);
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
