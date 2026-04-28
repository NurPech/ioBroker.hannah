import type * as utils from '@iobroker/adapter-core';
import type { AgentMessageSender } from './grpc-client';

/**
 * Discovers ioBroker states via enum (rooms + functions) and extra prefixes,
 * subscribes to them, and forwards changes as AgentStateUpdate messages.
 * Also handles SetState commands arriving from Hannah Core.
 */
export class StateWatcher {
    private adapter: utils.AdapterInstance;
    private send: AgentMessageSender;
    private subscribedIds = new Set<string>();
    private textCommandStateId: string;
    private residentsPrefix: string;
    private wildcardPrefixes = new Set<string>();
    private verifiedWildcardCache = new Set<string>();

    /**
     * @param adapter - ioBroker adapter instance
     * @param send - Function to send messages to Hannah Core
     * @param textCommandStateId - State ID used for text command input
     * @param residentsPrefix - State ID prefix for the residents adapter (e.g. "residents.0.")
     */
    constructor(
        adapter: utils.AdapterInstance,
        send: AgentMessageSender,
        textCommandStateId: string,
        residentsPrefix: string,
    ) {
        this.adapter = adapter;
        this.send = send;
        this.textCommandStateId = textCommandStateId;
        this.residentsPrefix = residentsPrefix.endsWith('.') ? residentsPrefix : `${residentsPrefix}.`;
    }

    /**
     * Discover and subscribe to all relevant states.
     *
     * @param config - Subscription filter configuration
     * @param config.selectedRooms - Room enum IDs to include (empty = all)
     * @param config.selectedFunctions - Function enum IDs to include (empty = all)
     * @param config.extraStatePrefixes - Additional state ID prefixes to subscribe
     */
    async start(config: {
        selectedRooms: string[];
        selectedFunctions: string[];
        extraStatePrefixes: Array<{ prefix: string }>;
    }): Promise<void> {
        this.subscribedIds.clear();
        this.wildcardPrefixes.clear();
        this.verifiedWildcardCache.clear();

        await this._subscribeEnumStates(config.selectedRooms, config.selectedFunctions);
        await this._subscribeExtraPrefixes(config.extraStatePrefixes.map(p => p.prefix));

        if (this.textCommandStateId) {
            await this.adapter.subscribeForeignStatesAsync(this.textCommandStateId);
            this.subscribedIds.add(this.textCommandStateId);
            this.adapter.log.info(`[states] Text-Command-State: ${this.textCommandStateId}`);
        }

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
            if (this.subscribedIds.has(id)) {
                continue;
            }
            await this.adapter.subscribeForeignStatesAsync(id);
            this.subscribedIds.add(id);
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

        let isSubscribed = this.subscribedIds.has(id) || id.startsWith(this.residentsPrefix);

        if (!isSubscribed) {
            isSubscribed = this.verifiedWildcardCache.has(id);
        }

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

        // Text command state → AgentTextCommand
        if (id === this.textCommandStateId && state.ack === false) {
            const text = String(state.val ?? '').trim();
            if (text) {
                this.send({ text_command: { text } });
                this.adapter.log.debug(`[states] TextCommand: ${text}`);
            }
            return true;
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
        try {
            const parsed = JSON.parse(value);
            await this.adapter.setForeignStateAsync(stateId, { val: parsed, ack: false });
            this.adapter.log.debug(`[states] SetState ${stateId} = ${value}`);
        } catch (e) {
            this.adapter.log.error(`[states] SetState failed for ${stateId}: ${(e as Error).message}`);
        }
    }

    /**
     * Read and forward the current value of all subscribed states.
     * Replaces MQTT retained messages — called once after all subscriptions are set up.
     */
    private async _sendSnapshot(): Promise<void> {
        let sent = 0;
        for (const pattern of this.subscribedIds) {
            try {
                const states = await this.adapter.getForeignStatesAsync(pattern);
                for (const [id, state] of Object.entries(states)) {
                    if (!state) {
                        continue;
                    }
                    this.send({
                        state_update: {
                            state_id: id,
                            value: JSON.stringify(state.val),
                            ack: state.ack ?? false,
                            ts: state.ts ?? Date.now(),
                        },
                    });
                    sent++;
                }
            } catch (e) {
                this.adapter.log.warn(`[states] Snapshot failed for ${pattern}: ${(e as Error).message}`);
            }
        }
        this.adapter.log.info(`[states] Snapshot: ${sent} current state values sent.`);
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
}
