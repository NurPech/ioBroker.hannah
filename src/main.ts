import * as utils from '@iobroker/adapter-core';
import { GrpcClient } from './grpc-client';
import { StateWatcher } from './state-watcher';
import { ResidentsWatcher } from './residents';
import { SatelliteWatcher } from './satellites';
import { MessagesHandler } from './messages';
import HannahDeviceManagement from './deviceManager';
import { BleWatcher } from './ble';
import { SensorWatcher } from './sensors';
import { FirmwareManager } from './firmware-manager';

class Hannah extends utils.Adapter {
    private grpc: GrpcClient | null = null;
    private states: StateWatcher | null = null;
    private residents: ResidentsWatcher | null = null;
    private satellites: SatelliteWatcher | null = null;
    private messages: MessagesHandler | null = null;
    private dm: HannahDeviceManagement | null = null;
    private ble: BleWatcher | null = null;
    private sensorWatcher: SensorWatcher | null = null;
    private enumReloadTimer: ioBroker.Timeout | null | undefined = null;

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
        await this.setObjectNotExistsAsync('info', {
            type: 'channel',
            common: { name: 'Information' },
            native: {},
        });
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
        this.satellites = new SatelliteWatcher(this, send, () => this.grpc);
        this.ble = new BleWatcher(this);
        this.sensorWatcher = new SensorWatcher(this);
        this.dm = new HannahDeviceManagement(this);
        this.messages = new MessagesHandler(
            this,
            (text, direct, severity) => this.grpc!.notify(text, direct, severity),
            send,
        );

