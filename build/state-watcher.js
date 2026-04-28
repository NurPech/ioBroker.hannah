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
  textCommandStateId;
  residentsPrefix;
  wildcardPrefixes = /* @__PURE__ */ new Set();
  verifiedWildcardCache = /* @__PURE__ */ new Set();
  /**
   * @param adapter - ioBroker adapter instance
   * @param send - Function to send messages to Hannah Core
   * @param textCommandStateId - State ID used for text command input
   * @param residentsPrefix - State ID prefix for the residents adapter (e.g. "residents.0.")
   */
  constructor(adapter, send, textCommandStateId, residentsPrefix) {
    this.adapter = adapter;
    this.send = send;
    this.textCommandStateId = textCommandStateId;
    this.residentsPrefix = residentsPrefix.endsWith(".") ? residentsPrefix : `${residentsPrefix}.`;
  }
  /**
   * Discover and subscribe to all relevant states.
   *
   * @param config - Subscription filter configuration
   * @param config.selectedRooms - Room enum IDs to include (empty = all)
   * @param config.selectedFunctions - Function enum IDs to include (empty = all)
   * @param config.extraStatePrefixes - Additional state ID prefixes to subscribe
   */
  async start(config) {
    this.subscribedIds.clear();
    this.wildcardPrefixes.clear();
    this.verifiedWildcardCache.clear();
    await this._subscribeEnumStates(config.selectedRooms, config.selectedFunctions);
    await this._subscribeExtraPrefixes(config.extraStatePrefixes.map((p) => p.prefix));
    if (this.textCommandStateId) {
      await this.adapter.subscribeForeignStatesAsync(this.textCommandStateId);
      this.subscribedIds.add(this.textCommandStateId);
      this.adapter.log.info(`[states] Text-Command-State: ${this.textCommandStateId}`);
    }
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
      if (this.subscribedIds.has(id)) {
        continue;
      }
      await this.adapter.subscribeForeignStatesAsync(id);
      this.subscribedIds.add(id);
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
    let isSubscribed = this.subscribedIds.has(id) || id.startsWith(this.residentsPrefix);
    if (!isSubscribed) {
      isSubscribed = this.verifiedWildcardCache.has(id);
    }
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
    if (id === this.textCommandStateId && state.ack === false) {
      const text = String((_a = state.val) != null ? _a : "").trim();
      if (text) {
        this.send({ text_command: { text } });
        this.adapter.log.debug(`[states] TextCommand: ${text}`);
      }
      return true;
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
    var _a, _b;
    let sent = 0;
    for (const pattern of this.subscribedIds) {
      try {
        const states = await this.adapter.getForeignStatesAsync(pattern);
        for (const [id, state] of Object.entries(states)) {
          if (!state) {
            continue;
          }
          this.send({
            state_update: {
              state_id: id,
              value: JSON.stringify(state.val),
              ack: (_a = state.ack) != null ? _a : false,
              ts: (_b = state.ts) != null ? _b : Date.now()
            }
          });
          sent++;
        }
      } catch (e) {
        this.adapter.log.warn(`[states] Snapshot failed for ${pattern}: ${e.message}`);
      }
    }
    this.adapter.log.info(`[states] Snapshot: ${sent} current state values sent.`);
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
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  StateWatcher
});
//# sourceMappingURL=state-watcher.js.map
