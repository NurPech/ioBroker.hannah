import type * as utils from '@iobroker/adapter-core';
import type { AgentMessageSender, GrpcClient } from './grpc-client';

/**
 * Manages satellite states under hannah.<instance>.satellites.rooms.<room>.
 * Room-level states (dnd, mute, volume, speaking, …) are shared across all
 * satellites in a room. Per-satellite online state lives at
 * satellites.rooms.<room>.<deviceId>.online.
 */
export class SatelliteWatcher {
    private adapter: utils.AdapterInstance;
    private send: AgentMessageSender;
    private getGrpc: () => GrpcClient | null;
    private deviceRooms: Map<string, string> = new Map();

    /**
     * @param adapter - ioBroker adapter instance
     * @param send - Sends AgentMessage frames to Hannah Core via gRPC
     * @param getGrpc - Lazy getter for the gRPC client (resolves after construction)
     */
    constructor(adapter: utils.AdapterInstance, send: AgentMessageSender, getGrpc: () => GrpcClient | null) {
        this.adapter = adapter;
        this.send = send;
        this.getGrpc = getGrpc;
    }

    /**
     * Called when Hannah pushes a satellite registered/gone event, or on
     * initial connect when existing satellites are fetched via GetSatellites.
     *
     * @param deviceId - Satellite device ID
     * @param room - Room the satellite is assigned to
     * @param _address - UDP address (may be empty, reserved for future use)
     * @param online - true = registered, false = gone
     */
    async handleSatelliteUpdate(
        deviceId: string,
        room: string,
        _address: string,
        online: boolean,
        volume?: number,
        mute?: boolean,
    ): Promise<void> {
        if (!room && !online) {
            // Gone event without room info — find and clear the satellite's online states
            this.adapter.log.info(`[satellites] Satellite gone: ${deviceId}`);
            await this._setSatelliteOnline(deviceId, '', false);
            return;
        }
        if (online) {
            this.deviceRooms.set(deviceId.toLowerCase(), room);
        } else {
            this.deviceRooms.delete(deviceId.toLowerCase());
        }
        await this._ensureRoomStates(room);
        await this._ensureSatelliteStates(deviceId, room);
        await this._setSatelliteOnline(deviceId, room, online);
        if (volume !== undefined) {
            await this.adapter.setState(`satellites.rooms.${room}.${deviceId}.volume`, { val: volume, ack: true });
        }
        if (mute !== undefined) {
            await this.adapter.setState(`satellites.rooms.${room}.${deviceId}.mute`, { val: mute, ack: true });
        }
        if (online) {
            this.adapter.log.info(`[satellites] Satellite online: ${deviceId} in room '${room}'`);
        } else {
            this.adapter.log.info(`[satellites] Satellite offline: ${deviceId} in room '${room}'`);
        }
        await this._updateAnyOnline(room);
    }

    /**
     * Called when Hannah pushes a satellite.firmware event.
     *
     * @param deviceId - Satellite device ID
     * @param version - Firmware version string
     * @param updateAvailable - true = newer version pending, false = current version report
     */
    async handleFirmwareEvent(deviceId: string, version: string, updateAvailable?: boolean): Promise<void> {
        const room = this.deviceRooms.get(deviceId.toLowerCase());
        if (!room) {
            this.adapter.log.debug(`[satellites] firmware event for unknown device ${deviceId} — ignored`);
            return;
        }
        const base = `satellites.rooms.${room}.${deviceId}`;
        await this.adapter.setState(`${base}.firmware_version`, { val: version, ack: true });
        if (updateAvailable !== undefined) {
            await this.adapter.setState(`${base}.update_available`, { val: updateAvailable, ack: true });
        }
        this.adapter.log.info(
            `[satellites] Firmware: ${deviceId} = ${version}${updateAvailable ? ' (update available)' : ''}`,
        );
    }

