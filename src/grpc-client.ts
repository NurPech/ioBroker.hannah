import * as grpc from '@grpc/grpc-js';
import { client } from '@m1kad0/hannah-grpc-lib';
import type { v1 } from '@m1kad0/hannah-proto';
import { v2 } from '@m1kad0/hannah-proto';
import { commandToV2, hasPayload, messageToV1 } from './agent-bridge';
import type { BridgedCommand } from './agent-bridge';
import agent = v2.agent;
import control = v2.control;
import satellite = v2.satellite;
import shared = v2.shared;
import satellite_provisioning = v2.satellite_provisioning;
import user_registry = v2.user_registry;

/** The API generation of the AgentConnect stream: Core serves hannah.v2, or only hannah.v1 (older Core). */
export type Generation = 'v1' | 'v2';

export type AgentMessageSender = (msg: agent.AgentMessage) => void;
/** Sends a hannah.v1 message as it is: the legacy device sync, which is not bridged. Only works on a v1 stream. */
export type LegacyMessageSender = (msg: v1.agent.AgentMessage) => void;
export type CommandHandler = (cmd: BridgedCommand) => void;

/**
 * Outcome of sendWithAck() (hannah-proto#16):
 * - ack: Core replied, `ack.unknownFields` lists what its schema didn't know
 * - timeout: no reply in time — Core too old to send AgentAck at all
 * - disconnected: stream closed before a reply — outcome unknown, not a verdict
 */
export type AckResult = { kind: 'ack'; ack: agent.AgentAck } | { kind: 'timeout' } | { kind: 'disconnected' };
export type AckingMessageSender = (msg: agent.AgentMessage) => Promise<AckResult>;
export type LegacyAckingMessageSender = (msg: v1.agent.AgentMessage) => Promise<AckResult>;

const ACK_TIMEOUT_MS = 10_000;

interface LogAdapter {
    info: (s: string) => void;
    warn: (s: string) => void;
    error: (s: string) => void;
    debug: (s: string) => void;
}

interface GrpcClientOptions {
    onCommand: CommandHandler;
    onConnected: (generation: Generation) => void;
    onDisconnected: () => void;
    log: LogAdapter;
    setTimeout: (fn: () => void, ms: number) => number;
    clearTimeout: (t: number) => void;
}

/**
 * Manages the bidirectional gRPC stream connection to Hannah Core.
 * Automatically reconnects on error or stream end.
 */
export class GrpcClient {
    private versioned: client.VersionedClient | null = null;
    // hannah.v2 client: on a Core that only speaks hannah.v1 the lib translates the calls
    private client: client.HannahServiceClient | null = null;
    private connectGeneration = 0;
    // Raw stream of the active generation, `streamGeneration` tells which messages it takes
    private stream: { write(msg: unknown): unknown; end(): unknown } | null = null;
    private streamGeneration: Generation = 'v2';
    private reconnectTimer: number | null = null;
    private running = false;
    private onCommand: CommandHandler;
    private onConnected: (generation: Generation) => void;
    private onDisconnected: () => void;
    private log: LogAdapter;
    private _setTimeout: (fn: () => void, ms: number) => number;
    private _clearTimeout: (t: number) => void;
    // Per connection: reset in _openStream(), pending ones resolved as 'disconnected' on close.
    private ackCounter = 0n;
    private pendingAcks = new Map<bigint, { resolve: (r: AckResult) => void; timer: number }>();

    /**
     * @param opts - Configuration options including callbacks and logger
     */
    constructor(opts: GrpcClientOptions) {
        this.onCommand = opts.onCommand;
        this.onConnected = opts.onConnected;
        this.onDisconnected = opts.onDisconnected;
        this.log = opts.log;
        this._setTimeout = opts.setTimeout;
        this._clearTimeout = opts.clearTimeout;
    }

    /**
     * Start the connection to Hannah Core. Reconnects automatically on failure.
     *
     * @param host - gRPC server host
     * @param port - gRPC server port
     */
    connect(host: string, port: number): void {
        this.running = true;
        this._connect(host, port);
    }

