import type * as utils from '@iobroker/adapter-core';
import type { AgentMessageSender } from './grpc-client';

/**
 * Watches the residents adapter presence states and forwards changes
 * as AgentResidentUpdate messages to Hannah Core.
 * Covers roomies, guests, and any other resident types (e.g. pets).
 */
export class ResidentsWatcher {
    private adapter: utils.AdapterInstance;
    private send: AgentMessageSender;
    private instance: string;
    private lastSent = new Map<string, number>();

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

    /** Subscribe to all presence states under residents.<instance>.*.*.presence.state */
    async subscribe(): Promise<void> {
        const pattern = `residents.${this.instance}.*.*.presence.state`;
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

        // Extract type and id from: residents.<instance>.<type>.<resident_id>.presence.state
        const match = id.match(/\.(roomie|guest)\.([^.]+)\.presence\.state$/);
        if (!match) {
            // Silently skip unknown resident types (e.g. pet) — AgentResidentUpdate only
            // supports roomie/guest via is_guest:bool. Proto extension needed for pets.
            return;
        }

        const residentType = match[1];
        const residentId = match[2];
        const presenceState = typeof state.val === 'number' ? state.val : parseInt(String(state.val), 10) || 0;

        const key = `${residentType}/${residentId}`;
        if (this.lastSent.get(key) === presenceState) {
            return;
        }
        this.lastSent.set(key, presenceState);

        this.send({
            resident_update: {
                roomie_id: residentId,
                presence_state: presenceState,
                is_guest: residentType === 'guest',
            },
        });

        this.adapter.log.info(`[residents] ${key} → presence_state=${presenceState}`);
    }

    /**
     * resident state changes from Hannah Core (via set_resident command) are handled here.
     *
     * @param residentId - ID of the resident (e.g. "john_doe")
     * @param value - JSON-encoded value to set (e.g. {"presence_state": 1, "is_guest": false})
     */
    /**
     * Hannah instructs the adapter to set a resident's presence state.
     * is_guest determines the path: .roomie. for roomies, .guest. for guests.
     *
     * @param residentId - Resident ID (e.g. "leonie", "hannah")
     * @param presenceState - Presence value from the residents adapter
     * @param isGuest - True for guests, false for roomies
     */
    public async handleSetResident(residentId: string, presenceState: number, isGuest: boolean): Promise<void> {
        const type = isGuest ? 'guest' : 'roomie';
        const stateId = `residents.${this.instance}.${type}.${residentId}.presence.state`;
        try {
            await this.adapter.setForeignStateAsync(stateId, { val: presenceState, ack: false });
            this.adapter.log.debug(`[residents] SetResident ${type}/${residentId} → ${presenceState}`);
        } catch (e) {
            this.adapter.log.error(`[residents] SetResident failed for ${stateId}: ${(e as Error).message}`);
        }
    }

    /** Unsubscribe from all presence states. */
    async unsubscribe(): Promise<void> {
        const pattern = `residents.${this.instance}.*.*.presence.state`;
        await this.adapter.unsubscribeForeignStatesAsync(pattern);
    }
}
