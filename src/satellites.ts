import type * as utils from '@iobroker/adapter-core';
import type { AgentMessageSender, GrpcClient } from './grpc-client';

function sanitizeId(name: string): string {
    return name.replace(/[^a-zA-Z0-9_,-]/g, '_');
}

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
    private deviceRooms: Map<string, string> = new Map(); // deviceId.lower → room
    private roomNames: Map<string, string> = new Map(); // sanitizeId(room).toLowerCase() → original room
    private deviceToObjectKey: Map<string, string> = new Map(); // deviceId.lower → objectKey (== deviceId since v0.34)
    private objectKeyToDeviceId: Map<string, string> = new Map(); // objectKey.lower → deviceId

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
     * Deletes a satellite's full object tree. If it was the last satellite
     * (device) in its room, the room container — including the shared
     * room-level states (dnd, announcement, …) — is removed too, so empty
     * rooms don't linger in the object database forever.
     *
     * @param objectKey - Satellite device ID (raw, unsanitized)
     * @param room - Room the satellite is assigned to (raw name)
     * @returns true if the (now empty) room container was also removed
     */
    async deleteSatellite(objectKey: string, room: string): Promise<boolean> {
        const roomBase = `satellites.rooms.${sanitizeId(room)}`;
        const satBase = `${roomBase}.${sanitizeId(objectKey)}`;

        await this.adapter.delObjectAsync(satBase, { recursive: true });
        const deviceId = this.objectKeyToDeviceId.get(objectKey.toLowerCase()) ?? objectKey;
        this.deviceRooms.delete(deviceId.toLowerCase());
        this.deviceToObjectKey.delete(deviceId.toLowerCase());
        this.objectKeyToDeviceId.delete(objectKey.toLowerCase());

        // Remove the room container only if no satellite (device) remains in it.
        // Room-level states are not of type 'device', so they don't count.
        const prefix = `${this.adapter.namespace}.${roomBase}.`;
        const remaining = await this.adapter.getForeignObjectsAsync(`${prefix}*`, 'device');
        if (Object.keys(remaining ?? {}).length === 0) {
            await this.adapter.delObjectAsync(roomBase, { recursive: true });
            this.roomNames.delete(sanitizeId(room).toLowerCase());
            return true;
        }
        return false;
    }

    /**
     * Called when Hannah pushes a satellite registered/gone event, or on
     * initial connect when existing satellites are fetched via GetSatellites.
     *
     * @param deviceId - Satellite device ID (human-readable, used as display name)
     * @param room - Room the satellite is assigned to
     * @param address - UDP address (IP:port); IP is stored as satellite state
     * @param online - true = registered, false = gone
     * @param volume - Current volume level (0–100), if reported
     * @param mute - Current mute state, if reported
     * @param displayName - Optional satellite display name (for object naming); falls back to deviceId if not provided
     * @param lastSeen - UTC timestamp (Core DB format) of the last time this satellite was seen, if known
     * @param roomMismatch - true if the satellite is currently reporting a different room than assigned
     * @param ownerDisplayName - Display name of the Person (User) this satellite is assigned to, if any (#31)
     */
    async handleSatelliteUpdate(
        deviceId: string,
        room: string,
        address: string,
        online: boolean,
        volume?: number,
        mute?: boolean,
        displayName?: string,
        lastSeen?: string,
        roomMismatch?: boolean,
        ownerDisplayName?: string,
    ): Promise<void> {
        const objectKey = deviceId;

        if (!room && !online) {
            // Gone event without room info — find and clear the satellite's online states
            this.adapter.log.info(`[satellites] Satellite gone: ${deviceId}`);
            const storedKey = this.deviceToObjectKey.get(deviceId.toLowerCase()) ?? deviceId;
            await this._setSatelliteOnline(storedKey, '', false);
            return;
        }
        if (!room && online) {
            this.adapter.log.warn(`[satellites] Satellite ${deviceId} has no room assigned — skipping state creation`);
            return;
        }
        if (online) {
            this.deviceRooms.set(deviceId.toLowerCase(), room);
            this.deviceToObjectKey.set(deviceId.toLowerCase(), objectKey);
            this.objectKeyToDeviceId.set(objectKey.toLowerCase(), deviceId);
            this.roomNames.set(sanitizeId(room).toLowerCase(), room);
        } else {
            const prevKey = this.deviceToObjectKey.get(deviceId.toLowerCase());
            this.deviceRooms.delete(deviceId.toLowerCase());
            this.deviceToObjectKey.delete(deviceId.toLowerCase());
            if (prevKey) {
                this.objectKeyToDeviceId.delete(prevKey.toLowerCase());
            }
        }
        await this._ensureRoomStates(room);
        await this._ensureSatelliteStates(objectKey, room, displayName || deviceId);
        await this._setSatelliteOnline(objectKey, room, online);
        if (online && address) {
            const ip = address.split(':')[0];
            await this.adapter.setState(`satellites.rooms.${sanitizeId(room)}.${sanitizeId(objectKey)}.address`, {
                val: ip,
                ack: true,
            });
        }
        if (volume !== undefined) {
            await this.adapter.setState(`satellites.rooms.${sanitizeId(room)}.${sanitizeId(objectKey)}.volume`, {
                val: volume,
                ack: true,
            });
        }
        if (mute !== undefined) {
            await this.adapter.setState(`satellites.rooms.${sanitizeId(room)}.${sanitizeId(objectKey)}.mute`, {
                val: mute,
                ack: true,
            });
        }
        if (lastSeen !== undefined) {
            await this.adapter.setState(`satellites.rooms.${sanitizeId(room)}.${sanitizeId(objectKey)}.last_seen`, {
                val: lastSeen,
                ack: true,
            });
        }
        if (roomMismatch !== undefined) {
            await this.adapter.setState(`satellites.rooms.${sanitizeId(room)}.${sanitizeId(objectKey)}.room_mismatch`, {
                val: roomMismatch,
                ack: true,
            });
        }
        if (ownerDisplayName !== undefined) {
            await this.adapter.setState(`satellites.rooms.${sanitizeId(room)}.${sanitizeId(objectKey)}.owner`, {
                val: ownerDisplayName,
                ack: true,
            });
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
        const objectKey = this.deviceToObjectKey.get(deviceId.toLowerCase()) ?? deviceId;
        const base = `satellites.rooms.${sanitizeId(room)}.${sanitizeId(objectKey)}`;
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
            const [, roomId, objectKeyId, key] = perSatMatch;
            const originalRoom = this.roomNames.get(roomId.toLowerCase()) ?? roomId;
            const actualDeviceId = this.objectKeyToDeviceId.get(objectKeyId.toLowerCase()) ?? objectKeyId;
            if (key === 'update_now' && state.val === true) {
                void this.adapter.setState(id, { val: false, ack: true });
                void this.getGrpc()
                    ?.triggerFirmwareUpdate(actualDeviceId)
                    .then(res => {
                        this.adapter.log.info(
                            `[satellites] TriggerFirmwareUpdate ${actualDeviceId}: ${res.message ?? 'ok'}`,
                        );
                    })
                    .catch(err => {
                        this.adapter.log.warn(
                            `[satellites] TriggerFirmwareUpdate ${actualDeviceId} failed: ${err.message}`,
                        );
                    });
            } else if (key === 'volume' || key === 'mute') {
                this.send({ satelliteControl: { room: originalRoom, deviceId: actualDeviceId, [key]: state.val } });
                this.adapter.log.debug(
                    `[satellites] satellite_control device='${actualDeviceId}' room='${originalRoom}' ${key}=${state.val}`,
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
        const roomId = match[1];
        const key = match[2];
        const originalRoom = this.roomNames.get(roomId.toLowerCase()) ?? roomId;
        const writableKeys = ['dnd', 'mute', 'announcement', 'announcementSsml', 'announcementRephrase'];
        const resetKeys = ['announcement', 'announcementSsml', 'announcementRephrase'];
        if (!writableKeys.includes(key)) {
            return false;
        }
        this.send({ satelliteControl: { room: originalRoom, deviceId: '', [key]: state.val } });
        if (resetKeys.includes(key)) {
            void this.adapter.setState(id, { val: '', ack: true });
        }
        this.adapter.log.debug(`[satellites] satellite_control room='${originalRoom}' ${key}=${state.val}`);
        return true;
    }

    /**
     * Creates the static virtual "all" room used for broadcast control. Core already
     * resolves room == "all" to every connected satellite (see AgentSatelliteControl in
     * hannah.proto), so this only needs adapter-side state objects. Unlike real rooms,
     * it isn't tied to any satellite — created once at startup, never removed by
     * deleteSatellite's empty-room cleanup.
     */
    async ensureVirtualRooms(): Promise<void> {
        const base = 'satellites.rooms.all';
        await this.adapter.setObjectNotExistsAsync(base, {
            type: 'folder',
            common: { name: 'Alle' },
            native: {},
        });
        const states: Array<[string, ioBroker.StateCommon]> = [
            ['announcement', { name: 'Announcement', type: 'string', role: 'text', read: true, write: true, def: '' }],
            [
                'announcementSsml',
                { name: 'Announcement (SSML)', type: 'string', role: 'text', read: true, write: true, def: '' },
            ],
            [
                'announcementRephrase',
                { name: 'Announcement (LLM rephrase)', type: 'string', role: 'text', read: true, write: true, def: '' },
            ],
            ['dnd', { name: 'Do not disturb', type: 'boolean', role: 'switch', read: true, write: true, def: false }],
            [
                'mute',
                { name: 'Mute all microphones', type: 'boolean', role: 'switch', read: true, write: true, def: false },
            ],
        ];
        for (const [key, common] of states) {
            await this.adapter.setObjectNotExistsAsync(`${base}.${key}`, {
                type: 'state',
                common,
                native: {},
            });
        }
    }

    private async _ensureRoomStates(room: string): Promise<void> {
        const base = `satellites.rooms.${sanitizeId(room)}`;
        await this.adapter.setObjectNotExistsAsync(base, {
            type: 'folder',
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
                'announcementRephrase',
                { name: 'Announcement (LLM rephrase)', type: 'string', role: 'text', read: true, write: true, def: '' },
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

    private async _ensureSatelliteStates(objectKey: string, room: string, displayName: string): Promise<void> {
        const base = `satellites.rooms.${sanitizeId(room)}.${sanitizeId(objectKey)}`;
        await this.adapter.setObjectNotExistsAsync(base, {
            type: 'device',
            common: { name: `${displayName}` },
            native: {},
        });
        await this.adapter.extendObject(base, {
            common: { name: `${displayName}` },
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
        await this.adapter.setObjectNotExistsAsync(`${base}.address`, {
            type: 'state',
            common: {
                name: 'IP address',
                type: 'string',
                role: 'info.ip',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        });
        await this.adapter.setObjectNotExistsAsync(`${base}.last_seen`, {
            type: 'state',
            common: {
                name: 'Last seen (UTC)',
                type: 'string',
                role: 'value.time',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        });
        await this.adapter.setObjectNotExistsAsync(`${base}.room_mismatch`, {
            type: 'state',
            common: {
                name: 'Reports a different room than assigned',
                type: 'boolean',
                role: 'indicator.maintenance',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.adapter.setObjectNotExistsAsync(`${base}.owner`, {
            type: 'state',
            common: {
                name: 'Assigned Person (display name)',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: '',
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
                role: 'indicator',
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

    /**
     * After the initial GetSatellites sync, remove any satellite device object trees that
     * Hannah Core no longer reports. Hannah is the stateful, leading system for satellites
     * (sends every known satellite via GetSatellites regardless of connection status, and
     * pushes satellite_deleted when one is actually removed) — "not reported at all" reliably
     * means genuinely gone (deleted, or Core was reinstalled without data), not just
     * transiently offline, so deleting here is correct rather than just marking offline.
     *
     * Does NOT touch deviceRooms/deviceToObjectKey/objectKeyToDeviceId — those already
     * reflect each known device's current room from the handleSatelliteUpdate() calls run
     * just before this.
     *
     * @param knownSatellites - Satellites currently reported by Hannah Core
     */
    async removeUnknownSatellites(knownSatellites: Array<{ deviceId: string; room: string }>): Promise<void> {
        const known = new Set(knownSatellites.map(s => `${sanitizeId(s.room)}.${sanitizeId(s.deviceId)}`));
        const objects = await this.adapter.getForeignObjectsAsync(
            `${this.adapter.namespace}.satellites.rooms.*.*`,
            'device',
        );
        const touchedRooms = new Set<string>();
        for (const id of Object.keys(objects)) {
            const m = id.match(/\.satellites\.rooms\.([^.]+)\.([^.]+)$/);
            if (!m) {
                continue;
            }
            const [, roomId, deviceId] = m;
            if (!known.has(`${roomId}.${deviceId}`)) {
                await this.adapter.delObjectAsync(`satellites.rooms.${roomId}.${deviceId}`, { recursive: true });
                touchedRooms.add(roomId);
                this.adapter.log.info(
                    `[satellites] Removed stale satellite (not reported by Hannah): ${deviceId} in ${roomId}`,
                );
            }
        }
        for (const roomId of touchedRooms) {
            const prefix = `${this.adapter.namespace}.satellites.rooms.${roomId}.`;
            const remaining = await this.adapter.getForeignObjectsAsync(`${prefix}*`, 'device');
            if (Object.keys(remaining ?? {}).length === 0) {
                await this.adapter.delObjectAsync(`satellites.rooms.${roomId}`, { recursive: true });
                this.roomNames.delete(roomId.toLowerCase());
            }
        }
    }

    private async _setSatelliteOnline(objectKey: string, room: string, online: boolean): Promise<void> {
        if (!room) {
            return;
        }
        await this.adapter.setState(`satellites.rooms.${sanitizeId(room)}.${sanitizeId(objectKey)}.online`, {
            val: online,
            ack: true,
        });
    }

    private async _updateAnyOnline(room: string): Promise<void> {
        // Read all <deviceId>.online states under this room and compute anyOnline
        const pattern = `${this.adapter.namespace}.satellites.rooms.${sanitizeId(room)}.*.online`;
        const states = await this.adapter.getForeignStatesAsync(pattern);
        const anyOnline = Object.values(states).some(s => s?.val === true);
        await this.adapter.setState(`satellites.rooms.${sanitizeId(room)}.anyOnline`, { val: anyOnline, ack: true });
    }
}
