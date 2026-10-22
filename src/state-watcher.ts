import type * as utils from '@iobroker/adapter-core';
import type { v1 } from '@m1kad0/hannah-proto';
import { v2 } from '@m1kad0/hannah-proto';
import agent = v2.agent;
import { parentId } from './device-grouping';
import { aliasTargetId, resolveDeviceMeta, resolveNeededTrust, type DeviceMeta, type ObjectMap } from './device-meta';
import { fromSlotValue, toSlotValue, type DeviceModel } from './device-model';
import { buildTypedDevices, mergeDeviceIds } from './device-snapshot';
import type {
    AckResult,
    AckingMessageSender,
    AgentMessageSender,
    Generation,
    LegacyAckingMessageSender,
    LegacyMessageSender,
} from './grpc-client';

/** Where required_trust_level sits in the device sync of each generation (hannah-proto#15). */
const TRUST_LEVEL_FIELD = {
    // AgentDevice.required_trust_level
    v1: { messageType: 'hannah.v1.AgentDevice', field: 15 },
    // Slot.required_trust_level
    v2: { messageType: 'hannah.v2.Slot', field: 7 },
} as const;
const TRUST_RESEND_DEBOUNCE_MS = 2_000;

/**
 * #203: whether Core enforces required_trust_level, judged from the AgentAck of a snapshot
 * (hannah-proto#16). Core guarantees that every field it doesn't report as unknown is also
 * evaluated, so an ack without the field means "enforced". null = no verdict (disconnected).
 *
 * @param result - Outcome of sendWithAck() for a message carrying devices
 * @param generation - Generation of the stream the snapshot went over
 */
export function trustLevelSupported(result: AckResult, generation: Generation = 'v1'): boolean | null {
    const { messageType, field } = TRUST_LEVEL_FIELD[generation];
    switch (result.kind) {
        case 'ack':
            return !result.ack.unknownFields.some(u => u.messageType === messageType && u.fieldNumbers.includes(field));
        case 'timeout':
            return false;
        case 'disconnected':
            return null;
    }
}

/**
 * Called after every device snapshot whose support verdict is known.
 *
 * @param supported - Core enforces required_trust_level
 * @param configured - At least one state in the snapshot has neededTrust set
 */
