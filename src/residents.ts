import type * as utils from '@iobroker/adapter-core';
import type { AgentMessageSender } from './grpc-client';

/**
 * Watches the residents adapter presence states and forwards changes
 * as AgentResidentUpdate messages to Hannah Core.
 */
export class ResidentsWatcher {
    private adapter: utils.AdapterInstance;
    private send: AgentMessageSender;
    private instance: string;

    /**
     * @param adapter - ioBroker adapter instance
     * @param send - Function to send messages to Hannah Core
     * @param instance - Residents adapter instance number (e.g. "0")
     */
    constructor(adapter: utils.AdapterInstance, send: AgentMessageSender, instance: string) {
        this.adapter = adapter;
        this.send = send;
        this.instance = instance;
    }

    /** Subscribe to all presence states under residents.<instance>.roomie.*.presence.state */
    async subscribe(): Promise<void> {
        const pattern = `residents.${this.instance}.roomie.*.presence.state`;
        await this.adapter.subscribeForeignStatesAsync(pattern);
        this.adapter.log.info(`[residents] Subscribed: ${pattern}`);
    }

    /**
     * Call from onForeignStateChange when a residents state changes.
     *
     * @param id - State ID that changed
     * @param state - New state value, or null/undefined if deleted
     */
    onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state || state.val === null) {
            return;
        }

        // Extract roomie_id from: residents.<instance>.roomie.<roomie_id>.presence.state
        const match = id.match(/\.roomie\.([^.]+)\.presence\.state$/);
        if (!match) {
            return;
        }

        const roomieId = match[1];
        const presenceState = typeof state.val === 'number' ? state.val : parseInt(String(state.val), 10) || 0;

        this.send({
            resident_update: {
                roomie_id: roomieId,
                presence_state: presenceState,
                is_guest: false,
            },
        });

        this.adapter.log.debug(`[residents] ${roomieId} → presence_state=${presenceState}`);
    }

    /** Unsubscribe from all presence states. */
    async unsubscribe(): Promise<void> {
        const pattern = `residents.${this.instance}.roomie.*.presence.state`;
        await this.adapter.unsubscribeForeignStatesAsync(pattern);
    }
}
