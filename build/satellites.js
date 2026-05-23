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
var satellites_exports = {};
__export(satellites_exports, {
  SatelliteWatcher: () => SatelliteWatcher
});
module.exports = __toCommonJS(satellites_exports);
class SatelliteWatcher {
  adapter;
  send;
  getGrpc;
  deviceRooms = /* @__PURE__ */ new Map();
  /**
   * @param adapter - ioBroker adapter instance
   * @param send - Sends AgentMessage frames to Hannah Core via gRPC
   * @param getGrpc - Lazy getter for the gRPC client (resolves after construction)
   */
  constructor(adapter, send, getGrpc) {
    this.adapter = adapter;
    this.send = send;
    this.getGrpc = getGrpc;
  }
  /**
   * Called when Hannah pushes a satellite registered/gone event, or on
   * initial connect when existing satellites are fetched via GetSatellites.
   *
   * @param deviceId - Satellite device ID
   * @param room - Room the satellite is assigned to
   * @param _address - UDP address (may be empty, reserved for future use)
   * @param online - true = registered, false = gone
   */
  async handleSatelliteUpdate(deviceId, room, _address, online) {
    if (!room && !online) {
      this.adapter.log.info(`[satellites] Satellite gone: ${deviceId}`);
      await this._setSatelliteOnline(deviceId, "", false);
      return;
    }
    if (online) {
      this.deviceRooms.set(deviceId.toLowerCase(), room);
    } else {
      this.deviceRooms.delete(deviceId.toLowerCase());
    }
    await this._ensureRoomStates(room);
    await this._ensureSatelliteStates(deviceId, room);
    await this._setSatelliteOnline(deviceId, room, online);
    if (online) {
      this.adapter.log.info(`[satellites] Satellite online: ${deviceId} in room '${room}'`);
    } else {
      this.adapter.log.info(`[satellites] Satellite offline: ${deviceId} in room '${room}'`);
    }
    await this._updateAnyOnline(room);
  }
  /**
   * Called from onStateChange when a satellite-related state changes in ioBroker.
   * Forwards writable room states (dnd, mute, volume, announcement) to Hannah Core.
   *
   * @param id - State ID that changed
   * @param state - New state value, or null/undefined if deleted
   */
  /**
   * Called when Hannah pushes a satellite.firmware event.
   */
  async handleFirmwareEvent(deviceId, version) {
    const room = this.deviceRooms.get(deviceId.toLowerCase());
    if (!room) {
      this.adapter.log.debug(`[satellites] firmware event for unknown device ${deviceId} \u2014 ignored`);
      return;
    }
    const id = `satellites.rooms.${room}.${deviceId}.firmware_version`;
    await this.adapter.setState(id, { val: version, ack: true });
    this.adapter.log.info(`[satellites] Firmware version: ${deviceId} = ${version}`);
  }
  onStateChange(id, state) {
    var _a;
    if (!state || state.val === null || state.ack) {
      return false;
    }
    const perSatMatch = id.match(
      new RegExp(
        `^${this.adapter.namespace.replace(".", "\\.")}\\.satellites\\.rooms\\.([^.]+)\\.([^.]+)\\.([^.]+)$`
      )
    );
    if (perSatMatch) {
      const [, , deviceId, key2] = perSatMatch;
      if (key2 === "update_now" && state.val === true) {
        void this.adapter.setState(id, { val: false, ack: true });
        void ((_a = this.getGrpc()) == null ? void 0 : _a.triggerFirmwareUpdate(deviceId).then((res) => {
          var _a2;
          this.adapter.log.info(`[satellites] TriggerFirmwareUpdate ${deviceId}: ${(_a2 = res.message) != null ? _a2 : "ok"}`);
        }).catch((err) => {
          this.adapter.log.warn(`[satellites] TriggerFirmwareUpdate ${deviceId} failed: ${err.message}`);
        }));
      }
      return true;
    }
    const match = id.match(
      new RegExp(`^${this.adapter.namespace.replace(".", "\\.")}\\.satellites\\.rooms\\.([^.]+)\\.([^.]+)$`)
    );
    if (!match) {
      return false;
    }
    const room = match[1];
    const key = match[2];
    const writableKeys = ["dnd", "mute", "volume", "announcement", "announcementSsml"];
    const resetKeys = ["announcement", "announcementSsml"];
    if (!writableKeys.includes(key)) {
      return false;
    }
    this.send({ satellite_control: { room, [key]: state.val } });
    if (resetKeys.includes(key)) {
      void this.adapter.setState(id, { val: "", ack: true });
    }
    this.adapter.log.debug(`[satellites] satellite_control room='${room}' ${key}=${state.val}`);
    return true;
  }
  async _ensureRoomStates(room) {
    const base = `satellites.rooms.${room}`;
    await this.adapter.setObjectNotExistsAsync(base, {
      type: "channel",
      common: { name: `Room ${room}` },
      native: {}
    });
    const states = [
      ["announcement", { name: "Announcement", type: "string", role: "text", read: true, write: true, def: "" }],
      [
        "announcementSsml",
        { name: "Announcement (SSML)", type: "string", role: "text", read: true, write: true, def: "" }
      ],
      [
        "anyOnline",
        {
          name: "Any satellite online",
          type: "boolean",
          role: "indicator.connected",
          read: true,
          write: false,
          def: false
        }
      ],
      ["dnd", { name: "Do not disturb", type: "boolean", role: "switch", read: true, write: true, def: false }],
      ["mute", { name: "Mute microphone", type: "boolean", role: "switch", read: true, write: true, def: false }],
      [
        "speaking",
        {
          name: "Hannah is speaking",
          type: "boolean",
          role: "indicator",
          read: true,
          write: false,
          def: false
        }
      ],
      [
        "lastTranscript",
        { name: "Last transcript", type: "string", role: "text", read: true, write: false, def: "" }
      ],
      [
        "volume",
        {
          name: "Volume (0\u2013100)",
          type: "number",
          role: "level.volume",
          read: true,
          write: true,
          def: 80,
          min: 0,
          max: 100
        }
      ]
    ];
    for (const [key, common] of states) {
      await this.adapter.setObjectNotExistsAsync(`${base}.${key}`, {
        type: "state",
        common,
        native: {}
      });
    }
  }
  async _ensureSatelliteStates(deviceId, room) {
    const base = `satellites.rooms.${room}.${deviceId}`;
    await this.adapter.setObjectNotExistsAsync(base, {
      type: "device",
      common: { name: `Satellite ${deviceId}` },
      native: {}
    });
    await this.adapter.setObjectNotExistsAsync(`${base}.online`, {
      type: "state",
      common: {
        name: "Satellite online",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false
      },
      native: {}
    });
    await this.adapter.setObjectNotExistsAsync(`${base}.firmware_version`, {
      type: "state",
      common: {
        name: "Firmware version",
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: ""
      },
      native: {}
    });
    await this.adapter.setObjectNotExistsAsync(`${base}.update_now`, {
      type: "state",
      common: {
        name: "Update firmware now",
        type: "boolean",
        role: "button",
        read: false,
        write: true,
        def: false
      },
      native: {}
    });
  }
  async _setSatelliteOnline(deviceId, room, online) {
    if (!room) {
      return;
    }
    await this.adapter.setState(`satellites.rooms.${room}.${deviceId}.online`, { val: online, ack: true });
  }
  async _updateAnyOnline(room) {
    const pattern = `${this.adapter.namespace}.satellites.rooms.${room}.*.online`;
    const states = await this.adapter.getForeignStatesAsync(pattern);
    const anyOnline = Object.values(states).some((s) => (s == null ? void 0 : s.val) === true);
    await this.adapter.setState(`satellites.rooms.${room}.anyOnline`, { val: anyOnline, ack: true });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SatelliteWatcher
});
//# sourceMappingURL=satellites.js.map
