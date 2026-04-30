import * as utils from '@iobroker/adapter-core';
import { GrpcClient } from './grpc-client';
import { StateWatcher } from './state-watcher';
import { ResidentsWatcher } from './residents';
import { SatelliteWatcher } from './satellites';
import { MessagesHandler } from './messages';

class Hannah extends utils.Adapter {
    private grpc: GrpcClient | null = null;
    private states: StateWatcher | null = null;
    private residents: ResidentsWatcher | null = null;
    private satellites: SatelliteWatcher | null = null;
    private messages: MessagesHandler | null = null;
    private enumReloadTimer: ReturnType<typeof setTimeout> | null = null;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'hannah' });
        this.on('ready', this.onReady.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
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
        await this.setObjectNotExistsAsync('textCommand', {
            type: 'state',
            common: {
                name: 'textConmand',
                type: 'string',
                role: 'state',
                read: true,
                write: true,
                def: '',
            },
            native: {},
        });
        await this.setObjectNotExistsAsync('textAnswer', {
            type: 'state',
            common: {
                name: 'textAnswer',
                type: 'string',
                role: 'state',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        });
        await this.setObjectNotExistsAsync('satellites', {
            type: 'folder',
            common: {
                name: 'satellites',
            },
            native: {},
        });
        await this.setObjectNotExistsAsync('satellites.rooms', {
            type: 'folder',
            common: {
                name: 'rooms',
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

        this.states = new StateWatcher(this, send);
        this.residents = cfg.residentsInstance ? new ResidentsWatcher(this, send, cfg.residentsInstance) : null;
        this.satellites = new SatelliteWatcher(this, send);
        this.messages = new MessagesHandler(this, (text, direct, severity) =>
            this.grpc!.notify(text, direct, severity),
        );

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
                await this.subscribeStatesAsync('satellites.rooms.*');
                await this.subscribeForeignObjectsAsync('enum.rooms.*');
                await this.subscribeForeignObjectsAsync('enum.functions.*');
                // Fetch existing satellites and create states
                const sats = await this.grpc!.getSatellites();
                for (const sat of sats) {
                    await this.satellites!.handleSatelliteUpdate(sat.device_id, sat.room, sat.address, true);
                }
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
                } else if (which === 'set_resident' && cmd.set_resident) {
                    const r = cmd.set_resident;
                    void this.residents?.handleSetResident(r.resident_id, r.presence_state, r.is_guest);
                } else if (which === 'satellite_update' && cmd.satellite_update) {
                    const s = cmd.satellite_update;
                    void this.satellites?.handleSatelliteUpdate(s.device_id, s.room, s.address, s.online);
                } else if (which === 'watch_more' && cmd.watch_more?.state_ids) {
                    void this.states?.watchMore(cmd.watch_more.state_ids);
                } else if (which === 'text_answer' && cmd.text_answer) {
                    void this.setStateAsync('textAnswer', { val: cmd.text_answer.text, ack: true });
                }
            },
        });

        this.grpc.connect(host, port);
    }

    /** @inheritdoc */
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        this.residents?.onStateChange(id, state);
        this.states?.onStateChange(id, state);
        this.satellites?.onStateChange(id, state);
    }

    /**
     * Schedules a debounced enum reload when room or function enums change.
     *
     * @param id - Object ID that changed
     * @param _obj - New object value (unused)
     */
    private onObjectChange(id: string, _obj: ioBroker.Object | null | undefined): void {
        if (!id.startsWith('enum.rooms.') && !id.startsWith('enum.functions.')) {
            return;
        }
        if (this.enumReloadTimer) {
            clearTimeout(this.enumReloadTimer);
        }
        this.enumReloadTimer = setTimeout(() => {
            this.enumReloadTimer = null;
            void this._reloadEnums();
        }, 5_000);
        this.log.info(`[enums] Change detected on ${id} — reloading in 5s`);
    }

    /** Reload enum subscriptions after a configuration change. */
    private async _reloadEnums(): Promise<void> {
        if (!this.states) {
            return;
        }
        this.log.info('[enums] Reloading enum subscriptions...');
        const cfg = this.config;
        await this.states.stop();
        await this.states.start({
            selectedRooms: cfg.selectedRooms || [],
            selectedFunctions: cfg.selectedFunctions || [],
            extraStatePrefixes: cfg.extraStatePrefixes || [],
        });
        this.log.info('[enums] Reload complete.');
    }

    /**
     * Is called when adapter shuts down — callback has to be called under any circumstances!
     *
     * @param callback - Callback function
     */
    private onUnload(callback: () => void): void {
        try {
            if (this.enumReloadTimer) {
                clearTimeout(this.enumReloadTimer);
            }
            this.grpc?.disconnect();
            callback();
        } catch (e) {
            this.log.error(`Error during shutdown: ${(e as Error).message}`);
            callback();
        }
    }

    public onMessage(obj: ioBroker.Message): void {
        this.messages?.onMessage(obj);
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Hannah(options);
} else {
    (() => new Hannah())();
}
