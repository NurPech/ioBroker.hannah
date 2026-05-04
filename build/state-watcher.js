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
var state_watcher_exports = {};
__export(state_watcher_exports, {
  StateWatcher: () => StateWatcher
});
module.exports = __toCommonJS(state_watcher_exports);
class StateWatcher {
  adapter;
  send;
  subscribedIds = /* @__PURE__ */ new Set();
  wildcardPrefixes = /* @__PURE__ */ new Set();
  verifiedWildcardCache = /* @__PURE__ */ new Set();
  watchMoreIds = /* @__PURE__ */ new Set();
  floorMappings = [];
  /**
   * @param adapter - ioBroker adapter instance
   * @param send - Function to send messages to Hannah Core
   */
  constructor(adapter, send) {
    this.adapter = adapter;
    this.send = send;
  }
  get textCommandStateId() {
    return `${this.adapter.namespace}.textCommand`;
  }
  /**
   * Discover and subscribe to all relevant states.
   *
   * @param config - Subscription filter configuration
   * @param config.selectedRooms - Room enum IDs to include (empty = all)
   * @param config.selectedFunctions - Function enum IDs to include (empty = all)
   * @param config.extraStatePrefixes - Additional state ID prefixes to subscribe
   * @param config.floorMappings - Label→abbreviation pairs for floor detection (empty = hardcoded defaults)
   */
  async start(config) {
    this.subscribedIds.clear();
    this.wildcardPrefixes.clear();
    this.verifiedWildcardCache.clear();
    this.watchMoreIds.clear();
    this.floorMappings = config.floorMappings;
    await this._subscribeEnumStates(config.selectedRooms, config.selectedFunctions);
    await this._subscribeExtraPrefixes(config.extraStatePrefixes.map((p) => p.prefix));
    await this.adapter.subscribeStatesAsync("textCommand").catch((e) => {
      this.adapter.log.error(`[states] Failed to subscribe to textCommand state: ${e.message}`);
    });
    this.subscribedIds.add(this.textCommandStateId);
    this.adapter.log.info(`[states] ${this.subscribedIds.size} Patterns/States subscribed.`);
    await this._sendSnapshot();
  }
  /**
   * Subscribe additional state IDs on demand (from AgentWatchMore).
   *
   * @param stateIds - State IDs to subscribe
   */
  async watchMore(stateIds) {
    for (const id of stateIds) {
      if (this.watchMoreIds.has(id)) {
        continue;
      }
      await this.adapter.subscribeForeignStatesAsync(id);
      this.watchMoreIds.add(id);
      this.adapter.log.debug(`[states] WatchMore: ${id}`);
    }
  }
  /**
   * Call from onForeignStateChange. Returns true if the state was handled.
   *
   * @param id - State ID that changed
   * @param state - New state value, or null/undefined if deleted
   */
  onStateChange(id, state) {
    var _a, _b, _c;
    if (!state) {
      return false;
    }
    let isSubscribed = this.subscribedIds.has(id) || this.watchMoreIds.has(id) || this.verifiedWildcardCache.has(id);
    if (!isSubscribed) {
      for (const prefix of this.wildcardPrefixes) {
        if (id.startsWith(prefix)) {
          this.verifiedWildcardCache.add(id);
          isSubscribed = true;
          break;
        }
      }
    }
    if (!isSubscribed) {
      return false;
    }
    this.adapter.log.debug(`[states] StateChange: ${id} = ${JSON.stringify(state.val)} (ack=${state.ack})`);
    if (id === this.textCommandStateId && state.ack === false) {
      const text = String((_a = state.val) != null ? _a : "").trim();
      if (text) {
        this.send({ text_command: { text } });
        this.adapter.log.debug(`[states] TextCommand: ${text}`);
        this.adapter.setState(id, { val: "", ack: true }).catch((e) => {
          this.adapter.log.error(`[states] Failed to reset text command state: ${e.message}`);
        });
      }
      return true;
    }
    if (!state.ack) {
      return false;
    }
    this.send({
      state_update: {
        state_id: id,
        value: JSON.stringify(state.val),
        ack: (_b = state.ack) != null ? _b : false,
        ts: (_c = state.ts) != null ? _c : Date.now()
      }
    });
    return true;
  }
  /**
   * Hannah instructs the adapter to set a state in ioBroker.
   *
   * @param stateId - Target state ID
   * @param value - JSON-encoded value to set
   */
  async handleSetState(stateId, value) {
    if (!this._isManaged(stateId)) {
      this.adapter.log.warn(`[states] SetState rejected \u2014 not a managed state: ${stateId}`);
      return;
    }
    const state = await this.adapter.getForeignObjectAsync(stateId);
    if (!(state == null ? void 0 : state.common.write)) {
      return;
    }
    try {
      const parsed = JSON.parse(value);
      await this.adapter.setForeignStateAsync(stateId, { val: parsed, ack: false });
      this.adapter.log.debug(`[states] SetState ${stateId} = ${value}`);
    } catch (e) {
      this.adapter.log.error(`[states] SetState failed for ${stateId}: ${e.message}`);
    }
  }
  /**
   * Read and forward the current value of all subscribed states.
   * Replaces MQTT retained messages — called once after all subscriptions are set up.
   */
  async _sendSnapshot() {
    var _a;
    const devices = [];
    let sent = 0;
    const [allRooms, allFunctions] = await Promise.all([
      this.adapter.getEnumAsync("rooms"),
      this.adapter.getEnumAsync("functions")
    ]);
    for (const pattern of this.subscribedIds) {
      try {
        const states = await this.adapter.getForeignStatesAsync(pattern);
        for (const [id, state] of Object.entries(states)) {
          if (!state) {
            continue;
          }
          const meta = await this._resolveDeviceMeta(id, allRooms, allFunctions);
          devices.push({
            state_id: id,
            floor: meta.floor,
            room: meta.room,
            device: meta.device,
            functions: meta.functions,
            value: {
              value: JSON.stringify(state.val),
              ack: (_a = state.ack) != null ? _a : false
            }
          });
          sent++;
        }
      } catch (e) {
        this.adapter.log.warn(`[states] Snapshot failed for ${pattern}: ${e.message}`);
      }
    }
    this.send({ send_snapshot: { devices } });
    this.adapter.log.info(`[states] Snapshot: ${sent} current device states sent.`);
  }
  async _resolveDeviceMeta(stateId, allRooms, allFunctions) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l;
    const deviceId = stateId.split(".").slice(0, -1).join(".");
    const [stateObj, deviceObj] = await Promise.all([
      this.adapter.getForeignObjectAsync(stateId),
      this.adapter.getForeignObjectAsync(deviceId)
    ]);
    const rawFloorFromObj = typeof ((_a = deviceObj == null ? void 0 : deviceObj.common) == null ? void 0 : _a.floor) === "string" && deviceObj.common.floor ? deviceObj.common.floor : null;
    const knownFloors = /* @__PURE__ */ new Set(["EG", "OG", "UG", "DG", "KG", "ZG"]);
    const resolveFloor = (value) => {
      const upper = value.toUpperCase();
      const match = this.floorMappings.find(
        (m) => m.label.toUpperCase() === upper || m.abbreviation.toUpperCase() === upper
      );
      if (match) {
        return match.abbreviation;
      }
      if (knownFloors.has(upper)) {
        return upper;
      }
      return null;
    };
    const floorFromObj = rawFloorFromObj !== null ? (_b = resolveFloor(rawFloorFromObj)) != null ? _b : rawFloorFromObj : null;
    let floorFromId = "";
    for (const part of deviceId.split(".")) {
      const resolved = resolveFloor(part);
      if (resolved !== null) {
        floorFromId = resolved;
        break;
      }
    }
    const floor = floorFromObj != null ? floorFromObj : floorFromId;
    let roomObj = Object.values(allRooms.result).find(
      (obj) => {
        var _a2, _b2, _c2;
        return ((_a2 = obj == null ? void 0 : obj._id) == null ? void 0 : _a2.startsWith("enum.rooms.")) && ((_c2 = (_b2 = obj.common) == null ? void 0 : _b2.members) == null ? void 0 : _c2.includes(deviceId));
      }
    );
    if (roomObj == null) {
      const parentId = deviceId.split(".").slice(0, -1).join(".");
      roomObj = Object.values(allRooms.result).find(
        (obj) => {
          var _a2, _b2, _c2;
          return ((_a2 = obj == null ? void 0 : obj._id) == null ? void 0 : _a2.startsWith("enum.rooms.")) && ((_c2 = (_b2 = obj.common) == null ? void 0 : _b2.members) == null ? void 0 : _c2.includes(parentId));
        }
      );
    }
    const room = roomObj ? String((_g = (_f = (_d = (_c = roomObj.common) == null ? void 0 : _c.name) == null ? void 0 : _d.de) != null ? _f : (_e = roomObj.common) == null ? void 0 : _e.name) != null ? _g : roomObj._id) : void 0;
    const functions = Object.values(allFunctions.result).filter((obj) => {
      var _a2, _b2, _c2;
      return ((_a2 = obj == null ? void 0 : obj._id) == null ? void 0 : _a2.startsWith("enum.functions.")) && ((_c2 = (_b2 = obj.common) == null ? void 0 : _b2.members) == null ? void 0 : _c2.includes(stateId));
    }).map((obj) => {
      var _a2, _b2, _c2, _d2, _e2;
      return String((_e2 = (_d2 = (_b2 = (_a2 = obj.common) == null ? void 0 : _a2.name) == null ? void 0 : _b2.de) != null ? _d2 : (_c2 = obj.common) == null ? void 0 : _c2.name) != null ? _e2 : obj._id);
    });
    const readableName = (n) => {
      if (typeof n !== "string" || !n || n.includes(".")) {
        return null;
      }
      return n;
    };
    return {
      room: room != null ? room : "",
      device: (_l = (_k = (_j = readableName((_h = deviceObj == null ? void 0 : deviceObj.common) == null ? void 0 : _h.name)) != null ? _j : readableName((_i = stateObj == null ? void 0 : stateObj.common) == null ? void 0 : _i.name)) != null ? _k : deviceId.split(".").at(-1)) != null ? _l : "",
      floor,
      functions
    };
  }
  /**
   * Unsubscribe all states and clear the subscription set.
   */
  async stop() {
    for (const id of this.subscribedIds) {
      await this.adapter.unsubscribeForeignStatesAsync(id);
    }
    this.subscribedIds.clear();
    this.wildcardPrefixes.clear();
    this.verifiedWildcardCache.clear();
  }
  async _subscribeEnumStates(selectedRooms, selectedFunctions) {
    this.adapter.log.info("[states] Enum-Discovery: Loading rooms and functions...");
    let roomResult;
    let funcResult;
    try {
      [roomResult, funcResult] = await Promise.all([
        this.adapter.getObjectViewAsync("system", "enum", {
          startkey: "enum.rooms.",
          endkey: "enum.rooms.\u9999"
        }),
        this.adapter.getObjectViewAsync("system", "enum", {
          startkey: "enum.functions.",
          endkey: "enum.functions.\u9999"
        })
      ]);
    } catch (e) {
      this.adapter.log.error(`[states] getObjectViewAsync failed: ${e.message}`);
      return;
    }
    const roomDevices = this._extractViewMembers(roomResult.rows, selectedRooms);
    const funcStates = this._extractViewMembers(funcResult.rows, selectedFunctions);
    this.adapter.log.info(
      `[states] Enum-Discovery: ${roomResult.rows.length} room enums (${roomDevices.size} devices), ${funcResult.rows.length} function enums (${funcStates.size} states)`
    );
    const addWildcard = async (deviceId) => {
      const prefix = deviceId.endsWith(".") ? deviceId : `${deviceId}.`;
      const pattern = `${prefix}*`;
      if (!this.subscribedIds.has(pattern)) {
        await this.adapter.subscribeForeignStatesAsync(pattern);
        this.subscribedIds.add(pattern);
        this.wildcardPrefixes.add(prefix);
      }
    };
    const addSingleState = async (stateId) => {
      if (!this.subscribedIds.has(stateId)) {
        await this.adapter.subscribeForeignStatesAsync(stateId);
        this.subscribedIds.add(stateId);
      }
    };
    if (selectedRooms.length === 0 && selectedFunctions.length === 0) {
      for (const d of roomDevices) {
        await addWildcard(d);
      }
    } else if (selectedRooms.length === 0) {
      for (const s of funcStates) {
        await addSingleState(s);
      }
    } else if (selectedFunctions.length === 0) {
      for (const d of roomDevices) {
        await addWildcard(d);
      }
    } else {
      for (const s of funcStates) {
        if ([...roomDevices].some((d) => s.startsWith(`${d}.`))) {
          await addSingleState(s);
        }
      }
    }
    this.adapter.log.info(`[states] Enum-Discovery: ${this.subscribedIds.size} states subscribed.`);
  }
  _extractViewMembers(rows, selected) {
    var _a;
    const ids = /* @__PURE__ */ new Set();
    for (const row of rows) {
      if (!row.value || row.value.type !== "enum") {
        continue;
      }
      if (selected.length > 0 && !selected.includes(row.id)) {
        continue;
      }
      for (const memberId of (_a = row.value.common.members) != null ? _a : []) {
        ids.add(memberId);
      }
    }
    return ids;
  }
  async _subscribeExtraPrefixes(prefixes) {
    for (const prefix of prefixes) {
      if (!prefix) {
        continue;
      }
      const normalized = prefix.replace(/\//g, ".");
      const cleanPrefix = normalized.endsWith(".") ? normalized : `${normalized}.`;
      const pattern = `${cleanPrefix}*`;
      await this.adapter.subscribeForeignStatesAsync(pattern);
      this.subscribedIds.add(pattern);
      this.wildcardPrefixes.add(cleanPrefix);
      this.adapter.log.info(`[states] Extra-Prefix subscribed: ${pattern}`);
    }
  }
  _isManaged(id) {
    if (this.subscribedIds.has(id)) {
      return true;
    }
    if (this.verifiedWildcardCache.has(id)) {
      return true;
    }
    for (const prefix of this.wildcardPrefixes) {
      if (id.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  StateWatcher
});
//# sourceMappingURL=state-watcher.js.map