        this.grpc = new GrpcClient({
            log: this.log,
            setTimeout: (fn, ms) => this.setTimeout(fn, ms) ?? 0,
            clearTimeout: t => this.clearTimeout(t as ioBroker.Timeout),
            onConnected: async () => {
                await this.setState('info.connection', true, true);
                await this.states!.start({
                    selectedRooms: cfg.selectedRooms || [],
                    selectedFunctions: cfg.selectedFunctions || [],
                    extraStatePrefixes: cfg.extraStatePrefixes || [],
                    floorMappings: cfg.floorMappings || [],
                });
                await this.residents?.subscribe();
                await this.subscribeStatesAsync('satellites.rooms.*');
                await this.subscribeForeignObjectsAsync('enum.rooms.*');
                await this.subscribeForeignObjectsAsync('enum.functions.*');
                // Fetch existing satellites and create states
                const sats = await this.grpc!.getSatellites();
                for (const sat of sats) {
                    await this.satellites!.handleSatelliteUpdate(
                        sat.device_id,
                        sat.room,
                        sat.address,
                        true,
                        undefined,
                        undefined,
                        sat.display_name || undefined,
                    );
                }
                await this.satellites!.markUnknownOffline(sats);
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
                    void this.residents?.handleSetResident(r.resident_id, r.presence_state, r.type);
                } else if (which === 'set_resident_mood' && cmd.set_resident_mood) {
                    const r = cmd.set_resident_mood;
                    void this.residents?.handleSetResidentMood(r.resident_id, r.mood, r.type);
                } else if (which === 'satellite_update' && cmd.satellite_update) {
                    const s = cmd.satellite_update;
                    void this.satellites?.handleSatelliteUpdate(
                        s.device_id,
                        s.room,
                        s.address,
                        s.online,
                        s.volume ?? undefined,
                        s.mute ?? undefined,
                        s.display_name || undefined,
                    );
                } else if (which === 'watch_more' && cmd.watch_more?.state_ids) {
                    void this.states?.watchMore(cmd.watch_more.state_ids);
                } else if (which === 'text_answer' && cmd.text_answer) {
                    void this.setState('textAnswer', { val: cmd.text_answer.text, ack: true });
                } else if (which === 'firmware_event' && cmd.firmware_event) {
                    const fe = cmd.firmware_event;
                    if (fe.device && fe.version) {
                        void this.satellites?.handleFirmwareEvent(fe.device, fe.version, fe.update_available);
                    }
                } else if (which === 'ble_update' && cmd.ble_update) {
                    const b = cmd.ble_update;
                    void this.ble?.handleBleUpdate(b.label, b.mac, b.room, b.satellite, b.rssi);
                } else if (which === 'sensor_update' && cmd.sensor_update) {
                    const s = cmd.sensor_update;
                    void this.sensorWatcher?.handleSensorUpdate(
                        s.device,
                        s.temperature,
                        s.pressure,
                        s.humidity,
                        s.iaq,
                        s.iaq_accuracy,
                        s.co2_equiv,
                        s.voc_equiv,
                    );
                } else if (which === 'resident_answered' && cmd.resident_answered) {
                    this.messages?.onResidentAnswered(cmd.resident_answered);
                } else if (which === 'satellite_deleted' && cmd.satellite_deleted) {
                    const d = cmd.satellite_deleted;
                    void (async (): Promise<void> => {
                        await this.satellites?.deleteSatellite(d.device_id, d.room);
                        await this.sensorWatcher?.deleteSensors(d.device_id);
                        this.log.info(`[satellites] Deleted ${d.device_id} (requested by Hannah Core)`);
                    })();
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
        if (id.startsWith('enum.rooms.') || id.startsWith('enum.functions.')) {
            this.log.info(`[enums] Change detected on ${id} — reloading in 5s`);
            if (this.enumReloadTimer) {
                this.clearTimeout(this.enumReloadTimer);
            }
            this.enumReloadTimer = this.setTimeout(() => {
                this.enumReloadTimer = null;
                void this._reloadEnums();
            }, 5_000);
        } else if (id.startsWith('residents.')) {
            this.residents?.onObjectChange(id);
        }
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
            floorMappings: cfg.floorMappings || [],
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
        if (obj.command === 'getFirmwareFiles') {
            this.log.debug(`[firmware] getFirmwareFiles request from ${obj.from}`);
            const url: string = this.config.firmwareSourceUrl || '';
            const token: string = this.config.firmwareSourceToken || '';
            if (!url) {
                this.log.warn('[firmware] No firmware source URL configured');
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: 'No firmware source URL configured' }, obj.callback);
                }
                return;
            }
            this.log.info(`[firmware] Downloading firmware from ${url}`);
            const mgr = new FirmwareManager(url, token || undefined);
            mgr.getFirmwareFiles()
                .then(result => {
                    this.log.info(`[firmware] Firmware ready: ${result.version} (${result.files.length} files)`);
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, result, obj.callback);
                    }
                })
                .catch((err: Error) => {
                    this.log.warn(`[firmware] getFirmwareFiles failed: ${err.message}`);
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, { error: err.message }, obj.callback);
                    }
                });
            return;
        }
        if (obj.command === 'provisionSatellite') {
            const params = (obj.message ?? {}) as { seed?: string; displayName?: string; roomId?: string };
            const { seed, displayName, roomId } = params;
            if (!seed || !displayName) {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: 'seed and displayName required' }, obj.callback);
                }
                return;
            }
            this.log.info(
                `[satellites] Provisioning satellite '${displayName}'${roomId ? ` in room '${roomId}'` : ''}`,
            );
            void (async (): Promise<void> => {
                try {
                    const result = await this.grpc!.provisionSatellite(seed, displayName, roomId);
                    this.log.info(`[satellites] Provisioned '${displayName}': ${result.message ?? 'ok'}`);
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, { ok: result.ok, message: result.message }, obj.callback);
                    }
                } catch (err) {
                    this.log.warn(`[satellites] provisionSatellite failed: ${(err as Error).message}`);
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, { error: (err as Error).message }, obj.callback);
                    }
                }
            })();
            return;
        }
        this.messages?.onMessage(obj);
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Hannah(options);
} else {
    (() => new Hannah())();
}