    private _connect(host: string, port: number): void {
        if (!this.running) {
            return;
        }
        // Close previous stream/client before reconnecting to avoid duplicate connections
        this._closeConnection();

        const addr = `${host}:${port}`;
        this.log.info(`[grpc] Connecting to Hannah Core: ${addr}`);
        // hannah.v2 with fallback to hannah.v1 for Cores that don't serve v2 yet. A fresh
        // VersionedClient per connection means the probe runs again after every reconnect
        // (Core may have been updated in between). x-proto-version and x-compat-version are
        // attached by the lib's default interceptors.
        const versioned = new client.VersionedClient(addr, grpc.credentials.createInsecure(), {
            warn: (message: string) => this.log.warn(`[grpc] ${message}`),
        });
        this.versioned = versioned;
        const generation = ++this.connectGeneration;
        versioned
            .resolve()
            .then(async resolved => {
                // Unary calls are written for hannah.v2 only, the lib translates them on a v1 Core.
                // The device sync (AgentConnect) can't be translated, it uses the raw client.
                const translated = await versioned.resolveTranslated();
                // disconnect() or a newer _connect() happened during the probe
                if (!this.running || generation !== this.connectGeneration) {
                    return;
                }
                this.client = translated;
                this._openStream(resolved, host, port);
            })
            .catch((e: Error) => {
                this.log.warn(`[grpc] Connecting failed: ${e.message}`);
                this._scheduleReconnect(host, port);
            });
    }

    private _closeConnection(): void {
        for (const { resolve, timer } of this.pendingAcks.values()) {
            this._clearTimeout(timer);
            resolve({ kind: 'disconnected' });
        }
        this.pendingAcks.clear();
        try {
            this.stream?.end();
        } catch {
            /* ignore */
        }
        try {
            this.versioned?.close();
        } catch {
            /* ignore */
        }
        this.stream = null;
        this.client = null;
        this.versioned = null;
    }

    private _openStream(
        resolved: Awaited<ReturnType<client.VersionedClient['resolve']>>,
        host: string,
        port: number,
    ): void {
        const generation: Generation = resolved.previous ? 'v1' : 'v2';
        // each generation's client has its own message types, the stream is typed per generation below
        const stream = (
            resolved.client as unknown as { agentConnect(): grpc.ClientDuplexStream<unknown, unknown> }
        ).agentConnect();
        this.stream = stream;
        this.streamGeneration = generation;
        this.ackCounter = 0n;

        // For bidi streams with Python gRPC, the server does not send initial metadata,
        // so the 'metadata' event never fires. Trigger onConnected immediately — if the
        // server is unreachable we will get an 'error' event shortly after.
        this.log.info(`[grpc] Connected to Hannah Core (hannah.${generation}).`);
        (this.onConnected(generation) as unknown as Promise<void>).catch((e: Error) => {
            this.log.error(`[grpc] onConnected error: ${e.message}`);
        });

        stream.on('data', (raw: unknown) => {
            // a hannah.v1 Core speaks hannah.v1 on the stream, everything above works with hannah.v2
            const cmd = generation === 'v1' ? commandToV2(raw as v1.agent.AgentCommand) : (raw as agent.AgentCommand);
            if (cmd.ack) {
                this._handleAck(cmd.ack);
                return;
            }
            this.onCommand(cmd);
        });

        stream.on('error', (err: Error) => {
            this.log.warn(`[grpc] Stream error: ${err.message}`);
            this._scheduleReconnect(host, port);
        });

        stream.on('end', () => {
            this.log.info('[grpc] Stream ended.');
            this.onDisconnected();
            this._scheduleReconnect(host, port);
        });
    }

    /** Generation of the open AgentConnect stream, null while not connected. */
    get generation(): Generation | null {
        return this.stream ? this.streamGeneration : null;
    }

    private _scheduleReconnect(host: string, port: number): void {
        if (!this.running) {
            return;
        }
        if (this.reconnectTimer) {
            return;
        }
        this.log.info('[grpc] Reconnecting in 10s...');
        this.reconnectTimer = this._setTimeout(() => {
            this.reconnectTimer = null;
            this._connect(host, port);
        }, 10_000);
    }

