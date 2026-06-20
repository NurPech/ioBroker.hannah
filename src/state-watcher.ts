import type * as utils from '@iobroker/adapter-core';
import type { AgentMessageSender } from './grpc-client';

type AgentStateValue = {
    value: string;
    ack: boolean;
};

type AgentDevice = {
    state_id: string;
    floor: string;
    room: string; // room_id: enum ID segment, e.g. "wohnzimmer"
    room_names: { [key: string]: string }; // all display names, e.g. {de: "Wohnzimmer", en: "Living Room"}
    device: string;
    device_type: string;
    functions: string[];
    value: AgentStateValue;
};

/**
 * Discovers ioBroker states via enum (rooms + functions) and extra prefixes,
 * subscribes to them, and forwards changes as AgentStateUpdate messages.
 * Also handles SetState commands arriving from Hannah Core.
 */
export class StateWatcher {
    private adapter: utils.AdapterInstance;
    private send: AgentMessageSender;
    private subscribedIds = new Set<string>();
    private wildcardPrefixes = new Set<string>();
    private verifiedWildcardCache = new Set<string>();
    private watchMoreIds = new Set<string>();
    private floorMappings: Array<{ label: string; abbreviation: string }> = [];

    /**
     * @param adapter - ioBroker adapter instance
     * @param send - Function to send messages to Hannah Core
     */
    constructor(adapter: utils.AdapterInstance, send: AgentMessageSender) {
        this.adapter = adapter;
        this.send = send;
    }

    private get textCommandStateId(): string {
        return `${this.adapter.namespace}.textCommand`;
    }

    /**
     * Discover and subscribe to all relevant states.
     *
     * @param config - Subscription filter configuration
     * @param config.selectedRooms - Room enum IDs to include (empty = all)
     * @param config.selectedFunctions - Function enum IDs to include (empty = all)
     * @param config.extraStatePrefixes - Additional state ID prefixes to subscribe
     * @param config.floorMappings - Label→abbreviation pairs for floor detection (empty = hardcoded defaults)
     */
    async start(config: {
        selectedRooms: string[];
        selectedFunctions: string[];
        extraStatePrefixes: Array<{ prefix: string }>;
        floorMappings: Array<{ label: string; abbreviation: string }>;
    }): Promise<void> {
        this.subscribedIds.clear();
        this.wildcardPrefixes.clear();
        this.verifiedWildcardCache.clear();
        this.watchMoreIds.clear();
        this.floorMappings = config.floorMappings;

        await this._subscribeEnumStates(config.selectedRooms, config.selectedFunctions);
        await this._subscribeExtraPrefixes(config.extraStatePrefixes.map(p => p.prefix));

        await this.adapter.subscribeStatesAsync('textCommand').catch(e => {
            this.adapter.log.error(`[states] Failed to subscribe to textCommand state: ${(e as Error).message}`);
        });
        this.subscribedIds.add(this.textCommandStateId);

        this.adapter.log.info(`[states] ${this.subscribedIds.size} Patterns/States subscribed.`);
        await this._sendSnapshot();
    }

    /**
     * Subscribe additional state IDs on demand (from AgentWatchMore).
     *
     * @param stateIds - State IDs to subscribe
     */
    async watchMore(stateIds: string[]): Promise<void> {
        for (const id of stateIds) {
            if (this.watchMoreIds.has(id)) {
                continue;
            }
            await this.adapter.subscribeForeignStatesAsync(id);
            this.watchMoreIds.add(id);
            this.adapter.log.debug(`[states] WatchMore: ${id}`);
        }
    }

