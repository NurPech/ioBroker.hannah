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
     * @param stateId
     * @param value
     */
    async handleSetState(stateId: string, value: string): Promise<void> {
        try {
            const parsed = JSON.parse(value);
            await this.adapter.setForeignStateAsync(stateId, { val: parsed, ack: false });
            this.adapter.log.debug(`[states] SetState ${stateId} = ${value}`);
        } catch (e) {
            this.adapter.log.error(`[states] SetState fehlgeschlagen für ${stateId}: ${(e as Error).message}`);
        }
    }

    async stop(): Promise<void> {
        for (const id of this.subscribedIds) {
            await this.adapter.unsubscribeForeignStatesAsync(id);
        }
        this.subscribedIds.clear();
    }

    private async _subscribeEnumStates(selectedRooms: string[], selectedFunctions: string[]): Promise<void> {
        const roomEnumId = 'enum.rooms';
        const funcEnumId = 'enum.functions';

        const [roomsObj, funcsObj] = await Promise.all([
            this.adapter.getObjectAsync(roomEnumId),
            this.adapter.getObjectAsync(funcEnumId),
        ]);

        const roomIds = this._collectEnumMembers(roomsObj, selectedRooms);
        const funcIds = this._collectEnumMembers(funcsObj, selectedFunctions);

        // Union of all state IDs referenced by selected (or all) rooms AND functions
        const stateIds =
            selectedRooms.length === 0 && selectedFunctions.length === 0
                ? new Set([...roomIds, ...funcIds])
                : new Set([...roomIds].filter(id => funcIds.has(id)));

        for (const id of stateIds) {
            if (this.subscribedIds.has(id)) {
                continue;
            }
            await this.adapter.subscribeForeignStatesAsync(id);
            this.subscribedIds.add(id);
        }

        this.adapter.log.info(`[states] Enum-Discovery: ${stateIds.size} States (rooms × functions).`);
    }

    private _collectEnumMembers(enumObj: ioBroker.Object | null | undefined, selected: string[]): Set<string> {
        const ids = new Set<string>();
        if (!enumObj || enumObj.type !== 'enum') {
            return ids;
        }

        const children = (enumObj as any).children as Record<string, { common?: { members?: string[] } }> | undefined;
        if (!children) {
            return ids;
        }

        for (const [childId, child] of Object.entries(children)) {
            if (selected.length > 0 && !selected.includes(childId)) {
                continue;
            }
            for (const memberId of child.common?.members ?? []) {
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
