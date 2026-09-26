import type * as utils from '@iobroker/adapter-core';
import type { AgentMessageSender } from './grpc-client';
import { CustomWeatherSource, type WeatherCustomMapping } from './weather-custom';
import { DasWetterSource } from './weather-daswetter';
import { OpenWeatherMapSource } from './weather-openweathermap';
import type { WeatherSource } from './weather-source';

export type { WeatherCustomMapping } from './weather-custom';
export type { WeatherSource } from './weather-source';

/** Weather source selection from the adapter config. */
export interface WeatherSourceConfig {
    /** '' | 'openweathermap' | 'daswetter' | 'custom' | 'accuweather' (deprecated) */
    adapterType: string;
    /** e.g. "0"; ignored when adapterType === 'custom' */
    instance: string;
    /** daswetter only: location channel, e.g. "location_1" */
    location: string;
    /** Only used when adapterType === 'custom' */
    customMapping: WeatherCustomMapping;
}

/**
 * Creates the weather source matching the configured adapter type, or null if weather
 * is disabled. Each supported weather adapter gets its own source class — their object
 * trees differ too much for one generic parser (#191).
 *
 * @param adapter - ioBroker adapter instance
 * @param send - Function to send messages to Hannah Core
 * @param config - Weather source selection
 */
export function createWeatherSource(
    adapter: utils.AdapterInstance,
    send: AgentMessageSender,
    config: WeatherSourceConfig,
): WeatherSource | null {
    const instance = config.instance || '0';
    switch (config.adapterType) {
        case '':
            return null;
        case 'custom':
            return new CustomWeatherSource(adapter, send, config.customMapping);
        case 'daswetter':
            return new DasWetterSource(adapter, send, instance, config.location || 'location_1');
        case 'accuweather':
            // Deprecated: AccuWeather dropped its free API tier, so there's no reliable
            // reference for the ioBroker adapter's object tree. Still a valid config value
            // so existing configs keep loading — it just forwards nothing (#192).
            adapter.log.warn(
                '[weather] accuweather is no longer supported, no weather data will be forwarded to Hannah. Please select another weather source.',
            );
            return null;
        default:
            return new OpenWeatherMapSource(adapter, send, config.adapterType, instance);
    }
}
