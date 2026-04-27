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
}

/**
 * Manages the bidirectional gRPC stream connection to Hannah Core.
 * Automatically reconnects on error or stream end.
 */
export class GrpcClient {
    private client: any = null;
    private stream: any = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private onCommand: CommandHandler;
    private onConnected: () => void;
    private onDisconnected: () => void;
    private log: LogAdapter;

    /**
     * @param opts - Configuration options including callbacks and logger
     */
    constructor(opts: GrpcClientOptions) {
        this.onCommand = opts.onCommand;
        this.onConnected = opts.onConnected;
        this.onDisconnected = opts.onDisconnected;
        this.log = opts.log;
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
        const addr = `${host}:${port}`;
        this.log.info(`[grpc] Connecting to Hannah Core: ${addr}`);
        this.client = new proto.hannah.HannahService(addr, grpc.credentials.createInsecure());
        this.stream = this.client.AgentConnect();

        // metadata fires when the server accepts the stream — this is the right "connected" signal
        this.stream.on('metadata', () => {
            this.log.info('[grpc] Connected to Hannah Core.');
            (this.onConnected() as unknown as Promise<void>).catch((e: Error) => {
                this.log.error(`[grpc] onConnected error: ${e.message}`);
            });
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
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this._connect(host, port);
        }, 10_000);
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
            clearTimeout(this.reconnectTimer);
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
