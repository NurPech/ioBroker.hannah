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
var deviceManager_exports = {};
__export(deviceManager_exports, {
  default: () => HannahDeviceManagement
});
module.exports = __toCommonJS(deviceManager_exports);
var import_dm_utils = require("@iobroker/dm-utils");
const SATELLITE_RE = /^satellites\.rooms\.([^.]+)\.([^.]+)$/;
class HannahDeviceManagement extends import_dm_utils.DeviceManagement {
  /** @inheritdoc */
  constructor(adapter) {
    super(adapter);
  }
  /** @inheritdoc */
  getInstanceInfo() {
    return {
      apiVersion: "v3",
      smallCards: true
    };
  }
  /** @inheritdoc */
  async loadDevices(context) {
    const devices = await this.adapter.getDevicesAsync();
    for (const device of devices) {
      const shortId = device._id.substring(this.adapter.namespace.length + 1);
      const match = shortId.match(SATELLITE_RE);
      if (!match) {
        continue;
      }
      const [, room, deviceId] = match;
      const ns = this.adapter.namespace;
      const onlineState = await this.adapter.getForeignStateAsync(`${device._id}.online`);
      const isOnline = (onlineState == null ? void 0 : onlineState.val) === true;
      const muteState = await this.adapter.getForeignStateAsync(`${ns}.satellites.rooms.${room}.mute`);
      const volumeState = await this.adapter.getForeignStateAsync(`${ns}.satellites.rooms.${room}.volume`);
      const controls = [
        {
          id: "mute",
          type: "switch",
          stateId: `satellites.rooms.${room}.mute`,
          label: { en: "Mute", de: "Stumm" },
          state: muteState != null ? muteState : { val: false, ts: Date.now(), ack: true },
          handler: async (_deviceId, _actionId, state) => {
            await this.adapter.setStateAsync(`satellites.rooms.${room}.mute`, {
              val: state,
              ack: false
            });
            return { val: state, ts: Date.now(), ack: true };
          }
        },
        {
          id: "volume",
          type: "slider",
          stateId: `satellites.rooms.${room}.volume`,
          label: { en: "Volume", de: "Lautst\xE4rke" },
          min: 0,
          max: 100,
          unit: "%",
          state: volumeState != null ? volumeState : { val: 80, ts: Date.now(), ack: true },
          handler: async (_deviceId, _actionId, state) => {
            await this.adapter.setStateAsync(`satellites.rooms.${room}.volume`, {
              val: state,
              ack: false
            });
            return { val: state, ts: Date.now(), ack: true };
          }
        }
      ];
      const info = {
        id: device._id,
        name: device.common.name || deviceId,
        identifier: room,
        status: { connection: isOnline ? "connected" : "disconnected" },
        hasDetails: true,
        controls,
        actions: []
      };
      context.addDevice(info);
    }
  }
  /** @inheritdoc */
  getDeviceDetails(id) {
    const shortId = id.substring(this.adapter.namespace.length + 1);
    const match = shortId.match(SATELLITE_RE);
    if (!match) {
      return null;
    }
    const [, room, deviceId] = match;
    return {
      id,
      schema: {
        type: "panel",
        items: {
          deviceId: {
            type: "staticInfo",
            label: { en: "Device ID", de: "Ger\xE4te-ID" },
            data: deviceId,
            addColon: true,
            copyToClipboard: true
          },
          room: {
            type: "staticInfo",
            label: { en: "Room", de: "Raum" },
            data: room,
            addColon: true
          },
          online: {
            type: "state",
            oid: `satellites.rooms.${room}.${deviceId}.online`,
            control: "text",
            label: { en: "Online", de: "Online" },
            addColon: true
          }
        }
      }
    };
  }
}
//# sourceMappingURL=deviceManager.js.map