    /**
     * Called from onStateChange when a satellite-related state changes in ioBroker.
     * Forwards writable room states (dnd, mute, volume, announcement) to Hannah Core.
     *
     * @param id - State ID that changed
     * @param state - New state value, or null/undefined if deleted
     */
    onStateChange(id: string, state: ioBroker.State | null | undefined): boolean {
        if (!state || state.val === null || state.ack) {
            return false;
        }
        // Match: hannah.<instance>.satellites.rooms.<room>.<deviceId>.<key>  (per-satellite)
        const perSatMatch = id.match(
            new RegExp(
                `^${this.adapter.namespace.replace('.', '\\.')}\\.satellites\\.rooms\\.([^.]+)\\.([^.]+)\\.([^.]+)$`,
            ),
        );
        if (perSatMatch) {
            const [, room, deviceId, key] = perSatMatch;
            if (key === 'update_now' && state.val === true) {
                void this.adapter.setState(id, { val: false, ack: true });
                void this.getGrpc()
                    ?.triggerFirmwareUpdate(deviceId)
                    .then(res => {
                        this.adapter.log.info(`[satellites] TriggerFirmwareUpdate ${deviceId}: ${res.message ?? 'ok'}`);
                    })
                    .catch(err => {
                        this.adapter.log.warn(`[satellites] TriggerFirmwareUpdate ${deviceId} failed: ${err.message}`);
                    });
            } else if (key === 'volume' || key === 'mute') {
                this.send({ satellite_control: { room, device_id: deviceId, [key]: state.val } });
                this.adapter.log.debug(
                    `[satellites] satellite_control device='${deviceId}' room='${room}' ${key}=${state.val}`,
                );
            }
            return true;
        }

        // Match: hannah.<instance>.satellites.rooms.<room>.<key>  (room-level)
        const match = id.match(
            new RegExp(`^${this.adapter.namespace.replace('.', '\\.')}\\.satellites\\.rooms\\.([^.]+)\\.([^.]+)$`),
        );
        if (!match) {
            return false;
        }
        const room = match[1];
        const key = match[2];
        const writableKeys = ['dnd', 'announcement', 'announcementSsml'];
        const resetKeys = ['announcement', 'announcementSsml'];
        if (!writableKeys.includes(key)) {
            return false;
        }
        this.send({ satellite_control: { room, [key]: state.val } });
        if (resetKeys.includes(key)) {
            void this.adapter.setState(id, { val: '', ack: true });
        }
        this.adapter.log.debug(`[satellites] satellite_control room='${room}' ${key}=${state.val}`);
        return true;
    }

    private async _ensureRoomStates(room: string): Promise<void> {
        const base = `satellites.rooms.${room}`;
        await this.adapter.setObjectNotExistsAsync(base, {
            type: 'channel',
            common: { name: `Room ${room}` },
            native: {},
        });
        const states: Array<[string, ioBroker.StateCommon]> = [
            ['announcement', { name: 'Announcement', type: 'string', role: 'text', read: true, write: true, def: '' }],
            [
                'announcementSsml',
                { name: 'Announcement (SSML)', type: 'string', role: 'text', read: true, write: true, def: '' },
            ],
            [
                'anyOnline',
                {
                    name: 'Any satellite online',
                    type: 'boolean',
                    role: 'indicator.connected',
                    read: true,
                    write: false,
                    def: false,
                },
            ],
            ['dnd', { name: 'Do not disturb', type: 'boolean', role: 'switch', read: true, write: true, def: false }],
            [
                'speaking',
                {
                    name: 'Hannah is speaking',
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                    def: false,
                },
            ],
            [
                'lastTranscript',
                { name: 'Last transcript', type: 'string', role: 'text', read: true, write: false, def: '' },
            ],
        ];
        for (const [key, common] of states) {
            await this.adapter.setObjectNotExistsAsync(`${base}.${key}`, {
                type: 'state',
                common: common,
                native: {},
            });
        }
    }

    private async _ensureSatelliteStates(deviceId: string, room: string): Promise<void> {
        const base = `satellites.rooms.${room}.${deviceId}`;
        await this.adapter.setObjectNotExistsAsync(base, {
            type: 'device',
            common: { name: `Satellite ${deviceId}` },
            native: {},
        });
        await this.adapter.setObjectNotExistsAsync(`${base}.online`, {
            type: 'state',
            common: {
                name: 'Satellite online',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.adapter.setObjectNotExistsAsync(`${base}.firmware_version`, {
            type: 'state',
            common: {
                name: 'Firmware version',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        });
        await this.adapter.setObjectNotExistsAsync(`${base}.update_available`, {
            type: 'state',
            common: {
                name: 'Firmware update available',
                type: 'boolean',
                role: 'indicator.update',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.adapter.setObjectNotExistsAsync(`${base}.update_now`, {
            type: 'state',
            common: {
                name: 'Update firmware now',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                def: false,
            },
            native: {},
        });
        await this.adapter.setObjectNotExistsAsync(`${base}.volume`, {
            type: 'state',
            common: {
                name: 'Volume (0–100)',
                type: 'number',
                role: 'level.volume',
                read: true,
                write: true,
                def: 80,
                min: 0,
                max: 100,
            },
            native: {},
        });
        await this.adapter.setObjectNotExistsAsync(`${base}.mute`, {
            type: 'state',
            common: {
                name: 'Mute microphone',
                type: 'boolean',
                role: 'switch',
                read: true,
                write: true,
                def: false,
            },
            native: {},
        });
    }

    private async _setSatelliteOnline(deviceId: string, room: string, online: boolean): Promise<void> {
        if (!room) {
            return;
        }
        await this.adapter.setState(`satellites.rooms.${room}.${deviceId}.online`, { val: online, ack: true });
    }

    private async _updateAnyOnline(room: string): Promise<void> {
        // Read all <deviceId>.online states under this room and compute anyOnline
        const pattern = `${this.adapter.namespace}.satellites.rooms.${room}.*.online`;
        const states = await this.adapter.getForeignStatesAsync(pattern);
        const anyOnline = Object.values(states).some(s => s?.val === true);
        await this.adapter.setState(`satellites.rooms.${room}.anyOnline`, { val: anyOnline, ack: true });
    }
}
