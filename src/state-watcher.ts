import type * as utils from '@iobroker/adapter-core';
import { v1 } from '@m1kad0/hannah-proto';
import agent = v1.agent;
import shared = v1.shared;
import type { AckResult, AckingMessageSender, AgentMessageSender } from './grpc-client';

/** Field number of AgentDevice.required_trust_level (hannah-proto#15). */
const REQUIRED_TRUST_LEVEL_FIELD = 15;
const AGENT_DEVICE_TYPE = 'hannah.v1.AgentDevice';
const TRUST_RESEND_DEBOUNCE_MS = 2_000;

/**
 * #203: whether Core enforces AgentDevice.required_trust_level, judged from the AgentAck of a
 * snapshot (hannah-proto#16). Core guarantees that every field it doesn't report as unknown is
 * also evaluated, so an ack without field 15 means "enforced". null = no verdict (disconnected).
 *
 * @param result - Outcome of sendWithAck() for a message carrying devices
 */
export function trustLevelSupported(result: AckResult): boolean | null {
    switch (result.kind) {
        case 'ack':
            return !result.ack.unknownFields.some(
                u => u.messageType === AGENT_DEVICE_TYPE && u.fieldNumbers.includes(REQUIRED_TRUST_LEVEL_FIELD),
            );
        case 'timeout':
        case 'legacy':
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
    private objectPatterns = new Set<string>();
    private resendTimer: ioBroker.Timeout | null | undefined = null;

    /**
     * @param adapter - ioBroker adapter instance
     * @param send - Function to send messages to Hannah Core
     * @param sendWithAck - Sends a message and waits for Core's AgentAck (used for device snapshots)
     * @param onTrustSupport - Told after each snapshot whether Core enforces neededTrust
     */
    constructor(
        adapter: utils.AdapterInstance,
        send: AgentMessageSender,
        sendWithAck?: AckingMessageSender,
        onTrustSupport?: TrustSupportHandler,
    ) {
        this.adapter = adapter;
        this.send = send;
        this.sendWithAck = sendWithAck;
        this.onTrustSupport = onTrustSupport;
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

        // Regular state → AgentStateUpdate
        this.send({
            stateUpdate: {
                stateId: id,
                value: JSON.stringify(state.val),
                ack: state.ack ?? false,
                ts: BigInt(state.ts ?? Date.now()),
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
        const devices: agent.AgentDevice[] = [];
        const trustByState = new Map<string, number | undefined>();
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
                    trustByState.set(id, meta.requiredTrustLevel);

                    sent++;
                }
            } catch (e) {
                this.adapter.log.warn(`[states] Snapshot failed for ${pattern}: ${(e as Error).message}`);
            }
        }
        this.trustByState = trustByState;

        const msg: agent.AgentMessage = { sendSnapshot: { devices } };
        if (this.sendWithAck) {
            const configured = devices.some(d => d.requiredTrustLevel !== undefined);
            // Not awaited: waiting up to the ack timeout would hold up start() and everything
            // onConnected does after it.
            void this.sendWithAck(msg).then(result => this._reportTrustSupport(result, configured));
        } else {
            this.send(msg);
        }

        this.adapter.log.info(`[states] Snapshot: ${sent} current device states sent.`);
    }

    private _reportTrustSupport(result: AckResult, configured: boolean): void {
        const supported = trustLevelSupported(result);
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
    ): Promise<{
        room: string;
        roomNames: { [key: string]: string };
        device: string;
        type: string;
        floor: string;
        functions: string[];
        stateType: shared.StateType;
        enumValues: shared.EnumValues | undefined;
        writable: boolean;
        deviceId: string;
        canonicalKey: string;
        inverted: boolean | undefined;
        requiredTrustLevel: number | undefined;
    }> {
        const deviceId = stateId.split('.').slice(0, -1).join('.');

        const [stateObj, deviceObj] = await Promise.all([
            this.adapter.getForeignObjectAsync(stateId),
            this.adapter.getForeignObjectAsync(deviceId),
        ]);

        // hannah#164/#256/#257: common.custom["hannah.0"] overrides — shared here so both
        // the type/canonicalKey resolution below and the device-name fallback chain read
        // the same enabled/state-vs-device lookup instead of duplicating it.
        const ns = this.adapter.namespace; // e.g. "hannah.0"
        const stateCustom = (stateObj?.common?.custom as any)?.[ns];
        const deviceCustom = (deviceObj?.common?.custom as any)?.[ns];

        const requiredTrustLevel = this._resolveNeededTrust(stateCustom);
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

        // hannah-iobroker#187: a room can be assigned directly to the leaf state instead of
        // its parent channel/device (common for manually-built alias constructs with no real
        // device level) — check that before falling back to device/grandparent-device.
        let roomObj = Object.values(allRooms.result).find(
            (obj: any) => obj?._id?.startsWith('enum.rooms.') && obj.common?.members?.includes(stateId),
        );

        if (roomObj == null) {
            roomObj = Object.values(allRooms.result).find(
                (obj: any) => obj?._id?.startsWith('enum.rooms.') && obj.common?.members?.includes(deviceId),
            );
        }

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

        // Rolle → {Kategorie, kanonischer State-Key}. Die Kategorie wird pro Gerät aggregiert
        // (erster nicht-leerer Wert über alle Sibling-States gewinnt, siehe hannah#133 auf
        // Core-Seite); der kanonische Key wird dagegen direkt pro State übernommen, ohne
        // Aggregation — ein Thermostat trägt z.B. gleichzeitig "current" (value.temperature)
        // und "expected" (level.temperature) auf zwei verschiedenen Sibling-States desselben
        // Geräts (hannah#257). Roh-Suffixe ohne passende Rolle liefern hier canonicalKey='' —
        // Core fällt dafür auf sein eigenes iobroker.state_names-Default zurück (hannah#256).
        const ROLE_TABLE: Record<string, { type: string; canonicalKey: string }> = {
            'level.dimmer': { type: 'light', canonicalKey: 'level' },
            'switch.light': { type: 'light', canonicalKey: 'on' },
            'level.temperature': { type: 'thermostat', canonicalKey: 'expected' },
            'value.temperature': { type: 'temperature_sensor', canonicalKey: 'current' },
            'value.humidity': { type: 'humidity_sensor', canonicalKey: 'current' },
            'value.brightness': { type: 'illuminance_sensor', canonicalKey: 'illuminance' },
            'value.power': { type: '', canonicalKey: 'power' },
            'sensor.door': { type: 'door', canonicalKey: 'open' },
            'indicator.open': { type: 'door', canonicalKey: 'open' },
            'sensor.window': { type: 'window', canonicalKey: 'open' },
            'level.blind': { type: 'blind', canonicalKey: 'level' },
            'level.curtain': { type: 'blind', canonicalKey: 'level' },
            'value.blind': { type: 'blind', canonicalKey: 'level' },
            'value.curtain': { type: 'blind', canonicalKey: 'level' },
        };

        const role = stateObj?.common?.role ?? '';

        const resolveTypeAndCanonicalKey = (): { type: string; canonicalKey: string } => {
            const typeOverride =
                (stateCustom?.enabled && stateCustom?.type) || (deviceCustom?.enabled && deviceCustom?.type);
            // Nur State-Level, nie Device-Level — anders als die Kategorie ist der kanonische
            // Key pro State unterschiedlich (s.o.), ein Device-weiter Override ergäbe keinen Sinn.
            const canonicalKeyOverride = stateCustom?.enabled && stateCustom?.canonicalKey;

            const roleMatch = ROLE_TABLE[role];

            if (role.startsWith('level.color')) {
                return {
                    type: String(typeOverride || 'light'),
                    canonicalKey: String(canonicalKeyOverride || 'color'),
                };
            }
            if (roleMatch) {
                return {
                    type: String(typeOverride || roleMatch.type),
                    canonicalKey: String(canonicalKeyOverride || roleMatch.canonicalKey),
                };
            }

            if (typeOverride) {
                return { type: String(typeOverride), canonicalKey: String(canonicalKeyOverride || '') };
            }

            const funcIds = matchingFunctionObjs.map((obj: any) => (obj._id as string).toLowerCase());
            // Read-only Helligkeits-/Lux-Sensoren landen oft mit unter der "Licht"-Funktion einsortiert —
            // deshalb vor dem generischen light/licht-Fallback geprüft, und nur bei write===false gematcht,
            // damit ein tatsächlich steuerbares Licht (write möglich) nicht fälschlich als Sensor erkannt wird.
            if (
                stateObj?.common?.write === false &&
                funcIds.some(id => id.includes('helligkeit') || id.includes('lux'))
            ) {
                return { type: 'illuminance_sensor', canonicalKey: String(canonicalKeyOverride || '') };
            }
            if (funcIds.some(id => id.includes('light') || id.includes('licht'))) {
                return { type: 'light', canonicalKey: String(canonicalKeyOverride || '') };
            }
            if (funcIds.some(id => id.includes('scene') || id.includes('szene'))) {
                return { type: 'scene', canonicalKey: String(canonicalKeyOverride || '') };
            }
            if (funcIds.some(id => id.includes('socket') || id.includes('stecker') || id.includes('plug'))) {
                return { type: 'socket', canonicalKey: String(canonicalKeyOverride || '') };
            }
            if (funcIds.some(id => id.includes('heat') || id.includes('heiz') || id.includes('therm'))) {
                return { type: 'thermostat', canonicalKey: String(canonicalKeyOverride || '') };
            }
            if (funcIds.some(id => id.includes('window') || id.includes('fenster'))) {
                return { type: 'window', canonicalKey: String(canonicalKeyOverride || '') };
            }
            if (funcIds.some(id => id.includes('door') || id.includes('tuer') || id.includes('türen'))) {
                return { type: 'door', canonicalKey: String(canonicalKeyOverride || '') };
            }
            if (funcIds.some(id => id.includes('temp'))) {
                return { type: 'temperature_sensor', canonicalKey: String(canonicalKeyOverride || '') };
            }
            if (funcIds.some(id => id.includes('klima') || id.includes('aircon') || id.includes('climate'))) {
                return { type: 'climate', canonicalKey: String(canonicalKeyOverride || '') };
            }

            if ((role === 'switch' || role === 'switch.power') && stateObj?.common?.write) {
                return { type: 'socket', canonicalKey: String(canonicalKeyOverride || 'on') };
            }

            return { type: '', canonicalKey: String(canonicalKeyOverride || '') };
        };

        const readableName = (n: unknown): string | null => {
            if (typeof n !== 'string' || !n || n.includes('.')) {
                return null;
            }
            return n;
        };

        // hannah#164: lets users fix Hannah's voice-matching name for devices whose
        // ioBroker friendly name is unsuited for it (too long, technical prefixes,
        // duplicates across rooms, ...) without renaming the actual object. Same
        // enabled/state-vs-device precedence as the type override above.
        const nameOverride =
            (stateCustom?.enabled && stateCustom?.name) || (deviceCustom?.enabled && deviceCustom?.name);

        const { stateType, enumValues } = this._resolveStateType(stateObj);
        const { type, canonicalKey } = resolveTypeAndCanonicalKey();

        // hannah#177/hannah-proto#4: analog zum type/name-Override, aber nur für über die
        // ROLE_TABLE als 'blind' aufgelöste States relevant — Rolladen/Markise-Aktoren, die
        // von sich aus die umgekehrte Konvention (0%=auf/100%=zu) nutzen (z.B. Homematic/KNX).
        // State-Level gewinnt vor Device-Level, wie bei type/name. undefined (nicht false)
        // wenn kein Override gesetzt ist — Core unterscheidet "kein Override" von "explizit
        // nicht invertiert" nicht, aber das Proto-Feld erlaubt die Unterscheidung bewusst.
        const stateShutterInverted = stateCustom?.enabled ? stateCustom?.shutterInverted : undefined;
        const deviceShutterInverted = deviceCustom?.enabled ? deviceCustom?.shutterInverted : undefined;
        const shutterInvertedOverride =
            stateShutterInverted !== undefined ? stateShutterInverted : deviceShutterInverted;
        const inverted =
            ROLE_TABLE[role]?.type === 'blind' && shutterInvertedOverride !== undefined
                ? Boolean(shutterInvertedOverride)
                : undefined;

        return {
            room: roomId,
            roomNames: roomNames,
            device:
                readableName(nameOverride) ??
                readableName(deviceObj?.common?.name) ??
                readableName(stateObj?.common?.name) ??
                deviceId.split('.').at(-1) ??
                '',
            type,
            floor,
            functions,
            stateType,
            enumValues,
            writable: Boolean(stateObj?.common?.write),
            deviceId,
            canonicalKey,
            inverted,
            requiredTrustLevel,
        };
    }

    /**
     * #203: common.custom["hannah.0"].neededTrust — minimum trust level (0–10) needed to set
     * this state. State-level only, like canonicalKey: a lock and its battery indicator sit
     * on the same device but need different protection. undefined (not 0) when unset or
     * invalid — the proto distinguishes "no restriction" from an explicit 0.
     *
     * @param stateCustom - The state's common.custom entry for this adapter instance
     */
    private _resolveNeededTrust(stateCustom: any): number | undefined {
        if (!stateCustom?.enabled) {
            return undefined;
        }
        const raw = stateCustom.neededTrust;
        if (raw === undefined || raw === null || raw === '') {
            return undefined;
        }
        const level = Number(raw);
        if (!Number.isInteger(level) || level < 0 || level > 10) {
            this.adapter.log.warn(`[states] Ignoring invalid neededTrust ${JSON.stringify(raw)} (expected 0–10)`);
            return undefined;
        }
        return level;
    }

    /**
     * Classifies a state's value shape (#117) from ioBroker's own common.type/role/states —
     * no separate discovery step needed, this metadata is already loaded alongside stateObj.
     *
     * @param stateObj - The state's own ioBroker object, as loaded in _resolveDeviceMeta
     */
    private _resolveStateType(stateObj: ioBroker.Object | null | undefined): {
        stateType: shared.StateType;
        enumValues: shared.EnumValues | undefined;
    } {
        const role = stateObj?.common?.role ?? '';
        const rawStates = (stateObj?.common as { states?: Record<string, string> | string[] | string } | undefined)
            ?.states;
        const enumValues = this._statesToEnumValues(rawStates);

        if (role.startsWith('level.color')) {
            return { stateType: shared.StateType.COLOR, enumValues };
        }
        if (enumValues) {
            return { stateType: shared.StateType.ENUM, enumValues };
        }

        const type = stateObj?.common?.type;
        if (type === 'boolean') {
            return { stateType: shared.StateType.BOOLEAN, enumValues: undefined };
        }
        if (type === 'number') {
            return { stateType: shared.StateType.NUMERIC, enumValues: undefined };
        }
        return { stateType: shared.StateType.TEXT, enumValues: undefined };
    }

    /**
     * Normalizes ioBroker's common.states (object map, string array, or the deprecated
     * "val1:text1;val2:text2" string format) into the value->label shape EnumValues needs.
     *
     * @param rawStates - The state object's common.states field, in any of its supported shapes
     */
    private _statesToEnumValues(
        rawStates: Record<string, string> | string[] | string | undefined,
    ): shared.EnumValues | undefined {
        if (!rawStates) {
            return undefined;
        }
        if (Array.isArray(rawStates)) {
            if (rawStates.length === 0) {
                return undefined;
            }
            return { values: Object.fromEntries(rawStates.map(v => [v, v])) };
        }
        if (typeof rawStates === 'string') {
            const values = Object.fromEntries(
                rawStates
                    .split(';')
                    .map(pair => pair.split(':'))
                    .filter((pair): pair is [string, string] => pair.length === 2),
            );
            return Object.keys(values).length > 0 ? { values } : undefined;
        }
        if (Object.keys(rawStates).length === 0) {
            return undefined;
        }
        return { values: Object.fromEntries(Object.entries(rawStates).map(([k, v]) => [k, String(v)])) };
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
                await addSingleState(s);
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