    /**
     * Call from onForeignStateChange. Returns true if the state was handled.
     *
     * @param id - State ID that changed
     * @param state - New state value, or null/undefined if deleted
     */
    onStateChange(id: string, state: ioBroker.State | null | undefined): boolean {
        if (!state) {
            return false;
        }

        const isWatchMoreState = this.watchMoreIds.has(id);
        let isSubscribed = this.subscribedIds.has(id) || isWatchMoreState || this.verifiedWildcardCache.has(id);

        if (!isSubscribed) {
            for (const prefix of this.wildcardPrefixes) {
                if (id.startsWith(prefix)) {
                    this.verifiedWildcardCache.add(id);
                    isSubscribed = true;
                    break;
                }
            }
        }

        if (!isSubscribed) {
            return false;
        }

        this.adapter.log.debug(`[states] StateChange: ${id} = ${JSON.stringify(state.val)} (ack=${state.ack})`);

        // Text command state → AgentTextCommand (ack:false = user input)
        if (id === this.textCommandStateId && state.ack === false) {
            const text = String(state.val ?? '').trim();
            if (text) {
                this.send({ text_command: { text } });
                this.adapter.log.debug(`[states] TextCommand: ${text}`);
                this.adapter.setState(id, { val: '', ack: true }).catch(e => {
                    this.adapter.log.error(`[states] Failed to reset text command state: ${(e as Error).message}`);
                });
            }
            return true;
        }

        // Only forward confirmed states — ack:false = command pending, ack:true = device confirmed.
        // WatchMore states are monitoring-only (Hannah never writes to them via handleSetState),
        // so there's no feedback-loop risk — forward every change regardless of ack. This avoids
        // losing updates for manually/directly written flags (e.g. 0_userdata booleans) that
        // never receive an explicit ack:true.
        if (!isWatchMoreState && !state.ack) {
            return false;
        }

        // Regular state → AgentStateUpdate
        this.send({
            state_update: {
                state_id: id,
                value: JSON.stringify(state.val),
                ack: state.ack ?? false,
                ts: state.ts ?? Date.now(),
            },
        });
        return true;
    }

    /**
     * Hannah instructs the adapter to set a state in ioBroker.
     *
     * @param stateId - Target state ID
     * @param value - JSON-encoded value to set
     */
    async handleSetState(stateId: string, value: string): Promise<void> {
        if (!this._isManaged(stateId)) {
            this.adapter.log.warn(`[states] SetState rejected — not a managed state: ${stateId}`);
            return;
        }
        const state = await this.adapter.getForeignObjectAsync(stateId);
        if (!state?.common.write) {
            return;
        }
        try {
            const parsed = JSON.parse(value);
            await this.adapter.setForeignStateAsync(stateId, { val: parsed, ack: false });
            this.adapter.log.debug(`[states] SetState ${stateId} = ${value}`);
        } catch (e) {
            this.adapter.log.error(`[states] SetState failed for ${stateId}: ${(e as Error).message}`);
        }
    }

    /**
     * Send the full enum.rooms.* catalog to Hannah Core, independent of devices.
     * Without this, a room with no devices yet (e.g. before its first satellite is
     * provisioned) is unknown to Hannah's RoomManager and provisioning into it fails.
     *
     * @param rows Roomlist from getObjectViewAsync('system', 'enum', { startkey: 'enum.rooms.', endkey: 'enum.rooms.*' })
     */
    private _sendRoomSnapshot(rows: Array<{ id: string; value: ioBroker.Object | null }>): void {
        const rooms: Array<{ room_id: string; display_names: { [key: string]: string } }> = [];
        for (const row of rows) {
            if (!row.value || row.value.type !== 'enum') {
                continue;
            }
            const roomId = row.id.split('.').pop();
            if (!roomId) {
                continue;
            }
            const nameRaw = (row.value.common as any)?.name;
            const displayNames: { [key: string]: string } = {};
            if (typeof nameRaw === 'string') {
                displayNames.de = nameRaw;
            } else if (nameRaw && typeof nameRaw === 'object') {
                for (const [lang, val] of Object.entries(nameRaw)) {
                    if (typeof val === 'string') {
                        displayNames[lang] = val;
                    }
                }
            }
            rooms.push({ room_id: roomId, display_names: displayNames });
        }
        this.send({ send_rooms: { rooms } });
        this.adapter.log.info(`[states] Room snapshot sent: ${rooms.length} rooms`);
    }

