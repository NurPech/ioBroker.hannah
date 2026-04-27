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
  constructor(adapter, send, textCommandStateId) {
    this.adapter = adapter;
    this.send = send;
    this.textCommandStateId = textCommandStateId;
  }
  /**
   * Discover and subscribe to all relevant states.
   *
   * @param config
   * @param config.selectedRooms
   * @param config.selectedFunctions
   * @param config.extraStatePrefixes
   */
  async start(config) {
    await this._subscribeEnumStates(config.selectedRooms, config.selectedFunctions);
    await this._subscribeExtraPrefixes(config.extraStatePrefixes.map((p) => p.prefix));
    if (this.textCommandStateId) {
      await this.adapter.subscribeForeignStatesAsync(this.textCommandStateId);
      this.subscribedIds.add(this.textCommandStateId);
      this.adapter.log.info(`[states] Text-Command-State: ${this.textCommandStateId}`);
    }
    this.adapter.log.info(`[states] ${this.subscribedIds.size} States subscribed.`);
  }
  /**
   * Subscribe additional state IDs on demand (from AgentWatchMore).
   *
   * @param stateIds
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
   * @param id
   * @param state
   */
  onStateChange(id, state) {
    var _a, _b, _c;
    if (!this.subscribedIds.has(id) && !id.startsWith("residents.")) {
      return false;
    }
    if (!state) {
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
   * @param stateId
   * @param value
   */
  async handleSetState(stateId, value) {
    try {
      const parsed = JSON.parse(value);
      await this.adapter.setForeignStateAsync(stateId, { val: parsed, ack: false });
      this.adapter.log.debug(`[states] SetState ${stateId} = ${value}`);
    } catch (e) {
      this.adapter.log.error(`[states] SetState fehlgeschlagen f\xFCr ${stateId}: ${e.message}`);
    }
  }
  async stop() {
    for (const id of this.subscribedIds) {
      await this.adapter.unsubscribeForeignStatesAsync(id);
    }
    this.subscribedIds.clear();
  }
  async _subscribeEnumStates(selectedRooms, selectedFunctions) {
    const roomEnumId = "enum.rooms";
    const funcEnumId = "enum.functions";
    const [roomsObj, funcsObj] = await Promise.all([
      this.adapter.getObjectAsync(roomEnumId),
      this.adapter.getObjectAsync(funcEnumId)
    ]);
    const roomIds = this._collectEnumMembers(roomsObj, selectedRooms);
    const funcIds = this._collectEnumMembers(funcsObj, selectedFunctions);
    const stateIds = selectedRooms.length === 0 && selectedFunctions.length === 0 ? /* @__PURE__ */ new Set([...roomIds, ...funcIds]) : new Set([...roomIds].filter((id) => funcIds.has(id)));
    for (const id of stateIds) {
      if (this.subscribedIds.has(id)) {
        continue;
      }
      await this.adapter.subscribeForeignStatesAsync(id);
      this.subscribedIds.add(id);
    }
    this.adapter.log.info(`[states] Enum-Discovery: ${stateIds.size} States (rooms \xD7 functions).`);
  }
  _collectEnumMembers(enumObj, selected) {
    var _a, _b;
    const ids = /* @__PURE__ */ new Set();
    if (!enumObj || enumObj.type !== "enum") {
      return ids;
    }
    const children = enumObj.children;
    if (!children) {
      return ids;
    }
    for (const [childId, child] of Object.entries(children)) {
      if (selected.length > 0 && !selected.includes(childId)) {
        continue;
      }
      for (const memberId of (_b = (_a = child.common) == null ? void 0 : _a.members) != null ? _b : []) {
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
      const pattern = prefix.endsWith(".") ? `${prefix}*` : `${prefix}.*`;
      await this.adapter.subscribeForeignStatesAsync(pattern);
      this.subscribedIds.add(pattern);
      this.adapter.log.info(`[states] Extra-Prefix: ${pattern}`);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  StateWatcher
});
//# sourceMappingURL=state-watcher.js.map