export type TrustSupportHandler = (supported: boolean, configured: boolean) => void;

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
    private sendWithAck: AckingMessageSender | undefined;
    private onTrustSupport: TrustSupportHandler | undefined;
    // #203: neededTrust per state as last sent — onObjectChange() resends only on a real change
    private trustByState = new Map<string, number | undefined>();
    // canonicalKey per state as last sent in the snapshot — reused for live updates
    private canonicalKeyByState = new Map<string, string>();
    private objectPatterns = new Set<string>();
    private resendTimer: ioBroker.Timeout | null | undefined = null;
    // Generation of the stream: a hannah.v2 Core gets typed devices, a hannah.v1 Core the
    // legacy per-state snapshot (set by start())
    private generation: Generation = 'v2';
    private legacy: { send: LegacyMessageSender; sendWithAck?: LegacyAckingMessageSender } | undefined;
    // Typed devices as last sent (hannah.v2 only), the index live updates and SetSlot use
    private deviceModel: DeviceModel | null = null;

    /**
     * @param adapter - ioBroker adapter instance
     * @param send - Function to send messages to Hannah Core
     * @param sendWithAck - Sends a message and waits for Core's AgentAck (used for device snapshots)
     * @param onTrustSupport - Told after each snapshot whether Core enforces neededTrust
     * @param legacy - Senders for the hannah.v1 device sync, used while Core only speaks hannah.v1
     * @param legacy.send - Sends a hannah.v1 message as it is
     * @param legacy.sendWithAck - Same, waits for Core's AgentAck
     */
    constructor(
        adapter: utils.AdapterInstance,
        send: AgentMessageSender,
        sendWithAck?: AckingMessageSender,
        onTrustSupport?: TrustSupportHandler,
        legacy?: { send: LegacyMessageSender; sendWithAck?: LegacyAckingMessageSender },
    ) {
        this.adapter = adapter;
        this.send = send;
        this.sendWithAck = sendWithAck;
        this.onTrustSupport = onTrustSupport;
        this.legacy = legacy;
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
     * @param generation - API generation of the stream to Core: decides which device sync is sent
     */
    async start(
        config: {
            selectedRooms: string[];
            selectedFunctions: string[];
            extraStatePrefixes: Array<{ prefix: string }>;
            floorMappings: Array<{ label: string; abbreviation: string }>;
        },
        generation: Generation = 'v2',
    ): Promise<void> {
        this.generation = generation;
        this.deviceModel = null;
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
        await this._subscribeObjects();
        await this._sendSnapshot();
    }

    /**
     * #203: a changed neededTrust takes effect without an adapter restart. Call from
     * onObjectChange — resends the device snapshot (debounced) when a managed state's
     * neededTrust actually changed. Core replaces its device map on every snapshot, so a
     * full resend is safe.
     *
     * @param id - Object ID that changed
     * @param obj - New object, or null/undefined if deleted
     */
    onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
        if (id === this.textCommandStateId || !this._isManaged(id)) {
            return;
        }
        const stateCustom = (obj?.common?.custom as any)?.[this.adapter.namespace];
        const trust = obj?.type === 'state' ? this._resolveNeededTrust(stateCustom) : undefined;
        if (trust === this.trustByState.get(id)) {
            return;
        }
        this.adapter.log.info(`[states] neededTrust of ${id} changed to ${trust ?? 'none'} — resending devices`);
        if (this.resendTimer) {
            this.adapter.clearTimeout(this.resendTimer);
        }
        this.resendTimer = this.adapter.setTimeout(() => {
            this.resendTimer = null;
            void this._sendSnapshot();
        }, TRUST_RESEND_DEBOUNCE_MS);
    }

    /**
     * Subscribe additional state IDs on demand (from AgentWatchMore). A hannah.v2 Core also gets
     * the current raw value of each newly watched state, marked `initial`, so it can prefill its
     * trigger cache without treating the value as a change.
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
            if (this.generation === 'v2') {
                await this._sendInitialValue(id);
            }
        }
    }

    private async _sendInitialValue(id: string): Promise<void> {
        try {
            const state = await this.adapter.getForeignStateAsync(id);
            if (!state) {
                return;
            }
            this.send({
                stateUpdate: {
                    stateId: id,
                    value: JSON.stringify(state.val),
                    ack: state.ack ?? false,
                    ts: BigInt(state.ts ?? Date.now()),
                    initial: true,
                },
            });
        } catch (e) {
            this.adapter.log.warn(`[states] Failed to read the start value of ${id}: ${(e as Error).message}`);
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
                this.send({ textCommand: { text } });
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

        const ts = BigInt(state.ts ?? Date.now());

        if (this.generation === 'v2') {
            // A state of a typed device → SlotUpdate. A state that isn't (a WatchMore state, or
            // one that came after the last snapshot) goes out as a plain AgentStateUpdate; a
            // WatchMore state that is also a slot gets both (Hannah's triggers watch state IDs).
            const slot = this.deviceModel?.bySlotState.get(id);
            if (slot) {
                this.send({
                    slotUpdate: {
                        deviceId: slot.deviceId,
                        slotId: slot.slotId,
                        value: toSlotValue(slot.target.kind, state.val, slot.target.inverted, slot.target.transform),
                        ack: state.ack ?? false,
                        ts,
                    },
                });
            }
            if (!slot || isWatchMoreState) {
                this.send({
                    stateUpdate: {
                        stateId: id,
                        value: JSON.stringify(state.val),
                        ack: state.ack ?? false,
                        ts,
                        initial: false,
                    },
                });
            }
            return true;
        }

        // hannah.v1 Core: regular state → AgentStateUpdate with the canonical key of the snapshot
        this.legacy?.send({
            stateUpdate: {
                stateId: id,
                value: JSON.stringify(state.val),
                ack: state.ack ?? false,
                ts,
                // Unknown states (e.g. WatchMore) and unresolved roles send none — Core then
                // falls back to its own suffix lookup.
                canonicalKey: this.canonicalKeyByState.get(id) || undefined,
            },
        });
        return true;
    }

    /**
     * Hannah instructs the adapter to control a slot of a typed device (hannah.v2). The
     * confirmed result comes back as a SlotUpdate with ack=true, once the device reports it.
     *
     * @param deviceId - Device ID as sent in the snapshot
     * @param slotId - Slot of that device
     * @param value - Value in the scale of the slot's kind
     */
    async handleSetSlot(deviceId: string, slotId: string, value: v2.device_model.SlotValue | undefined): Promise<void> {
        const target = this.deviceModel?.targets.get(deviceId)?.get(slotId);
        if (!target) {
            this.adapter.log.warn(`[states] SetSlot rejected — unknown slot ${deviceId}/${slotId}`);
            return;
        }
        if (!target.writable) {
            this.adapter.log.warn(`[states] SetSlot rejected — ${deviceId}/${slotId} is read-only`);
            return;
        }
        const current = (await this.adapter.getForeignStateAsync(target.stateId))?.val;
        const parsed = fromSlotValue(target, value, current);
        if (parsed === undefined) {
            this.adapter.log.warn(
                `[states] SetSlot rejected — value ${JSON.stringify(value)} does not fit ${deviceId}/${slotId}`,
            );
            return;
        }
        try {
            await this.adapter.setForeignStateAsync(target.stateId, { val: parsed, ack: false });
            this.adapter.log.debug(
                `[states] SetSlot ${deviceId}/${slotId} → ${target.stateId} = ${JSON.stringify(parsed)}`,
            );
        } catch (e) {
            this.adapter.log.error(`[states] SetSlot failed for ${deviceId}/${slotId}: ${(e as Error).message}`);
        }
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
        const rooms: Array<{ roomId: string; displayNames: { [key: string]: string } }> = [];
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
            rooms.push({ roomId, displayNames });
        }
        this.send({ sendRooms: { rooms } });
        this.adapter.log.info(`[states] Room snapshot sent: ${rooms.length} rooms`);
    }

    /**
     * Read and forward the current value of all subscribed states.
     * Replaces MQTT retained messages — called once after all subscriptions are set up.
     */
    private async _sendSnapshot(): Promise<void> {
        const collected: Array<{ id: string; state: ioBroker.State; meta: DeviceMeta }> = [];

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
                    collected.push({ id, state, meta: await this._resolveDeviceMeta(id, allRooms, allFunctions) });
                }
            } catch (e) {
                this.adapter.log.warn(`[states] Snapshot failed for ${pattern}: ${(e as Error).message}`);
            }
        }
        this.trustByState = new Map(collected.map(c => [c.id, c.meta.requiredTrustLevel]));

        if (this.generation === 'v2') {
            await this._sendTypedSnapshot(collected, { ...allRooms.result, ...allFunctions.result });
        } else {
            this._sendLegacySnapshot(collected);
        }
    }

    /**
     * hannah.v2: the typed devices (class and slots) from the states of the snapshot.
     *
     * @param collected - Every subscribed state with its resolved meta data
     * @param enums - The room and function enums, the device detector uses them too
     */
    private async _sendTypedSnapshot(
        collected: Array<{ id: string; state: ioBroker.State; meta: DeviceMeta }>,
        enums: Record<string, ioBroker.Object>,
    ): Promise<void> {
        // the device objects a merged device is named after
        const objects: ObjectMap = {};
        for (const id of mergeDeviceIds(collected)) {
            try {
                objects[id] = await this.adapter.getForeignObjectAsync(id);
            } catch {
                // the name of the first channel does
            }
        }
        const { model, merges } = buildTypedDevices(collected, objects, enums);
        for (const merge of merges) {
            this.adapter.log.debug(`[states] Merged channels ${merge.groupIds.join(', ')} into ${merge.deviceId}`);
        }
        this.deviceModel = model;
        const msg: agent.AgentMessage = { typedSnapshot: { devices: model.devices } };
        const configured = model.devices.some(d => d.slots.some(s => s.requiredTrustLevel !== undefined));
        if (this.sendWithAck) {
            // Not awaited: waiting up to the ack timeout would hold up start() and everything
            // onConnected does after it.
            void this.sendWithAck(msg).then(result => this._reportTrustSupport(result, configured));
        } else {
            this.send(msg);
        }
        const slots = model.devices.reduce((n, d) => n + d.slots.length, 0);
        this.adapter.log.info(`[states] Snapshot: ${model.devices.length} devices with ${slots} slots sent.`);
    }

    /**
     * hannah.v1: the per-state snapshot with canonical keys, unchanged, for a Core that doesn't
     * know the typed devices.
     *
     * @param collected - Every subscribed state with its resolved meta data
     */
    private _sendLegacySnapshot(collected: Array<{ id: string; state: ioBroker.State; meta: DeviceMeta }>): void {
        const devices: v1.agent.AgentDevice[] = [];
        const canonicalKeyByState = new Map<string, string>();

        for (const { id, state, meta } of collected) {
            devices.push({
                stateId: id,
                floor: meta.floor,
                room: meta.room,
                roomNames: meta.roomNames,
                device: meta.device,
                deviceType: meta.type,
                functions: meta.functions,
                value: {
                    value: JSON.stringify(state.val),
                    ack: state.ack ?? false,
                },
                stateType: meta.stateType,
                enumValues: meta.enumValues,
                writable: meta.writable,
                deviceId: meta.deviceId,
                canonicalKey: meta.canonicalKey,
                inverted: meta.inverted,
                requiredTrustLevel: meta.requiredTrustLevel,
            });
            canonicalKeyByState.set(id, meta.canonicalKey);
        }
        this.canonicalKeyByState = canonicalKeyByState;
        const sent = devices.length;

        const msg: v1.agent.AgentMessage = { sendSnapshot: { devices } };
        if (this.legacy?.sendWithAck) {
            const configured = devices.some(d => d.requiredTrustLevel !== undefined);
            // Not awaited: waiting up to the ack timeout would hold up start() and everything
            // onConnected does after it.
            void this.legacy.sendWithAck(msg).then(result => this._reportTrustSupport(result, configured));
        } else {
            this.legacy?.send(msg);
        }

        this.adapter.log.info(`[states] Snapshot: ${sent} current device states sent.`);
    }

    private _reportTrustSupport(result: AckResult, configured: boolean): void {
        const supported = trustLevelSupported(result, this.generation);
        if (supported === null) {
            this.adapter.log.debug('[states] No ack for device snapshot (disconnected) — trust support unknown');
            return;
        }
        this.adapter.log.debug(`[states] Snapshot ack: ${result.kind}, trust levels supported: ${supported}`);
        this.onTrustSupport?.(supported, configured);
    }

    /**
     * #203: object subscriptions mirror the state subscriptions, so neededTrust changes on
     * managed states reach onObjectChange().
     */
    private async _subscribeObjects(): Promise<void> {
        for (const pattern of this.subscribedIds) {
            if (pattern === this.textCommandStateId || this.objectPatterns.has(pattern)) {
                continue;
            }
            try {
                await this.adapter.subscribeForeignObjectsAsync(pattern);
                this.objectPatterns.add(pattern);
            } catch (e) {
                this.adapter.log.warn(`[states] Object subscribe failed for ${pattern}: ${(e as Error).message}`);
            }
        }
    }

    private async _resolveDeviceMeta(
        stateId: string,
        allRooms: Awaited<ReturnType<utils.AdapterInstance['getEnumAsync']>>,
        allFunctions: Awaited<ReturnType<utils.AdapterInstance['getEnumAsync']>>,
    ): Promise<DeviceMeta> {
        const objects = await this._loadObjects(stateId);
        const { meta, warnings } = resolveDeviceMeta(stateId, objects, allRooms.result, allFunctions.result, {
            namespace: this.adapter.namespace, // e.g. "hannah.0"
            floorMappings: this.floorMappings,
        });
        for (const warning of warnings) {
            this.adapter.log.warn(`[states] ${warning}`);
        }
        return meta;
    }

    /**
     * The objects `resolveDeviceMeta()` needs for a state: the state, its parent (channel or
     * device) and, for an alias, the state it points to.
     *
     * @param stateId - ioBroker state ID
     */
    private async _loadObjects(stateId: string): Promise<ObjectMap> {
        const deviceId = parentId(stateId);
        const [state, device] = await Promise.all([
            this.adapter.getForeignObjectAsync(stateId),
            this.adapter.getForeignObjectAsync(deviceId),
        ]);
        const objects: ObjectMap = { [stateId]: state, [deviceId]: device };
        const targetId = aliasTargetId(state);
        if (targetId) {
            try {
                objects[targetId] = await this.adapter.getForeignObjectAsync(targetId);
            } catch {
                // the alias is then resolved without its target
            }
        }
        return objects;
    }

    /**
     * #203: common.custom["hannah.0"].neededTrust of a state, see `resolveNeededTrust()`.
     *
     * @param stateCustom - The state's common.custom entry for this adapter instance
     */
    private _resolveNeededTrust(stateCustom: any): number | undefined {
        const { level, warning } = resolveNeededTrust(stateCustom);
        if (warning) {
            this.adapter.log.warn(`[states] ${warning}`);
        }
        return level;
    }

    /**
     * Unsubscribe all states and clear the subscription set.
     */
    async stop(): Promise<void> {
        if (this.resendTimer) {
            this.adapter.clearTimeout(this.resendTimer);
            this.resendTimer = null;
        }
        for (const id of this.subscribedIds) {
            await this.adapter.unsubscribeForeignStatesAsync(id);
        }
        for (const pattern of this.objectPatterns) {
            await this.adapter.unsubscribeForeignObjectsAsync(pattern);
        }
        this.objectPatterns.clear();
        this.trustByState.clear();
        this.canonicalKeyByState.clear();
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
            // Not swallowed: start() would go on with an empty discovery and the sync would look
            // done. Failing it makes the connection retry the whole sync.
            this.adapter.log.error(`[states] getObjectViewAsync failed: ${(e as Error).message}`);
            throw e;
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

        // A function enum member is a state or, like in the room enums, a device or channel
        // (what ioBroker's admin assigns on third-party adapters): the latter is subscribed
        // with its prefix, too, else nothing below it would ever arrive.
        const addFunctionMember = async (memberId: string): Promise<void> => {
            await addSingleState(memberId);
            if (await this._isContainer(memberId)) {
                await addWildcard(memberId);
            }
        };

        // hannah-iobroker#187: a room enum member isn't always a device/channel — it can be a
        // leaf state directly. addWildcard's `d.*` pattern never matches that (a state has no
        // children), so every room member is also subscribed as a single state; harmless no-op
        // when `d` is actually a container with no state of its own.
        if (selectedRooms.length === 0 && selectedFunctions.length === 0) {
            // No filter → room wildcards cover all sub-states including function states
            for (const d of roomDevices) {
                await addWildcard(d);
                await addSingleState(d);
            }
        } else if (selectedRooms.length === 0) {
            // Functions only → all states from selected function enums
            for (const s of funcStates) {
                await addFunctionMember(s);
            }
        } else if (selectedFunctions.length === 0) {
            // Rooms only → pattern-subscribe for all states under room devices
            for (const d of roomDevices) {
                await addWildcard(d);
                await addSingleState(d);
            }
        } else {
            // Both → function states whose device prefix is in a selected room, or whose own
            // id IS a selected room member (#187)
            for (const s of funcStates) {
                if ([...roomDevices].some(d => s === d || s.startsWith(`${d}.`))) {
                    await addFunctionMember(s);
                }
            }
        }

        this.adapter.log.info(`[states] Enum-Discovery: ${this.subscribedIds.size} states subscribed.`);
    }

    /**
     * Whether an object holds other objects (device, channel or folder) instead of a value.
     *
     * @param id - ioBroker object ID
     */
    private async _isContainer(id: string): Promise<boolean> {
        try {
            const object = await this.adapter.getForeignObjectAsync(id);
            return object?.type === 'device' || object?.type === 'channel' || object?.type === 'folder';
        } catch {
            return false;
        }
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
