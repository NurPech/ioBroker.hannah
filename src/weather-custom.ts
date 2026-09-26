import type * as utils from '@iobroker/adapter-core';
import type { AgentMessageSender } from './grpc-client';
import { WeatherSource, type BucketField } from './weather-source';

/** Manual state-ID mapping for "custom" mode — current-conditions only, no forecast. */
export interface WeatherCustomMapping {
    /** State ID holding the current temperature (°C) */
    temperature?: string;
    /** State ID holding the current relative humidity (%) */
    humidity?: string;
    /** State ID holding a textual condition description */
    conditionText?: string;
    /** State ID holding current precipitation (mm) */
    precipitationMm?: string;
    /** State ID holding current wind speed (m/s) */
    windSpeedMs?: string;
    /** State ID holding current wind direction as text */
    windDirectionText?: string;
}

const CUSTOM_FIELD_MAP: ReadonlyArray<[keyof WeatherCustomMapping, BucketField]> = [
    ['temperature', 'temperature'],
    ['humidity', 'humidity'],
    ['conditionText', 'conditionDetail'],
    ['precipitationMm', 'precipitationMm'],
    ['windSpeedMs', 'windSpeedMs'],
    ['windDirectionText', 'windDirectionText'],
];

/** "Custom" mode — manually configured state IDs, current-conditions only (v1 scope). */
export class CustomWeatherSource extends WeatherSource {
    private readonly mapping: WeatherCustomMapping;

    /**
     * @param adapter - ioBroker adapter instance
     * @param send - Function to send messages to Hannah Core
     * @param mapping - Manual field → state ID mapping
     */
    constructor(adapter: utils.AdapterInstance, send: AgentMessageSender, mapping: WeatherCustomMapping) {
        super(adapter, send);
        this.mapping = mapping;
    }

    protected get label(): string {
        return 'custom mapping';
    }

    protected discover(): Promise<string[]> {
        for (const [mappingKey, field] of CUSTOM_FIELD_MAP) {
            const stateId = this.mapping[mappingKey];
            if (stateId) {
                this.targets.set(stateId, { bucket: 'current', field });
            }
        }
        return Promise.resolve([...this.targets.keys()]);
    }
}
