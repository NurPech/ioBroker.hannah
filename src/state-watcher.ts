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

    constructor(adapter: utils.AdapterInstance, send: AgentMessageSender, textCommandStateId: string) {
        this.adapter = adapter;
        this.send = send;
        this.textCommandStateId = textCommandStateId;
    }

    /**
     * Discover and subscribe to all relevant states.
     *
     * @param config
     * @param config.selectedRooms
     * @param config.selectedFunctions
     * @param config.extraStatePrefixes
     */
    async start(config: {
        selectedRooms: string[];
        selectedFunctions: string[];
        extraStatePrefixes: Array<{ prefix: string }>;
    }): Promise<void> {
        await this._subscribeEnumStates(config.selectedRooms, config.selectedFunctions);
        await this._subscribeExtraPrefixes(config.extraStatePrefixes.map(p => p.prefix));

        if (this.textCommandStateId) {
            await this.adapter.subscribeForeignStatesAsync(this.textCommandStateId);
            this.subscribedIds.add(this.textCommandStateId);
            this.adapter.log.info(`[states] Text-Command-State: ${this.textCommandStateId}`);
        }

        this.adapter.log.info(`[states] ${this.subscribedIds.size} States subscribed.`);
    }

    /**
     * Subscribe additional state IDs on demand (from AgentWatchMore).
     *
     * @param stateIds
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
     * @param id
     * @param state
     */
    onStateChange(id: string, state: ioBroker.State | null | undefined): boolean {
        if (!this.subscribedIds.has(id) && !id.startsWith('residents.')) {
            return false;
        }
        if (!state) {
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
        const msg = {
            state_update: {
                state_id: id,
                value: JSON.stringify(state.val),
                ack: state.ack ?? false,
                ts: state.ts ?? Date.now(),
            },
        };
        this.send(msg);
        return true;
    }

    /**
     * Hannah instructs the adapter to set a state in ioBroker.
     *
     * @param stateId
     * @param value
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

    async stop(): Promise<void> {
        for (const id of this.subscribedIds) {
            await this.adapter.unsubscribeForeignStatesAsync(id);
        }
        this.subscribedIds.clear();
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
            this.adapter.log.error(`[states] getObjectViewAsync fehlgeschlagen: ${(e as Error).message}`);
            return;
        }

        // Raum-Enums enthalten Device-IDs; Funktions-Enums enthalten State-IDs direkt
        const roomDevices = this._extractViewMembers(roomResult.rows, selectedRooms);
        const funcStates = this._extractViewMembers(funcResult.rows, selectedFunctions);

        this.adapter.log.info(
            `[states] Enum-Discovery: ${roomResult.rows.length} room enums (${roomDevices.size} devices), ${funcResult.rows.length} function enums (${funcStates.size} states)`,
        );

        if (selectedRooms.length === 0 && selectedFunctions.length === 0) {
            // Keine Selektion → alle Funktions-States + Pattern-Subscribe für alle Raum-Devices
            for (const deviceId of roomDevices) {
                const pattern = `${deviceId}.*`;
                if (this.subscribedIds.has(pattern)) { continue; }
                await this.adapter.subscribeForeignStatesAsync(pattern);
                this.subscribedIds.add(pattern);
            }
            for (const stateId of funcStates) {
                if (this.subscribedIds.has(stateId)) { continue; }
                await this.adapter.subscribeForeignStatesAsync(stateId);
                this.subscribedIds.add(stateId);
            }
        } else if (selectedRooms.length === 0) {
            // Nur Funktionen gewählt → alle States der gewählten Funktions-Enums
            for (const stateId of funcStates) {
                if (this.subscribedIds.has(stateId)) { continue; }
                await this.adapter.subscribeForeignStatesAsync(stateId);
                this.subscribedIds.add(stateId);
            }
        } else if (selectedFunctions.length === 0) {
            // Nur Räume gewählt → Pattern-Subscribe für alle States unter den Raum-Devices
            for (const deviceId of roomDevices) {
                const pattern = `${deviceId}.*`;
                if (this.subscribedIds.has(pattern)) { continue; }
                await this.adapter.subscribeForeignStatesAsync(pattern);
                this.subscribedIds.add(pattern);
            }
        } else {
            // Beide gewählt → Funktions-States die zu einem Device des gewählten Raums gehören
            for (const stateId of funcStates) {
                const belongsToRoom = [...roomDevices].some(d => stateId.startsWith(`${d}.`));
                if (!belongsToRoom) { continue; }
                if (this.subscribedIds.has(stateId)) { continue; }
                await this.adapter.subscribeForeignStatesAsync(stateId);
                this.subscribedIds.add(stateId);
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
            const pattern = prefix.endsWith('.') ? `${prefix}*` : `${prefix}.*`;
            await this.adapter.subscribeForeignStatesAsync(pattern);
            this.subscribedIds.add(pattern);
            this.adapter.log.info(`[states] Extra-Prefix: ${pattern}`);
        }
    }
}
