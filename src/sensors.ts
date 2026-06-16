import type * as utils from '@iobroker/adapter-core';

/**
 * Manages satellite sensor states under hannah.<instance>.satellites.<device>.sensors.
 * States are created on first update and updated on every reading.
 */
export class SensorWatcher {
    private adapter: utils.AdapterInstance;
    private ensuredDevices = new Set<string>();

    /** @param adapter - ioBroker adapter instance */
    constructor(adapter: utils.AdapterInstance) {
        this.adapter = adapter;
    }

    /**
     * Called when Hannah pushes a sensor update for a satellite device.
     *
     * @param device - Satellite device ID
     * @param temperature - Temperature in °C
     * @param pressure - Pressure in hPa
     * @param humidity - Relative humidity in %
     * @param gasResistance - Gas resistance in Ω (0 if not available)
     * @param iaq - IAQ 0–500 (BSEC2); 0 when not available
     * @param iaqAccuracy - BSEC2 accuracy 0–3
     * @param co2Equiv - CO₂ equivalent ppm (BSEC2); 0 when not available
     * @param vocEquiv - Breath VOC equivalent ppm (BSEC2); 0 when not available
     */
    async handleSensorUpdate(
        device: string,
        temperature: number,
        pressure: number,
        humidity: number,
        gasResistance: number,
        iaq: number,
        iaqAccuracy: number,
        co2Equiv: number,
        vocEquiv: number,
    ): Promise<void> {
        try {
            await this._ensureStates(device, gasResistance > 0, iaq > 0);
            const ns = `satellites.sensors.${device}`;
            const updates: Promise<unknown>[] = [
                this.adapter.setState(`${ns}.temperature`, { val: Math.round(temperature * 10) / 10, ack: true }),
                this.adapter.setState(`${ns}.pressure`, { val: Math.round(pressure * 10) / 10, ack: true }),
            ];
            if (humidity > 0) {
                updates.push(
                    this.adapter.setState(`${ns}.humidity`, { val: Math.round(humidity * 10) / 10, ack: true }),
                );
            }
            if (gasResistance > 0) {
                updates.push(
                    this.adapter.setState(`${ns}.gas_resistance`, { val: Math.round(gasResistance), ack: true }),
                );
            }
            if (iaq > 0) {
                updates.push(
                    this.adapter.setState(`${ns}.iaq`, { val: Math.round(iaq * 10) / 10, ack: true }),
                    this.adapter.setState(`${ns}.iaq_accuracy`, { val: iaqAccuracy, ack: true }),
                    this.adapter.setState(`${ns}.co2_equiv`, { val: Math.round(co2Equiv * 10) / 10, ack: true }),
                    this.adapter.setState(`${ns}.voc_equiv`, { val: Math.round(vocEquiv * 1000) / 1000, ack: true }),
                );
            }
            await Promise.all(updates);
            this.adapter.log.debug(
                `[sensors] ${device}: T=${temperature.toFixed(1)}°C P=${pressure.toFixed(1)}hPa H=${humidity.toFixed(1)}%` +
                (iaq > 0 ? ` IAQ=${iaq.toFixed(0)}(acc=${iaqAccuracy})` : ''),
            );
        } catch (e) {
            this.adapter.log.error(`[sensors] handleSensorUpdate failed: ${(e as Error).message}`);
        }
    }

    /**
     * Deletes a satellite's sensor object tree and clears the ensured-state
     * cache, so a future sensor update re-creates the states cleanly.
     *
     * @param device - Satellite device ID (raw)
     */
    async deleteSensors(device: string): Promise<void> {
        try {
            await this.adapter.delObjectAsync(`satellites.sensors.${device}`, { recursive: true });
        } catch {
            // No sensor tree for this device — nothing to delete.
        }
        this.ensuredDevices.delete(device);
    }

    private async _ensureStates(device: string, hasGas: boolean, hasBsec: boolean): Promise<void> {
        if (this.ensuredDevices.has(device)) {
            return;
        }
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
            common: {
                name: 'Temperature',
                type: 'number',
                role: 'value.temperature',
                unit: '°C',
                read: true,
                write: false,
            },
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
                common: {
                    name: 'Gas Resistance (VOC)',
                    type: 'number',
                    role: 'value',
                    unit: 'Ω',
                    read: true,
                    write: false,
                },
                native: {},
            });
        }
        if (hasBsec) {
            await this.adapter.setObjectNotExistsAsync(`${ns}.iaq`, {
                type: 'state',
                common: { name: 'IAQ (Air Quality Index)', type: 'number', role: 'value', unit: 'IAQ', read: true, write: false },
                native: {},
            });
            await this.adapter.setObjectNotExistsAsync(`${ns}.iaq_accuracy`, {
                type: 'state',
                common: { name: 'IAQ Accuracy (0–3)', type: 'number', role: 'value', read: true, write: false },
                native: {},
            });
            await this.adapter.setObjectNotExistsAsync(`${ns}.co2_equiv`, {
                type: 'state',
                common: { name: 'CO₂ Equivalent', type: 'number', role: 'value.co2', unit: 'ppm', read: true, write: false },
                native: {},
            });
            await this.adapter.setObjectNotExistsAsync(`${ns}.voc_equiv`, {
                type: 'state',
                common: { name: 'Breath VOC Equivalent', type: 'number', role: 'value', unit: 'ppm', read: true, write: false },
                native: {},
            });
        }
    }
}