    /**
     * Read and forward the current value of all subscribed states.
     * Replaces MQTT retained messages — called once after all subscriptions are set up.
     */
    private async _sendSnapshot(): Promise<void> {
        const devices: AgentDevice[] = [];
        let sent = 0;

        const [allRooms, allFunctions] = await Promise.all([
            this.adapter.getEnumAsync('rooms'),
            this.adapter.getEnumAsync('functions'),
        ]);

        for (const pattern of this.subscribedIds) {
            try {
                const states = await this.adapter.getForeignStatesAsync(pattern);

                for (const [id, state] of Object.entries(states)) {
                    if (!state) {
                        continue;
                    }

                    const meta = await this._resolveDeviceMeta(id, allRooms, allFunctions);

                    devices.push({
                        state_id: id,
                        floor: meta.floor,
                        room: meta.room,
                        room_names: meta.room_names,
                        device: meta.device,
                        device_type: meta.type,
                        functions: meta.functions,
                        value: {
                            value: JSON.stringify(state.val),
                            ack: state.ack ?? false,
                        },
                    });

                    sent++;
                }
            } catch (e) {
                this.adapter.log.warn(`[states] Snapshot failed for ${pattern}: ${(e as Error).message}`);
            }
        }

        this.send({ send_snapshot: { devices } });

        this.adapter.log.info(`[states] Snapshot: ${sent} current device states sent.`);
    }

