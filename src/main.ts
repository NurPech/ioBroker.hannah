import * as utils from '@iobroker/adapter-core';
import { GrpcClient } from './grpc-client';
import { StateWatcher } from './state-watcher';
import { ResidentsWatcher } from './residents';

class Hannah extends utils.Adapter {
    private grpc: GrpcClient | null = null;
    private states: StateWatcher | null = null;
    private residents: ResidentsWatcher | null = null;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'hannah' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /** @inheritdoc */
    private async onReady(): Promise<void> {
        await this.setObjectNotExistsAsync('info.connection', {
            type: 'state',
            common: {
                name: 'Connected to Hannah Core',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.setState('info.connection', false, true);

        const cfg = this.config;
        const host: string = cfg.hannahHost || '127.0.0.1';
        const port: number = cfg.hannahPort || 50051;

        const send = (msg: object): void => {
            this.grpc?.send(msg);
        };

        this.states = new StateWatcher(this, send, cfg.textCommandStateId || '', cfg.residentsInstance ? `residents.${cfg.residentsInstance}.` : 'residents.');
        this.residents = cfg.residentsInstance ? new ResidentsWatcher(this, send, cfg.residentsInstance) : null;

        this.grpc = new GrpcClient({
            log: this.log,
            onConnected: async () => {
                await this.setState('info.connection', true, true);
                await this.states!.start({
                    selectedRooms: cfg.selectedRooms || [],
                    selectedFunctions: cfg.selectedFunctions || [],
                    extraStatePrefixes: cfg.extraStatePrefixes || [],
                });
                await this.residents?.subscribe();
            },
            onDisconnected: async () => {
                await this.setState('info.connection', false, true);
                await this.states?.stop();
                await this.residents?.unsubscribe();
            },
            onCommand: (cmd: any) => {
                const which = Object.keys(cmd).find(k => k !== 'command' && cmd[k]);
                if (which === 'set_state' && cmd.set_state) {
                    void this.states?.handleSetState(cmd.set_state.state_id, cmd.set_state.value);
                } else if (which === 'watch_more' && cmd.watch_more?.state_ids) {
                    void this.states?.watchMore(cmd.watch_more.state_ids);
                }
            },
        });

        this.grpc.connect(host, port);
    }

    /** @inheritdoc */
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        this.residents?.onStateChange(id, state);
        this.states?.onStateChange(id, state);
    }

    /**
     * Is called when adapter shuts down — callback has to be called under any circumstances!
     *
     * @param callback - Callback function
     */
    private onUnload(callback: () => void): void {
        try {
            this.grpc?.disconnect();
            callback();
        } catch (e) {
            this.log.error(`Error during shutdown: ${(e as Error).message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Hannah(options);
} else {
    (() => new Hannah())();
}