    /**
     * Fetch the current list of registered satellites from Hannah Core.
     * Returns `null` on error (no client, or the RPC itself failed) — distinct from an empty
     * array, which means Core was actually reached and genuinely reports zero satellites.
     * Callers MUST treat `null` as "unknown state, don't touch anything" rather than falling
     * back to an empty array — conflating the two previously caused every satellite object to
     * be deleted as "stale" whenever Core was merely unreachable (Refs #<issue>).
     */
    getSatellites(): Promise<satellite.Satellite[] | null> {
        return new Promise(resolve => {
            if (!this.client) {
                resolve(null);
                return;
            }
            this.client.getSatellites({}, (err: Error | null, response?: satellite.GetSatellitesResponse) => {
                if (err || !response) {
                    this.log.warn(`[grpc] GetSatellites failed: ${err?.message ?? 'no response'}`);
                    resolve(null);
                } else {
                    resolve(response.satellites ?? []);
                }
            });
        });
    }

    /**
     * Provision a satellite before flashing: stores seed + display_name + room_id in Hannah's DB.
     * On first connect the satellite sends the seed; Hannah links device_id → pre-config and marks paired.
     *
     * @param seed - UUID generated by the adapter (written to NVS)
     * @param displayName - Human-readable device name
     * @param roomId - Room the satellite will be assigned to
     */
    provisionSatellite(seed: string, displayName: string, roomId = ''): Promise<{ ok: boolean; message?: string }> {
        return new Promise((resolve, reject) => {
            if (!this.client) {
                reject(new Error('not connected'));
                return;
            }
            const timer = this._setTimeout(() => reject(new Error('timeout')), 5000);
            const request: satellite_provisioning.ProvisionSatelliteRequest = { seed, displayName, roomId };
            this.client.provisionSatellite(request, (err: Error | null, response?: shared.StatusResponse) => {
                this._clearTimeout(timer);
                if (err || !response) {
                    reject(err ?? new Error('no response'));
                } else {
                    resolve({ ok: response.ok, message: response.message });
                }
            });
        });
    }

    /**
     * Rename an already-known, already-paired satellite in place.
     *
     * @param deviceId - The satellite's real device ID (eFuse MAC), not a pairing seed
     * @param displayName - New human-readable name
     * @param requestorId - Hannah user ID to authorize the rename (trust level 10, or owner at trust level 5+)
     */
    setSatelliteDisplayName(
        deviceId: string,
        displayName: string,
        requestorId: number,
    ): Promise<{ ok: boolean; message?: string }> {
        return new Promise((resolve, reject) => {
            if (!this.client) {
                reject(new Error('not connected'));
                return;
            }
            const timer = this._setTimeout(() => reject(new Error('timeout')), 5000);
            const request: satellite.SetSatelliteDisplayNameRequest = { deviceId, displayName, requestorId };
            this.client.setSatelliteDisplayName(request, (err: Error | null, response?: shared.StatusResponse) => {
                this._clearTimeout(timer);
                if (err || !response) {
                    reject(err ?? new Error('no response'));
                } else {
                    resolve({ ok: response.ok, message: response.message });
                }
            });
        });
    }

    /**
     * Send a notification to Hannah Core and wait for acknowledgement.
     * Resolves with ok=true when queued, ok=false on error, or rejects on timeout.
     *
     * @param text - Notification text
     * @param direct - Skip LLM reformulation if true
     * @param severity - Tone hint: "alert" | "notify" | "info" (only when direct=false)
     * @param timeoutMs - Max wait time in milliseconds (default 5000)
     */
    notify(
        text: string,
        direct: boolean,
        severity: string,
        timeoutMs = 5000,
    ): Promise<{ ok: boolean; message?: string }> {
        return new Promise((resolve, reject) => {
            if (!this.client) {
                reject(new Error('not connected'));
                return;
            }
            const timer = this._setTimeout(() => reject(new Error('timeout')), timeoutMs);
            const request: agent.AgentNotification = { text, direct, severity };
            this.client.notify(request, (err: Error | null, response?: shared.StatusResponse) => {
                this._clearTimeout(timer);
                if (err || !response) {
                    reject(err ?? new Error('no response'));
                } else {
                    resolve({ ok: response.ok, message: response.message });
                }
            });
        });
    }

