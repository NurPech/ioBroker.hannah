import type * as utils from '@iobroker/adapter-core';
import { sanitizeId } from './satellites';

/**
 * Manages BLE tag location states under hannah.<instance>.ble.<label>.
 * States are created on first update and updated on every location change.
 */
export class BleWatcher {
    private adapter: utils.AdapterInstance;
    private ensuredLabels = new Set<string>();

    /**
     * @param adapter - ioBroker adapter instance
     */
    constructor(adapter: utils.AdapterInstance) {
        this.adapter = adapter;
    }

    /**
     * Called when Hannah pushes a BLE tag location update.
     * Creates hannah.<instance>.ble.<label>.{room,satellite,rssi} on first call.
     *
     * @param label - Human-readable tag name used as the state path segment
     * @param mac - MAC address (lowercase, colon-separated)
     * @param room - Room name; empty string when the tag is no longer visible
     * @param satellite - Satellite device ID that last detected the tag
     * @param rssi - Last known RSSI in dBm; 0 when room is empty
     */
    async handleBleUpdate(label: string, mac: string, room: string, satellite: string, rssi: number): Promise<void> {
        await this.ensureBleFolder();
        await this._ensureStates(label, mac);
        const ns = `ble.${sanitizeId(label)}`;
        await Promise.all([
            this.adapter.setState(`${ns}.room`, { val: room || null, ack: true }),
            this.adapter.setState(`${ns}.satellite`, { val: satellite || null, ack: true }),
            this.adapter.setState(`${ns}.rssi`, { val: rssi || null, ack: true }),
        ]);
        this.adapter.log.debug(`[ble] ${label}: room=${room || 'none'} satellite=${satellite || 'none'} rssi=${rssi}`);
    }

    private async _ensureStates(label: string, mac: string): Promise<void> {
        if (this.ensuredLabels.has(label)) {
            return;
        }
        this.ensuredLabels.add(label);

        const ns = `ble.${sanitizeId(label)}`;
        await this.adapter.setObjectNotExistsAsync(ns, {
            type: 'channel',
            common: { name: label },
            native: { mac },
        });
        await this.adapter.setObjectNotExistsAsync(`${ns}.room`, {
            type: 'state',
            common: { name: 'Current Room', type: 'string', role: 'text', read: true, write: false, def: null },
            native: {},
        });
        await this.adapter.setObjectNotExistsAsync(`${ns}.satellite`, {
            type: 'state',
            common: { name: 'Detecting Satellite', type: 'string', role: 'text', read: true, write: false, def: null },
            native: {},
        });
        await this.adapter.setObjectNotExistsAsync(`${ns}.rssi`, {
            type: 'state',
            common: { name: 'RSSI', type: 'number', role: 'value', unit: 'dBm', read: true, write: false, def: null },
            native: {},
        });
    }

    private async ensureBleFolder(): Promise<void> {
        await this.adapter.setObjectNotExistsAsync('ble', {
            type: 'folder',
            common: { name: 'BLE Tags' },
            native: {},
        });
    }
}
