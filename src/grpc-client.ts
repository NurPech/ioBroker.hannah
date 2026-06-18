import * as path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const PROTO_PATH = path.join(__dirname, 'proto', 'hannah.proto');

const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
});

const proto = grpc.loadPackageDefinition(packageDef) as any;

export type AgentMessageSender = (msg: object) => void;
export type CommandHandler = (cmd: object) => void;

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
    private client: any = null;
    private stream: any = null;
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
        this.client = new proto.hannah.HannahService(addr, grpc.credentials.createInsecure());
        this.stream = this.client.AgentConnect();

        // For bidi streams with Python gRPC, the server does not send initial metadata,
        // so the 'metadata' event never fires. Trigger onConnected immediately — if the
        // server is unreachable we will get an 'error' event shortly after.
        this.log.info('[grpc] Connected to Hannah Core.');
        (this.onConnected() as unknown as Promise<void>).catch((e: Error) => {
            this.log.error(`[grpc] onConnected error: ${e.message}`);
        });

        this.stream.on('data', (cmd: object) => {
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
     * Returns an array of satellite objects or an empty array on error.
     */
    getSatellites(): Promise<
        Array<{
            device_id: string;
            room: string;
            address: string;
            display_name?: string;
        }>
    > {
        return new Promise(resolve => {
            if (!this.client) {
                resolve([]);
                return;
            }
            this.client.GetSatellites({}, (err: Error | null, response: any) => {
                if (err || !response) {
                    this.log.warn(`[grpc] GetSatellites failed: ${err?.message ?? 'no response'}`);
                    resolve([]);
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
            this.client.ProvisionSatellite(
                { seed, display_name: displayName, room_id: roomId },
                (err: Error | null, response: any) => {
                    this._clearTimeout(timer);
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ ok: response.ok, message: response.message });
                    }
                },
            );
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
            this.client.Notify({ text, direct, severity }, (err: Error | null, response: any) => {
                this._clearTimeout(timer);
                if (err) {
                    reject(err);
                } else {
                    resolve({ ok: response.ok, message: response.message });
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
            this.client.TriggerFirmwareUpdate({ device }, (err: Error | null, response: any) => {
                this._clearTimeout(timer);
                if (err) {
                    reject(err);
                } else {
                    resolve({ ok: response.ok, message: response.message });
                }
            });
        });
    }

    /**
     * Send a message to Hannah Core.
     *
     * @param msg - Protobuf message object
     */
    send(msg: object): void {
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