    /**
     * Send a TTS announcement to a specific device, room, and/or Person.
     * room_id and user_id (#31) take precedence over device when set — see AnnounceRequest
     * in hannah.proto for the AND semantics when both room_id and user_id are given.
     *
     * @param text - Text to announce
     * @param opts - Target selector
     * @param opts.device - Satellite device name, or "all" for broadcast (legacy path)
     * @param opts.roomId - Target room (Core DB room_id)
     * @param opts.userId - Target Person (Hannah's numeric User.id)
     * @param timeoutMs - Max wait time in milliseconds (default 5000)
     */
    announce(
        text: string,
        opts: { device?: string; roomId?: string; userId?: number } = {},
        timeoutMs = 5000,
    ): Promise<{ ok: boolean; message?: string }> {
        return new Promise((resolve, reject) => {
            if (!this.client) {
                reject(new Error('not connected'));
                return;
            }
            const timer = this._setTimeout(() => reject(new Error('timeout')), timeoutMs);
            const request: control.AnnounceRequest = {
                text,
                device: opts.device ?? '',
                roomId: opts.roomId ?? '',
                userId: opts.userId ?? 0,
            };
            this.client.announce(request, (err: Error | null, response?: shared.StatusResponse) => {
                this._clearTimeout(timer);
                if (err || !response) {
                    reject(err ?? new Error('no response'));
                } else {
                    resolve({ ok: response.ok, message: response.message });
                }
            });
        });
    }

    /**
     * Resolve a roomie_id (e.g. "leonie") to Hannah's numeric User.id via the residents
     * linked-account lookup — same external_id scheme Core itself uses (`<roomie_id>_roomie`,
     * see core/hannah/user_manager.py `_resident_link`/main.py `_hannah_external_id`).
     *
     * @param roomieId - Roomie ID as known throughout this adapter (residents.ts, set_resident, ask)
     * @param timeoutMs - Max wait time in milliseconds (default 5000)
     * @returns The numeric User.id, or null if no matching/active user is found
     */
    resolveRoomieUserId(roomieId: string, timeoutMs = 5000): Promise<number | null> {
        return new Promise(resolve => {
            if (!this.client) {
                resolve(null);
                return;
            }
            const timer = this._setTimeout(() => resolve(null), timeoutMs);
            const request: user_registry.GetUserRequest = {
                linkedAccount: { provider: 'residents', externalId: `${roomieId}_roomie` },
                type: agent.ResidentType.RESIDENT_TYPE_UNSPECIFIED,
            };
            this.client.getUser(request, (err: Error | null, response?: user_registry.UserResponse) => {
                this._clearTimeout(timer);
                if (err || !response?.found) {
                    resolve(null);
                } else {
                    resolve(response.user?.id ?? null);
                }
            });
        });
    }

    /**
     * Trigger an immediate OTA firmware update for a satellite.
     *
     * @param device - Satellite device ID
     */
    triggerFirmwareUpdate(device: string): Promise<{ ok: boolean; message?: string }> {
        return new Promise((resolve, reject) => {
            if (!this.client) {
                reject(new Error('not connected'));
                return;
            }
            const timer = this._setTimeout(() => reject(new Error('timeout')), 5000);
            this.client.triggerFirmwareUpdate({ device }, (err: Error | null, response?: shared.StatusResponse) => {
                this._clearTimeout(timer);
                if (err || !response) {
                    reject(err ?? new Error('no response'));
                } else {
                    resolve({ ok: response.ok, message: response.message });
                }
            });
        });
    }