    private async _resolveDeviceMeta(
        stateId: string,
        allRooms: Awaited<ReturnType<utils.AdapterInstance['getEnumAsync']>>,
        allFunctions: Awaited<ReturnType<utils.AdapterInstance['getEnumAsync']>>,
    ): Promise<{
        room: string;
        room_names: { [key: string]: string };
        device: string;
        type: string;
        floor: string;
        functions: string[];
    }> {
        const deviceId = stateId.split('.').slice(0, -1).join('.');

        const [stateObj, deviceObj] = await Promise.all([
            this.adapter.getForeignObjectAsync(stateId),
            this.adapter.getForeignObjectAsync(deviceId),
        ]);

        const rawFloorFromObj =
            typeof deviceObj?.common?.floor === 'string' && deviceObj.common.floor ? deviceObj.common.floor : null;

        const knownFloors = new Set(['EG', 'OG', 'UG', 'DG', 'KG', 'ZG']);

        const resolveFloor = (value: string): string | null => {
            const upper = value.toUpperCase();
            const match = this.floorMappings.find(
                m => m.label.toUpperCase() === upper || m.abbreviation.toUpperCase() === upper,
            );
            if (match) {
                return match.abbreviation;
            }
            if (knownFloors.has(upper)) {
                return upper;
            }
            return null;
        };

        const floorFromObj = rawFloorFromObj !== null ? (resolveFloor(rawFloorFromObj) ?? rawFloorFromObj) : null;

        let floorFromId = '';
        for (const part of deviceId.split('.')) {
            const resolved = resolveFloor(part);
            if (resolved !== null) {
                floorFromId = resolved;
                break;
            }
        }

        const floor = floorFromObj ?? floorFromId;

        let roomObj = Object.values(allRooms.result).find(
            (obj: any) => obj?._id?.startsWith('enum.rooms.') && obj.common?.members?.includes(deviceId),
        );

        if (roomObj == null) {
            const parentId = deviceId.split('.').slice(0, -1).join('.');
            roomObj = Object.values(allRooms.result).find(
                (obj: any) => obj?._id?.startsWith('enum.rooms.') && obj.common?.members?.includes(parentId),
            );
        }

        const roomId = roomObj ? (roomObj._id.split('.').pop() ?? '') : '';
        const roomNamesRaw = roomObj?.common?.name;
        const roomNames: { [key: string]: string } = {};
        if (roomNamesRaw) {
            if (typeof roomNamesRaw === 'string') {
                roomNames.de = roomNamesRaw;
            } else if (typeof roomNamesRaw === 'object') {
                for (const [lang, val] of Object.entries(roomNamesRaw)) {
                    if (typeof val === 'string') {
                        roomNames[lang] = val;
                    }
                }
            }
        }

        const matchingFunctionObjs = Object.values(allFunctions.result).filter(
            (obj: any) => obj?._id?.startsWith('enum.functions.') && obj.common?.members?.includes(stateId),
        );

        const functions = matchingFunctionObjs.map((obj: any) =>
            String(obj.common?.name?.de ?? obj.common?.name ?? obj._id),
        );

        const resolveType = (): string => {
            const ns = this.adapter.namespace; // e.g. "hannah.0"
            const stateCustom = (stateObj?.common?.custom as any)?.[ns];
            const deviceCustom = (deviceObj?.common?.custom as any)?.[ns];
            const override =
                (stateCustom?.enabled && stateCustom?.type) || (deviceCustom?.enabled && deviceCustom?.type);
            if (override) {
                return String(override);
            }

            const role = stateObj?.common?.role ?? '';
            if (role.startsWith('level.color') || role === 'level.dimmer' || role === 'switch.light') {
                return 'light';
            }
            if (role === 'level.temperature') {
                return 'thermostat';
            }
            if (role === 'value.temperature') {
                return 'temperature_sensor';
            }
            if (role === 'sensor.door' || role === 'indicator.open') {
                return 'door';
            }
            if (role === 'sensor.window') {
                return 'window';
            }
            if (
                role === 'level.blind' ||
                role === 'level.curtain' ||
                role === 'value.blind' ||
                role === 'value.curtain'
            ) {
                return 'blind';
            }

            const funcIds = matchingFunctionObjs.map((obj: any) => (obj._id as string).toLowerCase());
            if (funcIds.some(id => id.includes('light') || id.includes('licht'))) {
                return 'light';
            }
            if (funcIds.some(id => id.includes('socket') || id.includes('stecker') || id.includes('plug'))) {
                return 'socket';
            }
            if (funcIds.some(id => id.includes('heat') || id.includes('heiz') || id.includes('therm'))) {
                return 'thermostat';
            }
            if (funcIds.some(id => id.includes('window') || id.includes('fenster'))) {
                return 'window';
            }
            if (funcIds.some(id => id.includes('door') || id.includes('tuer') || id.includes('türen'))) {
                return 'door';
            }
            if (funcIds.some(id => id.includes('temp'))) {
                return 'temperature_sensor';
            }
            if (funcIds.some(id => id.includes('klima') || id.includes('aircon') || id.includes('climate'))) {
                return 'climate';
            }

            if ((role === 'switch' || role === 'switch.power') && stateObj?.common?.write) {
                return 'socket';
            }

            return '';
        };

        const readableName = (n: unknown): string | null => {
            if (typeof n !== 'string' || !n || n.includes('.')) {
                return null;
            }
            return n;
        };

        return {
            room: roomId,
            room_names: roomNames,
            device:
                readableName(deviceObj?.common?.name) ??
                readableName(stateObj?.common?.name) ??
                deviceId.split('.').at(-1) ??
                '',
            type: resolveType(),
            floor,
            functions,
        };
    }

    /**
     * Unsubscribe all states and clear the subscription set.
     */
    async stop(): Promise<void> {
        for (const id of this.subscribedIds) {
            await this.adapter.unsubscribeForeignStatesAsync(id);
        }
        this.subscribedIds.clear();
        this.wildcardPrefixes.clear();
        this.verifiedWildcardCache.clear();
    }

