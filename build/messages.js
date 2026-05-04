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
var messages_exports = {};
__export(messages_exports, {
  MessagesHandler: () => MessagesHandler
});
module.exports = __toCommonJS(messages_exports);
class MessagesHandler {
  adapter;
  notify;
  send;
  /**
   * @param adapter - ioBroker adapter instance
   * @param notify - Unary gRPC call to Hannah Core (for notifications)
   * @param send - Stream send for satellite control messages
   */
  constructor(adapter, notify, send) {
    this.adapter = adapter;
    this.notify = notify;
    this.send = send;
  }
  /**
   * Handle an incoming ioBroker message (sendDirect / sendNotification).
   *
   * @param obj - The ioBroker message object
   */
  onMessage(obj) {
    var _a, _b, _c, _d;
    if (!obj) {
      return;
    }
    if (obj.command === "sendDirect") {
      const { text } = (_a = obj.message) != null ? _a : {};
      if (!text) {
        if (obj.callback) {
          this.adapter.sendTo(obj.from, obj.command, { sent: false, error: "no payload" }, obj.callback);
        }
        return;
      }
      void this.notify(text, true, "notify").then((resp) => {
        if (obj.callback) {
          this.adapter.sendTo(obj.from, obj.command, { sent: resp.ok }, obj.callback);
        }
      }).catch((err) => {
        this.adapter.log.warn(`[messages] sendDirect failed: ${err.message}`);
        if (obj.callback) {
          this.adapter.sendTo(obj.from, obj.command, { sent: false, error: err.message }, obj.callback);
        }
      });
    } else if (obj.command === "sendNotification") {
      this.adapter.log.debug(`sendNotification: ${JSON.stringify(obj.message)}`);
      const notification = obj.message;
      const text = this.extractText(notification);
      if (!text) {
        this.adapter.log.warn("Received notification without content \u2014 ignored.");
        if (obj.callback) {
          this.adapter.sendTo(obj.from, obj.command, { sent: false, error: "no payload" }, obj.callback);
        }
        return;
      }
      const severity = (_c = (_b = notification == null ? void 0 : notification.category) == null ? void 0 : _b.severity) != null ? _c : "notify";
      void this.notify(text, false, severity).then((resp) => {
        if (obj.callback) {
          this.adapter.sendTo(obj.from, obj.command, { sent: resp.ok }, obj.callback);
        }
      }).catch((err) => {
        this.adapter.log.warn(`[messages] sendNotification failed: ${err.message}`);
        if (obj.callback) {
          this.adapter.sendTo(obj.from, obj.command, { sent: false, error: err.message }, obj.callback);
        }
      });
    } else if (obj.command === "announce") {
      const { rooms, room, text } = (_d = obj.message) != null ? _d : {};
      if (!text) {
        if (obj.callback) {
          this.adapter.sendTo(obj.from, obj.command, { sent: false, error: "no payload" }, obj.callback);
        }
        return;
      }
      const roomList = Array.isArray(rooms) ? rooms : rooms ? [rooms] : room ? [room] : ["all"];
      for (const r of roomList) {
        this.send({ satellite_control: { room: r, announcement: text } });
      }
      this.adapter.log.debug(`[messages] announce rooms=${JSON.stringify(roomList)} text=${text}`);
      if (obj.callback) {
        this.adapter.sendTo(obj.from, obj.command, { sent: true }, obj.callback);
      }
    }
  }
  extractText(notification) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
    try {
      const instances = (_c = (_b = (_a = notification == null ? void 0 : notification.category) == null ? void 0 : _a.instances) != null ? _b : notification == null ? void 0 : notification.instances) != null ? _c : {};
      const parts = [];
      for (const data of Object.values(instances)) {
        for (const msg of (_d = data.messages) != null ? _d : []) {
          if (msg.message) {
            parts.push(msg.message);
          }
        }
      }
      if (parts.length) {
        return parts.join(". ");
      }
      const desc = (_e = notification == null ? void 0 : notification.category) == null ? void 0 : _e.description;
      if (typeof desc === "string") {
        return desc;
      }
      if (desc && typeof desc === "object") {
        return (_g = (_f = desc.de) != null ? _f : desc.en) != null ? _g : null;
      }
      const name = (_h = notification == null ? void 0 : notification.category) == null ? void 0 : _h.name;
      if (typeof name === "string") {
        return name;
      }
      if (name && typeof name === "object") {
        return (_j = (_i = name.de) != null ? _i : name.en) != null ? _j : null;
      }
    } catch (e) {
      this.adapter.log.warn(`Failed to extract text: ${e.message}`);
    }
    return null;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MessagesHandler
});
//# sourceMappingURL=messages.js.map
