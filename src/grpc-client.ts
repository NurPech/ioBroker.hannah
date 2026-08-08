import * as grpc from '@grpc/grpc-js';
import { PROTO_VERSION, agent, hannah, compat_interceptor } from '@m1kad0/hannah-proto';
import type { control, satellite, shared, satellite_provisioning, user_registry } from '@m1kad0/hannah-proto';

/**
 * Haengt die PROTO_VERSION der installierten hannah-proto npm-Version als `x-proto-version`-Metadata
 * an jeden ausgehenden Call (#60).
 *
 * @param options - Call options for this interceptor invocation
 * @param nextCall - Continuation to the next interceptor / the actual call
 */
const protocolVersionInterceptor: grpc.Interceptor = (
    options: grpc.InterceptorOptions,
    nextCall: grpc.NextCall,
): grpc.InterceptingCall => {
    const requester = new grpc.RequesterBuilder()
        .withStart((metadata, listener, next) => {
            metadata.set('x-proto-version', String(PROTO_VERSION));
            next(metadata, listener);
        })
        .build();
    return new grpc.InterceptingCall(nextCall(options), requester);
};

export type AgentMessageSender = (msg: agent.AgentMessage) => void;
export type CommandHandler = (cmd: agent.AgentCommand) => void;

interface LogAdapter {
    info: (s: string) => void;
    warn: (s: string) => void;
    error: (s: string) => void;
    debug: (s: string) => void;
}

interface GrpcClientOptions {
    onCommand: CommandHandler;
    onConnected: () => void;
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
    private client: hannah.HannahServiceClient | null = null;
    private stream: grpc.ClientDuplexStream<agent.AgentMessage, agent.AgentCommand> | null = null;
    private reconnectTimer: number | null = null;
    private running = false;
    private onCommand: CommandHandler;
    private onConnected: () => void;
    private onDisconnected: () => void;
    private log: LogAdapter;
    private _setTimeout: (fn: () => void, ms: number) => number;
    private _clearTimeout: (t: number) => void;

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
        try {
            this.stream?.end();
        } catch {
            /* ignore */
        }
        try {
            this.client?.close();
        } catch {
            /* ignore */
        }
        this.stream = null;
        this.client = null;

        const addr = `${host}:${port}`;
        this.log.info(`[grpc] Connecting to Hannah Core: ${addr}`);
        // compat_interceptor (hannah-proto#9/hannah#217) laeuft additiv neben
        // protocolVersionInterceptor, nicht als Ersatz — ein Breaking Change,
        // der auf eine Message begrenzt ist, muss nicht mehr jeden Client
        // ablehnen, sondern nur Calls, die diese Message tatsaechlich nutzen.
        this.client = new hannah.HannahServiceClient(addr, grpc.credentials.createInsecure(), {
            interceptors: [protocolVersionInterceptor, compat_interceptor.compatVersionInterceptor],
        });
        this.stream = this.client.agentConnect();

        // For bidi streams with Python gRPC, the server does not send initial metadata,
        // so the 'metadata' event never fires. Trigger onConnected immediately — if the
        // server is unreachable we will get an 'error' event shortly after.
        this.log.info('[grpc] Connected to Hannah Core.');
        (this.onConnected() as unknown as Promise<void>).catch((e: Error) => {
            this.log.error(`[grpc] onConnected error: ${e.message}`);
        });

        this.stream.on('data', (cmd: agent.AgentCommand) => {
            this.onCommand(cmd);
        });

        this.stream.on('error', (err: Error) => {
            this.log.warn(`[grpc] Stream error: ${err.message}`);
            this._scheduleReconnect(host, port);
        });

        this.stream.on('end', () => {
            this.log.info('[grpc] Stream ended.');
            this.onDisconnected();
            this._scheduleReconnect(host, port);
        });
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
        try {
            this.stream.write(msg);
        } catch (e) {
            this.log.warn(`[grpc] Send failed: ${(e as Error).message}`);
        }
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
        try {
            this.stream?.end();
        } catch {
            /* ignore */
        }
        try {
            this.client?.close();
        } catch {
            /* ignore */
        }
    }
}
