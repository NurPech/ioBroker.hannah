"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var grpc_client_exports = {};
__export(grpc_client_exports, {
  GrpcClient: () => GrpcClient
});
module.exports = __toCommonJS(grpc_client_exports);
var path = __toESM(require("node:path"));
var grpc = __toESM(require("@grpc/grpc-js"));
var protoLoader = __toESM(require("@grpc/proto-loader"));
const PROTO_PATH = path.join(__dirname, "proto", "hannah.proto");
const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});
const proto = grpc.loadPackageDefinition(packageDef);
class GrpcClient {
  client = null;
  stream = null;
  reconnectTimer = null;
  running = false;
  onCommand;
  onConnected;
  onDisconnected;
  log;
  constructor(opts) {
    this.onCommand = opts.onCommand;
    this.onConnected = opts.onConnected;
    this.onDisconnected = opts.onDisconnected;
    this.log = opts.log;
  }
  connect(host, port) {
    this.running = true;
    this._connect(host, port);
  }
  _connect(host, port) {
    if (!this.running) {
      return;
    }
    const addr = `${host}:${port}`;
    this.log.info(`[grpc] Verbinde zu Hannah Core: ${addr}`);
    this.client = new proto.hannah.HannahService(addr, grpc.credentials.createInsecure());
    this.stream = this.client.AgentConnect();
    this.stream.on("data", (cmd) => {
      this.onCommand(cmd);
    });
    this.stream.on("error", (err) => {
      this.log.warn(`[grpc] Stream-Fehler: ${err.message}`);
      this._scheduleReconnect(host, port);
    });
    this.stream.on("end", () => {
      this.log.info("[grpc] Stream beendet.");
      this.onDisconnected();
      this._scheduleReconnect(host, port);
    });
    this.stream.on("status", (status) => {
      if (status.code === grpc.status.OK) {
        this.log.info("[grpc] Verbunden mit Hannah Core.");
        this.onConnected();
      }
    });
  }
  _scheduleReconnect(host, port) {
    if (!this.running) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    this.log.info("[grpc] Reconnect in 10s...");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect(host, port);
    }, 1e4);
  }
  send(msg) {
    if (!this.stream) {
      return;
    }
    try {
      this.stream.write(msg);
    } catch (e) {
      this.log.warn(`[grpc] Send fehlgeschlagen: ${e.message}`);
    }
  }
  disconnect() {
    var _a, _b;
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      (_a = this.stream) == null ? void 0 : _a.end();
    } catch {
    }
    try {
      (_b = this.client) == null ? void 0 : _b.close();
    } catch {
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GrpcClient
});
//# sourceMappingURL=grpc-client.js.map
