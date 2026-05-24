import type * as utils from '@iobroker/adapter-core';

/**
 * Manages satellite sensor states under hannah.<instance>.satellites.<device>.sensors.
 * States are created on first update and updated on every reading.
 */
export class SensorWatcher {
    private adapter: utils.AdapterInstance;
    private ensuredDevices = new Set<string>();

    constructor(adapter: utils.AdapterInstance) {
        this.adapter = adapter;
    }

    async handleSensorUpdate(
        device: string,
        temperature: number,
        pressure: number,
        humidity: number,
        gasResistance: number,
    ): Promise<void> {
        try {
        await this._ensureStates(device, gasResistance > 0);
        const ns = `satellites.sensors.${device}`;
        const updates: Promise<unknown>[] = [
            this.adapter.setState(`${ns}.temperature`, { val: Math.round(temperature * 10) / 10, ack: true }),
            this.adapter.setState(`${ns}.pressure`, { val: Math.round(pressure * 10) / 10, ack: true }),
        ];
        if (humidity > 0) {
            updates.push(this.adapter.setState(`${ns}.humidity`, { val: Math.round(humidity * 10) / 10, ack: true }));
        }
        if (gasResistance > 0) {
            updates.push(this.adapter.setState(`${ns}.gas_resistance`, { val: Math.round(gasResistance), ack: true }));
        }
        await Promise.all(updates);
        this.adapter.log.debug(`[sensors] ${device}: T=${temperature.toFixed(1)}°C P=${pressure.toFixed(1)}hPa H=${humidity.toFixed(1)}% Gas=${gasResistance.toFixed(0)}`);
        } catch (e) {
            this.adapter.log.error(`[sensors] handleSensorUpdate failed: ${(e as Error).message}`);
        }
    }

    private async _ensureStates(device: string, hasGas: boolean): Promise<void> {
        if (this.ensuredDevices.has(device)) return;
        this.ensuredDevices.add(device);

        const ns = `satellites.sensors.${device}`;
        await this.adapter.setObjectNotExistsAsync('satellites.sensors', {
            type: 'folder',
            common: { name: 'Sensor Readings' },
            native: {},
        });
        await this.adapter.setObjectNotExistsAsync(`satellites.sensors.${device}`, {
            type: 'channel',
            common: { name: `${device} Sensors` },
            native: {},
        });
        await this.adapter.setObjectNotExistsAsync(`${ns}.temperature`, {
            type: 'state',
            common: { name: 'Temperature', type: 'number', role: 'value.temperature', unit: '°C', read: true, write: false },
            native: {},
        });
        await this.adapter.setObjectNotExistsAsync(`${ns}.pressure`, {
            type: 'state',
            common: { name: 'Pressure', type: 'number', role: 'value.pressure', unit: 'hPa', read: true, write: false },
            native: {},
        });
        await this.adapter.setObjectNotExistsAsync(`${ns}.humidity`, {
            type: 'state',
            common: { name: 'Humidity', type: 'number', role: 'value.humidity', unit: '%', read: true, write: false },
            native: {},
        });
        if (hasGas) {
            await this.adapter.setObjectNotExistsAsync(`${ns}.gas_resistance`, {
                type: 'state',
                common: { name: 'Gas Resistance (VOC)', type: 'number', role: 'value', unit: 'Ω', read: true, write: false },
                native: {},
            });
        }
    }
}
