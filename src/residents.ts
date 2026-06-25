import type * as utils from '@iobroker/adapter-core';
import type { AgentMessageSender } from './grpc-client';

// String-Enum, nicht numerisch: grpc-client.ts lädt das Proto mit `enums: String`
// (siehe loadSync-Optionen) — eingehende Commands liefern den Enum-Namen als String,
// kein numerischer Wert.
enum ResidentType {
    UNSPECIFIED = 'RESIDENT_TYPE_UNSPECIFIED',
    ROOMIE = 'ROOMIE',
    GUEST = 'GUEST',
    PET = 'PET',
}

const RESIDENT_PATH_SEGMENTS: Record<string, ResidentType> = {
    roomie: ResidentType.ROOMIE,
    guest: ResidentType.GUEST,
    pet: ResidentType.PET,
};

function residentTypeToSegment(type: ResidentType): string {
    switch (type) {
        case ResidentType.GUEST:
            return 'guest';
        case ResidentType.PET:
            return 'pet';
        default:
            return 'roomie';
    }
}

type AgentResident = {
    roomie_id: string;
    name: string;
    type: ResidentType;
    presence_state: number;
    mood_level?: number; // Das '?' entspricht dem 'optional' aus der Proto-Datei
};

/**
 * Watches the residents adapter presence states and forwards changes
 * as AgentResident updates to Hannah Core.
 * Covers roomies, guests, and pets.
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
        await this.adapter.subscribeForeignObjectsAsync(`residents.${this.instance}.*.*`);
        this.adapter.log.info(`[residents] Subscribed: ${pattern}`);
        await this._sendSnapshot();
        this.adapter.log.info(`[residents] sent snapshot`);
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
        const match = id.match(/\.(roomie|guest|pet)\.([^.]+)\.presence\.state$/);
        if (!match) {
            return;
        }

        const segment = match[1];
        const residentId = match[2];
        const presenceState = typeof state.val === 'number' ? state.val : parseInt(String(state.val), 10) || 0;

        const key = `${segment}/${residentId}`;
        if (this.lastSent.get(key) === presenceState) {
            return;
        }
        this.lastSent.set(key, presenceState);

        this.send({
            resident_update: {
                roomie_id: residentId,
                presence_state: presenceState,
                type: RESIDENT_PATH_SEGMENTS[segment],
            },
        });

        this.adapter.log.info(`[residents] ${key} → presence_state=${presenceState}`);
    }

    /**
     * Call from onForeignObjectChange when a residents object changes.
     *
     * @param id - State ID that changed
     */
    onObjectChange(id: string): void {
        // Only react to the resident device object itself (depth 4: residents.0.roomie.leonie),
        // not to sub-objects like residents.0.roomie.leonie.activity.focus.
        const parts = id.split('.');
        if (parts.length !== 4) {
            return;
        }
        if (
            id.startsWith(`residents.${this.instance}.roomie.`) ||
            id.startsWith(`residents.${this.instance}.guest.`) ||
            id.startsWith(`residents.${this.instance}.pet.`)
        ) {
            this.adapter.log.info(`[residents] Resident added/removed: ${id} — sending updated snapshot`);
            void this._sendSnapshot();
        }
    }

    private _getObjectName(obj: ioBroker.Object, fallback: string): string {
        const name = obj.common?.name;

        if (typeof name === 'string') {
            return name;
        }

        if (name && typeof name === 'object') {
            return name.de ?? name.en ?? Object.values(name)[0] ?? fallback;
        }

        return fallback;
    }

    /**
     * Hannah instructs the adapter to set a resident's presence state.
     * type determines the path: .roomie./.guest./.pet.
     *
     * @param residentId - Resident ID (e.g. "leonie", "hannah")
     * @param presenceState - Presence value from the residents adapter
     * @param type - ResidentType as decoded from the gRPC command (string enum, see ResidentType)
     */
    public async handleSetResident(residentId: string, presenceState: number, type: ResidentType): Promise<void> {
        const segment = residentTypeToSegment(type);
        const stateId = `residents.${this.instance}.${segment}.${residentId}.presence.state`;
        try {
            await this.adapter.setForeignStateAsync(stateId, { val: presenceState, ack: false });
            this.adapter.log.debug(`[residents] SetResident ${segment}/${residentId} → ${presenceState}`);
        } catch (e) {
            this.adapter.log.error(`[residents] SetResident failed for ${stateId}: ${(e as Error).message}`);
        }
    }

    /**
     * Hannah instructs the adapter to set a resident's mood, independent of presence.
     *
     * @param residentId - Resident ID (e.g. "leonie", "hannah")
     * @param mood - Mood value from the linked Hannah User
     * @param type - ResidentType as decoded from the gRPC command (string enum, see ResidentType)
     */
    public async handleSetResidentMood(residentId: string, mood: number, type: ResidentType): Promise<void> {
        const segment = residentTypeToSegment(type);
        const stateId = `residents.${this.instance}.${segment}.${residentId}.mood.state`;
        try {
            await this.adapter.setForeignStateAsync(stateId, { val: mood, ack: false });
            this.adapter.log.debug(`[residents] SetResidentMood ${segment}/${residentId} → ${mood}`);
        } catch (e) {
            this.adapter.log.error(`[residents] SetResidentMood failed for ${stateId}: ${(e as Error).message}`);
        }
    }

    private async _sendSnapshot(): Promise<void> {
        const patterns = [
            `residents.${this.instance}.roomie.*`,
            `residents.${this.instance}.guest.*`,
            `residents.${this.instance}.pet.*`,
        ];

        const residents: AgentResident[] = [];
        let sent = 0;

        for (const pattern of patterns) {
            const objects = await this.adapter.getForeignObjectsAsync(pattern, 'device');

            for (const [id, obj] of Object.entries(objects)) {
                const parts = id.split('.');

                if (parts.length !== 4) {
                    continue;
                }

                const residentId = parts[3];
                const presenceState = await this.adapter.getForeignStateAsync(`${id}.presence.state`);
                const moodState = await this.adapter.getForeignStateAsync(`${id}.mood.state`);

                residents.push({
                    name: this._getObjectName(obj, residentId),
                    roomie_id: residentId,
                    mood_level: typeof moodState?.val === 'number' ? moodState.val : undefined,
                    type: RESIDENT_PATH_SEGMENTS[parts[2]],
                    presence_state: typeof presenceState?.val === 'number' ? presenceState.val : 0,
                });
                sent++;
            }
        }

        this.send({
            send_residents: {
                residents,
            },
        });

        this.adapter.log.info(`[residents] Snapshot: ${sent} current device states sent.`);
    }

    /** Unsubscribe from all presence states. */
    async unsubscribe(): Promise<void> {
        const pattern = `residents.${this.instance}.*.*.presence.state`;
        await this.adapter.unsubscribeForeignStatesAsync(pattern);
    }
}
