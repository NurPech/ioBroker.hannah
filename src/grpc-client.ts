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

export class GrpcClient {
    private client: any = null;
    private stream: any = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private onCommand: CommandHandler;
    private onConnected: () => void;
    private onDisconnected: () => void;
    private log: {
        info: (s: string) => void;
        warn: (s: string) => void;
        error: (s: string) => void;
        debug: (s: string) => void;
    };

    constructor(opts: {
        onCommand: CommandHandler;
        onConnected: () => void;
        onDisconnected: () => void;
        log: {
            info: (s: string) => void;
            warn: (s: string) => void;
            error: (s: string) => void;
            debug: (s: string) => void;
        };
    }) {
        this.onCommand = opts.onCommand;
        this.onConnected = opts.onConnected;
        this.onDisconnected = opts.onDisconnected;
        this.log = opts.log;
    }

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