    /**
     * Trigger an ordered remote restart (`esp_restart()`) of a satellite over MQTT.
     *
     * @param device - Satellite device ID
     */
    triggerSatelliteRestart(device: string): Promise<{ ok: boolean; message?: string }> {
        return new Promise((resolve, reject) => {
            if (!this.client) {
                reject(new Error('not connected'));
                return;
            }
            const timer = this._setTimeout(() => reject(new Error('timeout')), 5000);
            this.client.triggerSatelliteRestart({ device }, (err: Error | null, response?: shared.StatusResponse) => {
                this._clearTimeout(timer);
                if (err || !response) {
                    reject(err ?? new Error('no response'));
                } else {
                    resolve({ ok: response.ok, message: response.message });
                }
            });
        });
    }

    /**
     * Send a message to Hannah Core.
     *
     * @param msg - AgentMessage frame
     */
    send(msg: agent.AgentMessage): void {
        if (!this.stream) {
            return;
        }
        if (this.streamGeneration === 'v2') {
            this._write(msg);
            return;
        }
        // hannah.v1 stream: the typed device messages have no counterpart there, nothing is sent
        const bridged = messageToV1(msg);
        if (hasPayload(bridged)) {
            this._write(bridged);
        }
    }

    /**
     * Send a hannah.v1 message as it is. For the legacy device sync (per-state snapshot and
     * state updates with a canonical key) on a stream to a Core that only speaks hannah.v1;
     * on a hannah.v2 stream it is dropped.
     *
     * @param msg - AgentMessage frame in hannah.v1 form
     */
    sendLegacy(msg: v1.agent.AgentMessage): void {
        if (!this.stream) {
            return;
        }
        if (this.streamGeneration !== 'v1') {
            this.log.debug('[grpc] Dropping a hannah.v1 message on a hannah.v2 stream.');
            return;
        }
        this._write(msg);
    }

    private _write(msg: unknown): void {
        try {
            this.stream?.write(msg);
        } catch (e) {
            this.log.warn(`[grpc] Send failed: ${(e as Error).message}`);
        }
    }

    /**
     * Send a message with ack_id set and wait for Core's AgentAck listing the fields it
     * didn't understand (hannah-proto#16). Never rejects — see AckResult for the outcomes.
     *
     * @param msg - AgentMessage frame; its ackId is overwritten
     * @param timeoutMs - How long to wait for the AgentAck before assuming Core is too old
     */
    sendWithAck(msg: agent.AgentMessage, timeoutMs = ACK_TIMEOUT_MS): Promise<AckResult> {
        return this._sendAcked(ackId => this.send({ ...msg, ackId }), timeoutMs);
    }

    /**
     * Like sendWithAck(), for a hannah.v1 message on a hannah.v1 stream (see sendLegacy()).
     *
     * @param msg - AgentMessage frame in hannah.v1 form; its ackId is overwritten
     * @param timeoutMs - How long to wait for the AgentAck before assuming Core is too old
     */
    sendLegacyWithAck(msg: v1.agent.AgentMessage, timeoutMs = ACK_TIMEOUT_MS): Promise<AckResult> {
        return this._sendAcked(ackId => this.sendLegacy({ ...msg, ackId }), timeoutMs);
    }

    private _sendAcked(write: (ackId: bigint) => void, timeoutMs: number): Promise<AckResult> {
        if (!this.stream) {
            return Promise.resolve({ kind: 'disconnected' });
        }
        const ackId = ++this.ackCounter;
        return new Promise(resolve => {
            const timer = this._setTimeout(() => {
                this.pendingAcks.delete(ackId);
                resolve({ kind: 'timeout' });
            }, timeoutMs);
            this.pendingAcks.set(ackId, { resolve, timer });
            write(ackId);
        });
    }

    private _handleAck(ack: agent.AgentAck): void {
        const pending = this.pendingAcks.get(ack.ackId);
        if (!pending) {
            this.log.debug(`[grpc] Ignoring AgentAck for unknown ack_id ${ack.ackId}`);
            return;
        }
        this.pendingAcks.delete(ack.ackId);
        this._clearTimeout(pending.timer);
        pending.resolve({ kind: 'ack', ack });
    }

    /**
     * Stop the connection and cancel any pending reconnect.
     */
    disconnect(): void {
        this.running = false;
        if (this.reconnectTimer) {
            this._clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this._closeConnection();
    }
}
