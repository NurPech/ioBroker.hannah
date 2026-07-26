import * as utils from '@iobroker/adapter-core';
import type { agent, control } from '@m1kad0/hannah-proto';
import { GrpcClient } from './grpc-client';
import { StateWatcher } from './state-watcher';
import { ResidentsWatcher } from './residents';
import { SatelliteWatcher } from './satellites';
import { MessagesHandler } from './messages';
import HannahDeviceManagement from './deviceManager';
import { BleWatcher } from './ble';
import { SensorWatcher } from './sensors';
import { FirmwareManager } from './firmware-manager';
import { updateSatelliteNvs } from './satellite-nvs';

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
                name: 'textCommand',
                type: 'string',
                role: 'text',
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
                role: 'text',
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
        await this.satellites.ensureVirtualRooms();
        this.ble = new BleWatcher(this);
        this.sensorWatcher = new SensorWatcher(this);
        this.dm = new HannahDeviceManagement(this);
        this.messages = new MessagesHandler(
            this,
            (text, direct, severity) => this.grpc!.notify(text, direct, severity),
            send,
            (text, opts) => this.grpc!.announce(text, opts),
            roomieId => this.grpc!.resolveRoomieUserId(roomieId),
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
                // Fetch existing satellites and create states. GetSatellites now returns every
                // satellite known to Core's DB, not just currently-connected ones — use
                // `connected` per-satellite instead of assuming every entry is online, and fall
                // back to the DB-assigned room for disconnected ones (their live `room` is empty).
                const sats = await this.grpc!.getSatellites();
                if (sats === null) {
                    // Connection dropped again right after onConnected fired, or the RPC itself
                    // failed — don't touch any satellite objects on unknown state, otherwise
                    // removeUnknownSatellites() below would delete every satellite as "stale".
                    this.log.warn('[satellites] GetSatellites unavailable — skipping satellite sync this cycle.');
                    return;
                }
                const effectiveRoom = (sat: control.Satellite): string =>
                    sat.connected ? sat.room : sat.roomDisplayName || sat.roomId || '';
                for (const sat of sats) {
                    await this.satellites!.handleSatelliteUpdate(
                        sat.deviceId,
                        effectiveRoom(sat),
                        sat.address,
                        sat.connected ?? false,
                        undefined,
                        undefined,
                        sat.displayName || undefined,
                        sat.lastSeen || undefined,
                        sat.roomMismatch,
                        sat.ownerDisplayName || '',
                    );
                }
                await this.satellites!.removeUnknownSatellites(
                    sats.map(sat => ({ deviceId: sat.deviceId, room: effectiveRoom(sat) })),
                );
            },
            onDisconnected: async () => {
                await this.setState('info.connection', false, true);
                await this.states?.stop();
                await this.residents?.unsubscribe();
                this.messages?.onDisconnected();
            },
            onCommand: (cmd: agent.AgentCommand) => {
                if (cmd.setState) {
                    void this.states?.handleSetState(cmd.setState.stateId, cmd.setState.value);
                } else if (cmd.setResident) {
                    const r = cmd.setResident;
                    void this.residents?.handleSetResident(r.residentId, r.presenceState, r.type);
                } else if (cmd.setResidentMood) {
                    const r = cmd.setResidentMood;
                    void this.residents?.handleSetResidentMood(r.residentId, r.mood, r.type);
                } else if (cmd.satelliteUpdate) {
                    const s = cmd.satelliteUpdate;
                    void this.satellites?.handleSatelliteUpdate(
                        s.deviceId,
                        s.room,
                        s.address,
                        s.online,
                        s.volume ?? undefined,
                        s.mute ?? undefined,
                        s.displayName || undefined,
                    );
                } else if (cmd.watchMore?.stateIds) {
                    void this.states?.watchMore(cmd.watchMore.stateIds);
                } else if (cmd.textAnswer) {
                    void this.setState('textAnswer', { val: cmd.textAnswer.text, ack: true });
                } else if (cmd.firmwareEvent) {
                    const fe = cmd.firmwareEvent;
                    if (fe.device && fe.version) {
                        void this.satellites?.handleFirmwareEvent(fe.device, fe.version, fe.updateAvailable);
                    }
                } else if (cmd.bleUpdate) {
                    const b = cmd.bleUpdate;
                    void this.ble?.handleBleUpdate(b.label, b.mac, b.room, b.satellite, b.rssi);
                } else if (cmd.sensorUpdate) {
                    const s = cmd.sensorUpdate;
                    void this.sensorWatcher?.handleSensorUpdate(
                        s.device,
                        s.temperature,
                        s.pressure,
                        s.humidity,
                        s.iaq,
                        s.iaqAccuracy,
                        s.co2Equiv,
                        s.vocEquiv,
                    );
                } else if (cmd.residentAnswered) {
                    this.messages?.onResidentAnswered(cmd.residentAnswered);
                } else if (cmd.satelliteDeleted) {
                    const d = cmd.satelliteDeleted;
                    void (async (): Promise<void> => {
                        await this.satellites?.deleteSatellite(d.deviceId, d.room);
                        await this.sensorWatcher?.deleteSensors(d.deviceId);
                        this.log.info(`[satellites] Deleted ${d.deviceId} (requested by Hannah Core)`);
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
        if (obj.command === 'updateSatelliteNvs') {
            const params = (obj.message ?? {}) as {
                deviceId?: string;
                values?: Record<string, string | number>;
            };
            const { deviceId, values } = params;
            if (!deviceId || !values || Object.keys(values).length === 0) {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: 'deviceId and values required' }, obj.callback);
                }
                return;
            }
            const token = this.config.satNvsToken || '';
            if (!token) {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: 'satNvsToken not configured' }, obj.callback);
                }
                return;
            }
            void (async (): Promise<void> => {
                try {
                    const satellites = await this.grpc!.getSatellites();
                    if (satellites === null) {
                        throw new Error('Not connected to Hannah Core');
                    }
                    const sat = satellites.find(s => s.deviceId === deviceId);
                    if (!sat) {
                        throw new Error(`Unknown satellite '${deviceId}'`);
                    }
                    if (!sat.connected || !sat.address) {
                        throw new Error(`Satellite '${deviceId}' is not connected`);
                    }
                    const ip = sat.address.split(':')[0];
                    this.log.info(
                        `[satellites] Pushing NVS update to '${deviceId}' (${ip}): ${Object.keys(values).join(', ')}`,
                    );
                    await updateSatelliteNvs(ip, token, values);
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
                    }
                } catch (err) {
                    this.log.warn(`[satellites] updateSatelliteNvs failed: ${(err as Error).message}`);
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, { error: (err as Error).message }, obj.callback);
                    }
                }
            })();
            return;
        }
        if (obj.command === 'setSatelliteDisplayName') {
            const params = (obj.message ?? {}) as { deviceId?: string; displayName?: string };
            const { deviceId, displayName } = params;
            if (!deviceId || !displayName) {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: 'deviceId and displayName required' }, obj.callback);
                }
                return;
            }
            const adminUserId = parseInt(this.config.adminUserId, 10);
            if (!adminUserId) {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: 'adminUserId not configured' }, obj.callback);
                }
                return;
            }
            void (async (): Promise<void> => {
                try {
                    const result = await this.grpc!.setSatelliteDisplayName(deviceId, displayName, adminUserId);
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, { ok: result.ok, message: result.message }, obj.callback);
                    }
                } catch (err) {
                    this.log.warn(`[satellites] setSatelliteDisplayName failed: ${(err as Error).message}`);
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
