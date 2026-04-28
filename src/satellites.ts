import type * as utils from '@iobroker/adapter-core';
import type { AgentMessageSender } from './grpc-client';

/**
 * Manages satellite states under hannah.<instance>.satellites.rooms.<room>.
 * Room-level states (dnd, mute, volume, speaking, …) are shared across all
 * satellites in a room. Per-satellite online state lives at
 * satellites.rooms.<room>.<deviceId>.online.
 */
export class SatelliteWatcher {
    private adapter: utils.AdapterInstance;

    /**
     * @param adapter - ioBroker adapter instance
     * @param _send - Reserved for future satellite_control gRPC messages (0.0.3)
     */
    constructor(adapter: utils.AdapterInstance, _send: AgentMessageSender) {
        this.adapter = adapter;
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
    async handleSatelliteUpdate(deviceId: string, room: string, _address: string, online: boolean): Promise<void> {
        if (!room && !online) {
            // Gone event without room info — find and clear the satellite's online states
            this.adapter.log.info(`[satellites] Satellite gone: ${deviceId}`);
            await this._setSatelliteOnline(deviceId, '', false);
            return;
        }
        await this._ensureRoomStates(room);
        await this._ensureSatelliteStates(deviceId, room);
        await this._setSatelliteOnline(deviceId, room, online);
        if (online) {
            this.adapter.log.info(`[satellites] Satellite online: ${deviceId} in room '${room}'`);
        } else {
            this.adapter.log.info(`[satellites] Satellite offline: ${deviceId} in room '${room}'`);
        }
        await this._updateAnyOnline(room);
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
        // Match: hannah.<instance>.satellites.rooms.<room>.<key>
        const match = id.match(
            new RegExp(`^${this.adapter.namespace.replace('.', '\\.')}\\.satellites\\.rooms\\.([^.]+)\\.([^.]+)$`),
        );
        if (!match) {
            return false;
        }
        const room = match[1];
        const key = match[2];
        const writableKeys = ['dnd', 'mute', 'volume', 'announcement', 'announcementSsml'];
        if (!writableKeys.includes(key)) {
            return false;
        }
        // TODO 0.0.3: send satellite_control via gRPC once proto message is defined
        this.adapter.log.debug(
            `[satellites] room '${room}' ${key} = ${state.val} (satellite_control not yet in proto)`,
        );
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
            ['mute', { name: 'Mute microphone', type: 'boolean', role: 'switch', read: true, write: true, def: false }],
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
            [
                'volume',
                {
                    name: 'Volume (0–100)',
                    type: 'number',
                    role: 'level.volume',
                    read: true,
                    write: true,
                    def: 80,
                    min: 0,
                    max: 100,
                },
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
            type: 'channel',
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
    }

    private async _setSatelliteOnline(deviceId: string, room: string, online: boolean): Promise<void> {
        if (!room) {
            return;
        }
        await this.adapter.setStateAsync(`satellites.rooms.${room}.${deviceId}.online`, { val: online, ack: true });
    }

    private async _updateAnyOnline(room: string): Promise<void> {
        // Read all <deviceId>.online states under this room and compute anyOnline
        const pattern = `${this.adapter.namespace}.satellites.rooms.${room}.*.online`;
        const states = await this.adapter.getForeignStatesAsync(pattern);
        const anyOnline = Object.values(states).some(s => s?.val === true);
        await this.adapter.setStateAsync(`satellites.rooms.${room}.anyOnline`, { val: anyOnline, ack: true });
    }
}