    private async _subscribeEnumStates(selectedRooms: string[], selectedFunctions: string[]): Promise<void> {
        this.adapter.log.info('[states] Enum-Discovery: Loading rooms and functions...');
        let roomResult: { rows: Array<{ id: string; value: ioBroker.Object | null }> };
        let funcResult: typeof roomResult;
        try {
            [roomResult, funcResult] = await Promise.all([
                this.adapter.getObjectViewAsync('system', 'enum', {
                    startkey: 'enum.rooms.',
                    endkey: 'enum.rooms.香',
                }),
                this.adapter.getObjectViewAsync('system', 'enum', {
                    startkey: 'enum.functions.',
                    endkey: 'enum.functions.香',
                }),
            ]);
        } catch (e) {
            this.adapter.log.error(`[states] getObjectViewAsync failed: ${(e as Error).message}`);
            return;
        }

        // Room enums contain device IDs; function enums contain state IDs directly
        const roomDevices = this._extractViewMembers(roomResult.rows, selectedRooms);
        const funcStates = this._extractViewMembers(funcResult.rows, selectedFunctions);

        this.adapter.log.info(
            `[states] Enum-Discovery: ${roomResult.rows.length} room enums (${roomDevices.size} devices), ${funcResult.rows.length} function enums (${funcStates.size} states)`,
        );

        // Full room catalog (unfiltered by selectedRooms) — independent of devices, so
        // Hannah Core knows about rooms before the first device/satellite exists in them.
        this._sendRoomSnapshot(roomResult.rows);

        const addWildcard = async (deviceId: string): Promise<void> => {
            const prefix = deviceId.endsWith('.') ? deviceId : `${deviceId}.`;
            const pattern = `${prefix}*`;
            if (!this.subscribedIds.has(pattern)) {
                await this.adapter.subscribeForeignStatesAsync(pattern);
                this.subscribedIds.add(pattern);
                this.wildcardPrefixes.add(prefix);
            }
        };

        const addSingleState = async (stateId: string): Promise<void> => {
            if (!this.subscribedIds.has(stateId)) {
                await this.adapter.subscribeForeignStatesAsync(stateId);
                this.subscribedIds.add(stateId);
            }
        };

        if (selectedRooms.length === 0 && selectedFunctions.length === 0) {
            // No filter → room wildcards cover all sub-states including function states
            for (const d of roomDevices) {
                await addWildcard(d);
            }
        } else if (selectedRooms.length === 0) {
            // Functions only → all states from selected function enums
            for (const s of funcStates) {
                await addSingleState(s);
            }
        } else if (selectedFunctions.length === 0) {
            // Rooms only → pattern-subscribe for all states under room devices
            for (const d of roomDevices) {
                await addWildcard(d);
            }
        } else {
            // Both → function states whose device prefix is in a selected room
            for (const s of funcStates) {
                if ([...roomDevices].some(d => s.startsWith(`${d}.`))) {
                    await addSingleState(s);
                }
            }
        }

        this.adapter.log.info(`[states] Enum-Discovery: ${this.subscribedIds.size} states subscribed.`);
    }

    private _extractViewMembers(
        rows: Array<{ id: string; value: ioBroker.Object | null }>,
        selected: string[],
    ): Set<string> {
        const ids = new Set<string>();
        for (const row of rows) {
            if (!row.value || row.value.type !== 'enum') {
                continue;
            }
            if (selected.length > 0 && !selected.includes(row.id)) {
                continue;
            }
            for (const memberId of (row.value.common as any).members ?? []) {
                ids.add(memberId);
            }
        }
        return ids;
    }

    private async _subscribeExtraPrefixes(prefixes: string[]): Promise<void> {
        for (const prefix of prefixes) {
            if (!prefix) {
                continue;
            }
            const normalized = prefix.replace(/\//g, '.');
            const cleanPrefix = normalized.endsWith('.') ? normalized : `${normalized}.`;
            const pattern = `${cleanPrefix}*`;
            await this.adapter.subscribeForeignStatesAsync(pattern);
            this.subscribedIds.add(pattern);
            this.wildcardPrefixes.add(cleanPrefix);
            this.adapter.log.info(`[states] Extra-Prefix subscribed: ${pattern}`);
        }
    }

    private _isManaged(id: string): boolean {
        if (this.subscribedIds.has(id)) {
            return true;
        }
        if (this.verifiedWildcardCache.has(id)) {
            return true;
        }
        for (const prefix of this.wildcardPrefixes) {
            if (id.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }
}
