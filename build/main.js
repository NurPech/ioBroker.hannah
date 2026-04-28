"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_grpc_client = require("./grpc-client");
var import_state_watcher = require("./state-watcher");
var import_residents = require("./residents");
class Hannah extends utils.Adapter {
  grpc = null;
  states = null;
  residents = null;
  constructor(options = {}) {
    super({ ...options, name: "hannah" });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /** @inheritdoc */
  async onReady() {
    await this.setObjectNotExistsAsync("info.connection", {
      type: "state",
      common: {
        name: "Connected to Hannah Core",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false
      },
      native: {}
    });
    await this.setState("info.connection", false, true);
    const cfg = this.config;
    const host = cfg.hannahHost || "127.0.0.1";
    const port = cfg.hannahPort || 50051;
    const send = (msg) => {
      var _a;
      (_a = this.grpc) == null ? void 0 : _a.send(msg);
    };
    this.states = new import_state_watcher.StateWatcher(this, send, cfg.textCommandStateId || "", cfg.residentsInstance ? `residents.${cfg.residentsInstance}.` : "residents.");
    this.residents = cfg.residentsInstance ? new import_residents.ResidentsWatcher(this, send, cfg.residentsInstance) : null;
    this.grpc = new import_grpc_client.GrpcClient({
      log: this.log,
      onConnected: async () => {
        var _a;
        await this.setState("info.connection", true, true);
        await this.states.start({
          selectedRooms: cfg.selectedRooms || [],
          selectedFunctions: cfg.selectedFunctions || [],
          extraStatePrefixes: cfg.extraStatePrefixes || []
        });
        await ((_a = this.residents) == null ? void 0 : _a.subscribe());
      },
      onDisconnected: async () => {
        var _a, _b;
        await this.setState("info.connection", false, true);
        await ((_a = this.states) == null ? void 0 : _a.stop());
        await ((_b = this.residents) == null ? void 0 : _b.unsubscribe());
      },
      onCommand: (cmd) => {
        var _a, _b, _c;
        const which = Object.keys(cmd).find((k) => k !== "command" && cmd[k]);
        if (which === "set_state" && cmd.set_state) {
          void ((_a = this.states) == null ? void 0 : _a.handleSetState(cmd.set_state.state_id, cmd.set_state.value));
        } else if (which === "watch_more" && ((_b = cmd.watch_more) == null ? void 0 : _b.state_ids)) {
          void ((_c = this.states) == null ? void 0 : _c.watchMore(cmd.watch_more.state_ids));
        }
      }
    });
    this.grpc.connect(host, port);
  }
  /** @inheritdoc */
  onStateChange(id, state) {
    var _a, _b;
    (_a = this.residents) == null ? void 0 : _a.onStateChange(id, state);
    (_b = this.states) == null ? void 0 : _b.onStateChange(id, state);
  }
  /**
   * Is called when adapter shuts down — callback has to be called under any circumstances!
   *
   * @param callback - Callback function
   */
  onUnload(callback) {
    var _a;
    try {
      (_a = this.grpc) == null ? void 0 : _a.disconnect();
      callback();
    } catch (e) {
      this.log.error(`Error during shutdown: ${e.message}`);
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Hannah(options);
} else {
  (() => new Hannah())();
}
//# sourceMappingURL=main.js.map
