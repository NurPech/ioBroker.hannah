/**
 * Device detection on top of `@iobroker/type-detector`.
 *
 * The detector looks at the objects of a channel or device and says what kind of device it is
 * (`dimmer`, `socket`, `thermostat`, ...) and which of its states plays which part (a tag like
 * `SET`, `ACTUAL`, `ELECTRIC_POWER`). This module turns that into what the typed device model
 * works with: a semantic key per state (see `slotKey()` in device-model.ts) and a type hint per
 * device. It is a pure function of the objects (no adapter, no I/O), so every rule is testable
 * with fixtures.
 *
 * The detector only suggests: an explicit override in `common.custom` still wins, and a state
 * the detector has no tag for keeps whatever the role table and the state name make of it.
 */
import ChannelDetector from '@iobroker/type-detector';

/** What the detector made of one state. */
export interface DetectedState {
    /** semantic key of the state, same vocabulary as `slotKey()` */
    key: string;
    /** type hint of the device the state belongs to, empty = none */
    typeHint: string;
}

/** The detector's type → type hint of the typed device model. */
const TYPE_HINTS: Record<string, string> = {
    light: 'light',
    dimmer: 'light',
    rgb: 'light',
    rgbSingle: 'light',
    rgbwSingle: 'light',
    ct: 'light',
    hue: 'light',
    cie: 'light',
    socket: 'socket',
    blind: 'blind',
    thermostat: 'thermostat',
    airCondition: 'climate',
    temperature: 'temperature_sensor',
    humidity: 'humidity_sensor',
    illuminance: 'illuminance_sensor',
    window: 'window',
    windowTilt: 'window',
    door: 'door',
};

/** Tags that mean the same in every detector type: the electrical readings. */
const ELECTRICAL_TAGS: Record<string, string> = {
    ELECTRIC_POWER: 'power',
    CONSUMPTION: 'energy',
    VOLTAGE: 'voltage',
    CURRENT: 'electricCurrent',
};

const LIGHT_TAGS: Record<string, string> = {
    ON: 'on',
    ON_SET: 'on',
    ON_ACTUAL: 'on',
    DIMMER: 'level',
    BRIGHTNESS: 'level',
    RGB: 'color',
    TEMPERATURE: 'colorTemp',
    ...ELECTRICAL_TAGS,
};

const THERMOSTAT_TAGS: Record<string, string> = {
    SET: 'expected',
    SET_HEATING: 'expected',
    ACTUAL: 'temperature',
    HUMIDITY: 'humidity',
    POWER: 'on',
    VALVE: 'valve',
    ...ELECTRICAL_TAGS,
};

const CONTACT_TAGS: Record<string, string> = { ACTUAL: 'open' };

/**
 * Detector type → tag → semantic key. A state whose tag is not listed (an indicator like
 * UNREACH, a CIE colour, a RGBW string) is left to the role table and its name.
 */
const KEYS_BY_TYPE: Record<string, Record<string, string>> = {
    light: { SET: 'on', ...LIGHT_TAGS },
    dimmer: { SET: 'level', ACTUAL: 'level', ...LIGHT_TAGS },
    rgb: LIGHT_TAGS,
    rgbSingle: LIGHT_TAGS,
    rgbwSingle: LIGHT_TAGS,
    ct: LIGHT_TAGS,
    hue: LIGHT_TAGS,
    cie: LIGHT_TAGS,
    socket: { SET: 'on', ACTUAL: 'on', ...ELECTRICAL_TAGS },
    blind: { SET: 'level', ACTUAL: 'level', STOP: 'stop', TILT_SET: 'tilt', TILT_ACTUAL: 'tilt' },
    thermostat: THERMOSTAT_TAGS,
    airCondition: {
        ...THERMOSTAT_TAGS,
        MODE: 'mode',
        SPEED: 'fanSpeed',
    },
    temperature: { ACTUAL: 'temperature', SECOND: 'humidity' },
    humidity: { ACTUAL: 'humidity' },
    illuminance: { ACTUAL: 'illuminance' },
    airQuality: {
        AQI: 'iaq',
        CO2: 'co2_equiv',
        TVOC: 'voc_equiv',
        ACTUAL: 'temperature',
        HUMIDITY: 'humidity',
        PRESSURE: 'pressure',
        POWER: 'on',
    },
    motion: { ACTUAL: 'motion' },
    contact: CONTACT_TAGS,
    window: CONTACT_TAGS,
    windowTilt: CONTACT_TAGS,
    door: CONTACT_TAGS,
    electricity: ELECTRICAL_TAGS,
};

/** Detector types that only describe a side aspect of a device and are no device of their own. */
const IGNORED_TYPES = new Set(['info', 'instance', 'unknown']);

/** Finds the devices in a set of ioBroker objects. */
export class DeviceDetector {
    private readonly detector = new ChannelDetector();
    private readonly keys: string[];

    /**
     * @param objects - The objects of the setup the detector may look at: the states, their
     *   channels and devices, and the room and function enums
     */
    constructor(private readonly objects: Record<string, ioBroker.Object>) {
        this.keys = Object.keys(objects).sort();
    }

    /**
     * What the detector says about the states of one channel or device. A state it recognizes
     * gets a key and the device a type hint; every other state is left out.
     *
     * @param groupId - ID of the channel or device whose states are looked at
     */
    detect(groupId: string): Map<string, DetectedState> {
        const found = new Map<string, DetectedState>();
        let patterns;
        try {
            patterns = this.detector.detect({
                objects: this.objects,
                id: groupId,
                _keysOptional: this.keys,
                _keysOptionalSorted: true,
                ignoreCache: true,
            });
        } catch {
            // a malformed object must not take the whole snapshot down
            return found;
        }
        for (const pattern of patterns ?? []) {
            if (IGNORED_TYPES.has(pattern.type)) {
                continue;
            }
            const keys = KEYS_BY_TYPE[pattern.type] ?? {};
            const typeHint = TYPE_HINTS[pattern.type] ?? '';
            for (const state of pattern.states) {
                const key = keys[state.name];
                if (state.id && key && !found.has(state.id)) {
                    found.set(state.id, { key, typeHint });
                }
            }
        }
        return found;
    }
}
