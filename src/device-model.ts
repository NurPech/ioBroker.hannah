/**
 * Typed device model (hannah.v2): ioBroker states → device classes and slots.
 *
 * The StateWatcher resolves, per state, room, name, type hint, role and value; this module
 * groups the states of a device and decides class, slots and normalized values. It is a pure
 * function of those inputs (no adapter, no I/O), so every rule is testable with fixtures.
 *
 * The rules are those Hannah Core applies to the per-state snapshot of a hannah.v1 adapter
 * (core/hannah/legacy_devices.py), so a device is classified the same way on both paths. What
 * the adapter knows on top of Core is the role of a state: it tells a color from a color
 * temperature (both used to end up on the key `color`).
 *
 * - the type hint (function/role) comes before the slot set
 * - `Thermostat` needs a setpoint, pure measuring devices are `Sensor`
 * - only writable slots control a device: a read-only `on` never makes a lamp
 * - if several states fit one slot kind, the candidates are narrowed step by step (exact role,
 *   then unit, then writability, then the name: comfort/eco/offset setpoints are no setpoints)
 *   until one is left, otherwise none is picked. What isn't picked stays a generic slot,
 *   nothing gets lost
 * - values are normalized to the scale of the slot kind (brightness 0-100 %, colour temperature
 *   in Kelvin, temperature in °C, power in W, energy in kWh); a state in a unit that doesn't
 *   fit the kind (power in mA) is not picked
 * - name and room are mandatory, a device without room is not reported
 */
import { v2 } from '@m1kad0/hannah-proto';
import type { Explain } from './device-diagnostics';

import DeviceClass = v2.device_model.DeviceClass;
import DeviceSubtype = v2.device_model.DeviceSubtype;
import SlotKind = v2.device_model.SlotKind;

/** How the value of an ioBroker state looks (common.type, role and states). */
export type ValueType = 'boolean' | 'number' | 'text' | 'enum' | 'color';

/** One ioBroker state of a device, as the StateWatcher resolved it. */
export interface DeviceState {
    /** full ioBroker state ID */
    stateId: string;
    /** last segment of the state ID */
    suffix: string;
    /** semantic key of the state, see `slotKey()` */
    key: string;
    /** common.role of the state, empty = none */
    role: string;
    /** common.unit of the state, empty = none */
    unit: string;
    /** common.min of the state, undefined = none */
    min: number | undefined;
    /** common.max of the state, undefined = none */
    max: number | undefined;
    /** raw ioBroker value */
    value: unknown;
    /** how the value looks */
    valueType: ValueType;
    /** the state can be written */
    writable: boolean;
    /** type hint for this state ("light", "blind", "climate", ...), empty = none */
    typeHint: string;
    /** actuator uses 0 % = open, 100 % = closed (blinds) */
    inverted: boolean;
    /** neededTrust from common.custom, undefined = no restriction */
    requiredTrustLevel: number | undefined;
    /** values an enum state accepts (mode, fan speed) */
    options: string[];
    /** `slot` from common.custom: the slot ID the admin says this state fills, empty or missing = none */
    slotOverride?: string;
}

/** The states of one device with what is known about the device itself. */
export interface DeviceInput {
    /** stable ID of the device (the parent object of its states) */
    deviceId: string;
    /** display name */
    name: string;
    /** room ID (enum ID segment), empty = no room */
    room: string;
    /** floor, empty = none */
    floor: string;
    /** the states that belong to the device */
    states: DeviceState[];
}

/** Where a slot is written and how its value is turned back into an ioBroker value. */
export interface SlotTarget {
    /** ioBroker state behind the slot */
    stateId: string;
    /** what the slot means */
    kind: SlotKind;
    /** cover position is inverted at the actuator */
    inverted: boolean;
    /** the slot can be controlled */
    writable: boolean;
    /** how the value of the state looks */
    valueType: ValueType;
    /** neededTrust of the slot, undefined = no restriction */
    requiredTrustLevel: number | undefined;
    /** how the raw value is turned into the scale of the kind, undefined = it already is */
    transform?: Transform;
    /** the colour is not one state but hue and saturation: `stateId` is the hue state, see `ColorCompose` */
    compose?: ColorCompose;
}

/** One of the two states a composed colour is made of. */
export interface ColorPart {
    /** ioBroker state ID */
    stateId: string;
    /** common.min of the state, undefined = none */
    min: number | undefined;
    /** common.max of the state, undefined = none */
    max: number | undefined;
    /** last raw value, kept up to date by `updateColorPart()` */
    value: unknown;
}

/** A colour made of the hue and the saturation state of a lamp that has no RGB state. */
export interface ColorCompose {
    /** the state with the role `level.color.hue` */
    hue: ColorPart;
    /** the state with the role `level.color.saturation` */
    saturation: ColorPart;
}

/** Which states say whether a device can be reached, and what they said last. */
export interface Reachability {
    /** state ID of an `indicator.reachable` state → the device it belongs to */
    deviceOf: Map<string, string>;
    /** device ID → state ID → the state is not `false` */
    states: Map<string, Map<string, boolean>>;
}

/** The typed devices of a setup and the indexes live updates and SetSlot need. */
export interface DeviceModel {
    /** the devices as sent to Core */
    devices: v2.device_model.TypedDevice[];
    /** state ID → the slot it feeds, for live updates */
    bySlotState: Map<string, { deviceId: string; slotId: string; target: SlotTarget }>;
    /** device ID → slot ID → target, for SetSlot */
    targets: Map<string, Map<string, SlotTarget>>;
    /** the `indicator.reachable` states of the devices, for `available` and its live updates */
    reachability: Reachability;
}

/** An empty device model. */
export function emptyDeviceModel(): DeviceModel {
    return {
        devices: [],
        bySlotState: new Map(),
        targets: new Map(),
        reachability: { deviceOf: new Map(), states: new Map() },
    };
}

/** The role of the state that tells whether a device can be reached. */
const REACHABLE_ROLE = 'indicator.reachable';

/**
 * A state that tells whether its device can be reached. It is no slot: Hannah has nothing to
 * set or say about it, it only decides `available`. A state the admin gave a slot is left alone.
 *
 * @param state - The state to look at
 */
function isReachableState(state: DeviceState): boolean {
    return state.role === REACHABLE_ROLE && state.valueType === 'boolean' && !state.slotOverride;
}

/**
 * A device can be reached unless one of its reachable states says `false`; no state means yes.
 *
 * @param states - The reachable states of the device by state ID, undefined = it has none
 */
function isReachable(states: Map<string, boolean> | undefined): boolean {
    return !states || [...states.values()].every(Boolean);
}

/**
 * Takes the new value of a state into account if it is one of a device's reachable states.
 *
 * @param model - The device model of the last snapshot, updated in place
 * @param stateId - The state that changed
 * @param value - Its new value; only `false` means unreachable (no value yet counts as reachable)
 * @returns The device and its new `available` if that changed, otherwise undefined
 */
export function updateReachability(
    model: DeviceModel,
    stateId: string,
    value: unknown,
): { deviceId: string; available: boolean } | undefined {
    const deviceId = model.reachability.deviceOf.get(stateId);
    const states = deviceId === undefined ? undefined : model.reachability.states.get(deviceId);
    if (deviceId === undefined || !states) {
        return undefined;
    }
    const before = isReachable(states);
    states.set(stateId, value !== false);
    const available = isReachable(states);
    return available === before ? undefined : { deviceId, available };
}

const GENERIC_KINDS = new Set<SlotKind>([
    SlotKind.SLOT_KIND_GENERIC_NUMBER,
    SlotKind.SLOT_KIND_GENERIC_BOOL,
    SlotKind.SLOT_KIND_GENERIC_TEXT,
]);
const MEASUREMENT_KINDS = new Set<SlotKind>([
    SlotKind.SLOT_KIND_TEMPERATURE,
    SlotKind.SLOT_KIND_HUMIDITY,
    SlotKind.SLOT_KIND_ILLUMINANCE,
    SlotKind.SLOT_KIND_PRESSURE,
    SlotKind.SLOT_KIND_CO2,
    SlotKind.SLOT_KIND_IAQ,
    SlotKind.SLOT_KIND_VOC,
    SlotKind.SLOT_KIND_POWER,
    SlotKind.SLOT_KIND_ENERGY,
    SlotKind.SLOT_KIND_VOLTAGE,
    SlotKind.SLOT_KIND_CURRENT,
    SlotKind.SLOT_KIND_MOTION,
]);
const ENUM_KINDS = new Set<SlotKind>([SlotKind.SLOT_KIND_MODE, SlotKind.SLOT_KIND_FAN_SPEED]);
const BOOL_KINDS = new Set<SlotKind>([
    SlotKind.SLOT_KIND_ON,
    SlotKind.SLOT_KIND_OPEN,
    SlotKind.SLOT_KIND_MOTION,
    SlotKind.SLOT_KIND_STOP,
    SlotKind.SLOT_KIND_GENERIC_BOOL,
]);
const TEXT_KINDS = new Set<SlotKind>([
    SlotKind.SLOT_KIND_GENERIC_TEXT,
    SlotKind.SLOT_KIND_MODE,
    SlotKind.SLOT_KIND_FAN_SPEED,
]);

/** How a raw value becomes the scale of its slot kind: `linear` is `raw * mul + add`, `mired` is 10^6 / raw. */
export type Transform = { kind: 'linear'; mul: number; add: number } | { kind: 'mired' };

/** Semantic key of a state → slot kind (`level` and `current` depend on the type hint). */
const KIND_BY_KEY: Record<string, SlotKind> = {
    on: SlotKind.SLOT_KIND_ON,
    color: SlotKind.SLOT_KIND_COLOR,
    colorTemp: SlotKind.SLOT_KIND_COLOR_TEMPERATURE,
    expected: SlotKind.SLOT_KIND_TARGET_TEMPERATURE,
    illuminance: SlotKind.SLOT_KIND_ILLUMINANCE,
    open: SlotKind.SLOT_KIND_OPEN,
    iaq: SlotKind.SLOT_KIND_IAQ,
    co2_equiv: SlotKind.SLOT_KIND_CO2,
    voc_equiv: SlotKind.SLOT_KIND_VOC,
    power: SlotKind.SLOT_KIND_POWER,
    energy: SlotKind.SLOT_KIND_ENERGY,
    voltage: SlotKind.SLOT_KIND_VOLTAGE,
    electricCurrent: SlotKind.SLOT_KIND_CURRENT,
    // `current` is the old key for temperature and humidity alike, these two are unambiguous
    temperature: SlotKind.SLOT_KIND_TEMPERATURE,
    humidity: SlotKind.SLOT_KIND_HUMIDITY,
    pressure: SlotKind.SLOT_KIND_PRESSURE,
    valve: SlotKind.SLOT_KIND_VALVE,
    tilt: SlotKind.SLOT_KIND_TILT,
    stop: SlotKind.SLOT_KIND_STOP,
    motion: SlotKind.SLOT_KIND_MOTION,
};

/** Roles that name a slot kind exactly, the first tie-break step. */
const ROLES_BY_KIND: Partial<Record<SlotKind, string[]>> = {
    [SlotKind.SLOT_KIND_ON]: ['switch', 'switch.light', 'switch.power'],
    [SlotKind.SLOT_KIND_BRIGHTNESS]: ['level.dimmer', 'level.brightness'],
    [SlotKind.SLOT_KIND_COLOR]: ['level.color.rgb', 'level.color.hex', 'level.color'],
    [SlotKind.SLOT_KIND_COLOR_TEMPERATURE]: ['level.color.temperature'],
    [SlotKind.SLOT_KIND_POSITION]: ['level.blind', 'level.curtain', 'level.valve'],
    [SlotKind.SLOT_KIND_TARGET_TEMPERATURE]: ['level.temperature'],
    [SlotKind.SLOT_KIND_TEMPERATURE]: ['value.temperature'],
    [SlotKind.SLOT_KIND_HUMIDITY]: ['value.humidity'],
    [SlotKind.SLOT_KIND_ILLUMINANCE]: ['value.brightness', 'value.illuminance'],
    [SlotKind.SLOT_KIND_POWER]: ['value.power'],
    [SlotKind.SLOT_KIND_ENERGY]: ['value.power.consumption', 'value.energy', 'value.energy.consumed'],
};

/** Roles that mean energy (kWh), not power: ioBroker calls the consumption `value.power.consumption`. */
const ENERGY_ROLES = new Set([
    'value.power.consumption',
    'value.energy',
    'value.energy.consumed',
    'value.energy.total',
]);

/** The unit a kind is sent in, the second tie-break step (a state in that unit beats one in another). */
const PREFERRED_UNIT: Partial<Record<SlotKind, string>> = {
    [SlotKind.SLOT_KIND_BRIGHTNESS]: '%',
    [SlotKind.SLOT_KIND_POSITION]: '%',
    [SlotKind.SLOT_KIND_TEMPERATURE]: 'c',
    [SlotKind.SLOT_KIND_TARGET_TEMPERATURE]: 'c',
    [SlotKind.SLOT_KIND_POWER]: 'w',
    [SlotKind.SLOT_KIND_ENERGY]: 'kwh',
    [SlotKind.SLOT_KIND_COLOR_TEMPERATURE]: 'k',
};

/** Units a kind can't be measured in: power in mA is the current, not the power. */
const FOREIGN_UNITS: Partial<Record<SlotKind, Set<string>>> = {
    [SlotKind.SLOT_KIND_POWER]: new Set(['a', 'ma', 'v', 'mv', 'wh', 'kwh', 'mwh']),
    [SlotKind.SLOT_KIND_ENERGY]: new Set(['a', 'ma', 'v', 'mv', 'w', 'kw', 'mw']),
};

/** State names that mean the same as a key but are spelled differently. */
const KEY_BY_SUFFIX: Record<string, string> = {
    colortemp: 'colorTemp',
    color_temp: 'colorTemp',
};

const CLIMATE_HINT = 'climate';
const DOOR_HINTS = ['door', 'tuer', 'tür'];
const WINDOW_HINTS = ['window', 'fenster'];
const SETPOINT_EXCLUDE = new Set([
    'comfort',
    'komfort',
    'eco',
    'offset',
    'startup',
    'night',
    'nacht',
    'frost',
    'boost',
    'vacation',
    'urlaub',
    'absenk',
    'absenkung',
    'min',
    'max',
    'default',
    'away',
    'raw',
]);
const TOKEN = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g;

function tokens(name: string): Set<string> {
    return new Set((name.match(TOKEN) ?? []).map(t => t.toLowerCase()));
}

/**
 * The semantic key of a state: an explicit `canonicalKey` override first, then the key the
 * device detector found, then the colour role (a colour temperature is not a colour), then the
 * key the adapter resolved, then the state name.
 *
 * @param s - What is known about the state
 * @param s.canonicalKeyOverride - `canonicalKey` from common.custom, empty = none
 * @param s.detectedKey - Key the device detector found for the state, empty or missing = none
 * @param s.role - common.role of the state
 * @param s.canonicalKey - Key the role table resolved, empty = none
 * @param s.suffix - Last segment of the state ID
 */
export function slotKey(s: {
    canonicalKeyOverride: string;
    detectedKey?: string;
    role: string;
    canonicalKey: string;
    suffix: string;
}): string {
    if (s.canonicalKeyOverride) {
        return s.canonicalKeyOverride;
    }
    if (s.detectedKey) {
        return s.detectedKey;
    }
    if (s.role.startsWith('level.color')) {
        const sub = s.role.slice('level.color'.length).replace(/^\./, '');
        if (sub === 'temperature') {
            return 'colorTemp';
        }
        if (sub === '' || sub === 'rgb' || sub === 'hex') {
            return 'color';
        }
        // hue, saturation, white, ...: no slot of their own (yet)
        return s.suffix;
    }
    if (ENERGY_ROLES.has(s.role)) {
        return 'energy';
    }
    return s.canonicalKey || KEY_BY_SUFFIX[s.suffix] || s.suffix;
}

/**
 * Recommended slot ID of a standard kind: the lowercase kind name without prefix.
 *
 * @param kind - Slot kind
 */
export function slotIdForKind(kind: SlotKind): string {
    return SlotKind[kind].slice('SLOT_KIND_'.length).toLowerCase();
}

/** Slot ID → slot kind for the standard kinds, the IDs the `slot` override accepts (the generic kinds have none). */
const STANDARD_KIND_BY_SLOT_ID = new Map<string, SlotKind>(
    Object.values(SlotKind)
        .filter(
            (kind): kind is SlotKind =>
                typeof kind === 'number' && kind > 0 && !GENERIC_KINDS.has(kind) && SlotKind[kind] !== undefined,
        )
        .map(kind => [slotIdForKind(kind), kind]),
);

/** The slot IDs the `slot` override accepts, sorted, for the settings dialog and the docs. */
export const STANDARD_SLOT_IDS: string[] = [...STANDARD_KIND_BY_SLOT_ID.keys()].sort();

// ------------------------------------------------------------------ values

/**
 * A unit without case, spaces and degree sign: "°C" → "c", " kWh" → "kwh".
 *
 * @param unit - common.unit of a state
 */
export function normalizeUnit(unit: string): string {
    return unit.replace(/[°\s]/g, '').toLowerCase();
}

const MIRED_UNITS = new Set(['mired', 'mireds', 'mirek']);

/** The highest colour temperature in mired anyone sells (Kelvin ranges start well above it). */
const MIRED_MAX = 1000;

function linear(mul: number, add = 0): Transform {
    return { kind: 'linear', mul, add };
}

/**
 * How the raw value of a state turns into the scale of its slot kind, from the unit and the
 * range of the state. undefined = it already is on that scale (or nothing is known that says
 * otherwise): without a unit or a range the value is taken as it is.
 *
 * @param kind - Slot kind
 * @param unit - common.unit of the state
 * @param min - common.min of the state
 * @param max - common.max of the state
 */
export function transformFor(
    kind: SlotKind,
    unit: string,
    min: number | undefined,
    max: number | undefined,
): Transform | undefined {
    const u = normalizeUnit(unit);
    switch (kind) {
        case SlotKind.SLOT_KIND_BRIGHTNESS:
        case SlotKind.SLOT_KIND_POSITION: {
            // 0-255, 0-254 or 0-1 instead of 0-100 %
            const lo = min ?? 0;
            if (u === '%' || max === undefined || !(max > lo) || (lo === 0 && max === 100)) {
                return undefined;
            }
            const mul = 100 / (max - lo);
            return linear(mul, -lo * mul);
        }
        case SlotKind.SLOT_KIND_COLOR_TEMPERATURE:
            if (MIRED_UNITS.has(u) || (u === '' && max !== undefined && max <= MIRED_MAX)) {
                return { kind: 'mired' };
            }
            return undefined;
        case SlotKind.SLOT_KIND_TEMPERATURE:
        case SlotKind.SLOT_KIND_TARGET_TEMPERATURE:
            if (u === 'f') {
                return linear(5 / 9, -160 / 9);
            }
            return u === 'k' ? linear(1, -273.15) : undefined;
        case SlotKind.SLOT_KIND_POWER:
            if (u === 'kw') {
                return linear(1000);
            }
            return u === 'mw' ? linear(0.001) : undefined;
        case SlotKind.SLOT_KIND_ENERGY:
            if (u === 'wh') {
                return linear(0.001);
            }
            return u === 'mwh' ? linear(1000) : undefined;
        case SlotKind.SLOT_KIND_VOLTAGE:
            return u === 'mv' ? linear(0.001) : undefined;
        case SlotKind.SLOT_KIND_CURRENT:
            return u === 'ma' ? linear(0.001) : undefined;
        default:
            return undefined;
    }
}

/**
 * Rounded so a scale like 100 / 255 does not leave 40.00000000000001 behind.
 *
 * @param n - The number to round to two decimals
 */
function round(n: number): number {
    return Math.round(n * 100) / 100;
}

function applyTransform(transform: Transform | undefined, raw: number): number | undefined {
    if (!transform) {
        return raw;
    }
    if (transform.kind === 'mired') {
        return raw > 0 ? Math.round(1e6 / raw) : undefined;
    }
    return round(raw * transform.mul + transform.add);
}

function revertTransform(transform: Transform | undefined, value: number): number | undefined {
    if (!transform) {
        return value;
    }
    if (transform.kind === 'mired') {
        return value > 0 ? Math.round(1e6 / value) : undefined;
    }
    return round((value - transform.add) / transform.mul);
}

/**
 * The colour of a state as RGB. The notations in use: `#rrggbb`, `rrggbb`, `0xrrggbb`, `#rgb`,
 * `rgb(r, g, b)` and a number. undefined = not a colour.
 *
 * @param raw - Value of the ioBroker state
 */
function parseColor(raw: unknown): number | undefined {
    if (typeof raw === 'number') {
        return Number.isFinite(raw) ? Math.trunc(raw) & 0xffffff : undefined;
    }
    if (typeof raw !== 'string') {
        return undefined;
    }
    const text = raw.trim();
    const channels = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,[^)]*)?\)$/i.exec(text);
    if (channels) {
        const [r, g, b] = channels.slice(1, 4).map(Number);
        return r > 255 || g > 255 || b > 255 ? undefined : (r << 16) | (g << 8) | b;
    }
    const hex = /^(?:#|0x)?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(text)?.[1];
    if (!hex) {
        return undefined;
    }
    const full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex;
    return parseInt(full, 16);
}

/**
 * ioBroker value → value of a slot kind, on the scale of that kind. undefined = unknown.
 *
 * @param kind - Slot kind
 * @param raw - Value of the ioBroker state
 * @param inverted - The actuator is inverted (only matters for cover positions)
 * @param transform - How the raw value turns into the scale of the kind, undefined = it already is
 */
export function toSlotValue(
    kind: SlotKind,
    raw: unknown,
    inverted = false,
    transform?: Transform,
): v2.device_model.SlotValue | undefined {
    if (raw === null || raw === undefined || raw === '') {
        return undefined;
    }
    if (BOOL_KINDS.has(kind)) {
        if (typeof raw === 'string') {
            return { boolean: ['true', '1', 'on'].includes(raw.toLowerCase()) };
        }
        return { boolean: Boolean(raw) };
    }
    if (TEXT_KINDS.has(kind)) {
        // an object has no text form worth sending
        return typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean'
            ? { text: String(raw) }
            : undefined;
    }
    if (kind === SlotKind.SLOT_KIND_COLOR) {
        const rgb = parseColor(raw);
        return rgb === undefined ? undefined : { rgb };
    }
    const number = typeof raw === 'number' ? raw : Number(raw);
    if (typeof raw === 'boolean' || !Number.isFinite(number)) {
        return undefined;
    }
    const value = applyTransform(transform, number);
    if (value === undefined) {
        return undefined;
    }
    return { number: inverted && kind === SlotKind.SLOT_KIND_POSITION ? 100 - value : value };
}

/**
 * Value of a SetSlot → what is written to the ioBroker state. undefined = the value doesn't
 * fit the slot kind (a bool is no brightness), nothing is written.
 *
 * @param target - The slot's state
 * @param value - Value Hannah sent
 * @param current - Current value of the state, tells the notation of a colour (hex text or number)
 */
export function fromSlotValue(
    target: SlotTarget,
    value: v2.device_model.SlotValue | undefined,
    current: unknown,
): string | number | boolean | undefined {
    if (!value) {
        return undefined;
    }
    const kind = target.kind;
    if (BOOL_KINDS.has(kind)) {
        return typeof value.boolean === 'boolean' ? value.boolean : undefined;
    }
    if (TEXT_KINDS.has(kind)) {
        return typeof value.text === 'string' ? value.text : undefined;
    }
    if (kind === SlotKind.SLOT_KIND_COLOR) {
        if (typeof value.rgb !== 'number') {
            return undefined;
        }
        const rgb = value.rgb & 0xffffff;
        if (typeof current === 'number') {
            return rgb;
        }
        const hex = rgb.toString(16).padStart(6, '0');
        // the notation the state already has: with or without the hash
        return typeof current === 'string' && /^[0-9a-f]{6}$/i.test(current.trim()) ? hex : `#${hex}`;
    }
    if (typeof value.number !== 'number' || !Number.isFinite(value.number)) {
        return undefined;
    }
    const slotValue = target.inverted && kind === SlotKind.SLOT_KIND_POSITION ? 100 - value.number : value.number;
    return revertTransform(target.transform, slotValue);
}

// ------------------------------------------------------------------ composed colour

/** The scale of a hue or saturation state without a range: degrees, percent. */
const DEFAULT_HUE_MAX = 360;
const DEFAULT_SATURATION_MAX = 100;

const HUE_ROLE = 'level.color.hue';
const SATURATION_ROLE = 'level.color.saturation';

/**
 * Where a raw value lies on the range of its state, 0 to 1. undefined = no number yet.
 *
 * @param part - The state
 * @param defaultMax - Upper end of the range if the state names none
 */
function fractionOf(part: ColorPart, defaultMax: number): number | undefined {
    const raw = part.value;
    if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') {
        return undefined;
    }
    const n = typeof raw === 'number' ? raw : Number(raw);
    const lo = part.min ?? 0;
    const hi = part.max ?? defaultMax;
    if (!Number.isFinite(n) || !(hi > lo)) {
        return undefined;
    }
    return Math.min(1, Math.max(0, (n - lo) / (hi - lo)));
}

/**
 * The raw value of a state for a position on its range. Whole numbers where the range is wide
 * (0-360, 0-65535), two decimals where it is not (0-1).
 *
 * @param part - The state
 * @param defaultMax - Upper end of the range if the state names none
 * @param fraction - Position on the range, 0 to 1
 */
function rawOf(part: ColorPart, defaultMax: number, fraction: number): number {
    const lo = part.min ?? 0;
    const hi = part.max ?? defaultMax;
    const raw = lo + fraction * (hi - lo);
    return hi - lo >= 10 ? Math.round(raw) : round(raw);
}

/**
 * Hue and saturation of a lamp that has no RGB state: the two states, if the device has exactly
 * one of each and nothing that already is its colour.
 *
 * @param states - The states of one device
 * @param taken - The states that already fill a standard slot
 */
function composableColor(states: DeviceState[], taken: Map<string, SlotKind>): ColorCompose | undefined {
    const isNumber = (s: DeviceState): boolean => s.valueType === 'number' && !s.slotOverride;
    const hues = states.filter(s => s.role === HUE_ROLE && isNumber(s));
    const saturations = states.filter(s => s.role === SATURATION_ROLE && isNumber(s));
    if (hues.length !== 1 || saturations.length !== 1) {
        return undefined;
    }
    // a state that is the colour, even an ambiguous one or one the admin named, wins over the composition
    const hasColor =
        [...taken.values()].includes(SlotKind.SLOT_KIND_COLOR) ||
        states.some(s => s.slotOverride === 'color' || preliminaryKind(s, false, false) === SlotKind.SLOT_KIND_COLOR);
    if (hasColor) {
        return undefined;
    }
    const part = (s: DeviceState): ColorPart => ({ stateId: s.stateId, min: s.min, max: s.max, value: s.value });
    return { hue: part(hues[0]), saturation: part(saturations[0]) };
}

/**
 * Takes a new raw value of the hue or saturation state into account.
 *
 * @param compose - The composed colour of a slot, updated in place
 * @param stateId - The state that changed
 * @param raw - Its new raw value
 */
export function updateColorPart(compose: ColorCompose, stateId: string, raw: unknown): void {
    for (const part of [compose.hue, compose.saturation]) {
        if (part.stateId === stateId) {
            part.value = raw;
        }
    }
}

/**
 * The colour of a lamp from its hue and saturation, as RGB at full brightness (the brightness is
 * the lamp's own slot). undefined = one of the two has no value yet.
 *
 * @param compose - The two states with their last values
 */
export function composedColor(compose: ColorCompose): v2.device_model.SlotValue | undefined {
    const hue = fractionOf(compose.hue, DEFAULT_HUE_MAX);
    const saturation = fractionOf(compose.saturation, DEFAULT_SATURATION_MAX);
    if (hue === undefined || saturation === undefined) {
        return undefined;
    }
    // HSV with the value at 1
    const h = (hue * 6) % 6;
    const c = saturation;
    const x = c * (1 - Math.abs((h % 2) - 1));
    const m = 1 - c;
    const [r, g, b] = [
        [c, x, 0],
        [x, c, 0],
        [0, c, x],
        [0, x, c],
        [x, 0, c],
        [c, 0, x],
    ][Math.floor(h)];
    const channel = (v: number): number => Math.round((v + m) * 255);
    return { rgb: (channel(r) << 16) | (channel(g) << 8) | channel(b) };
}

/**
 * What a SetSlot of a composed colour writes: the hue and the saturation of the requested RGB
 * (its brightness is left to the lamp's brightness slot). undefined = the value is no colour.
 *
 * @param compose - The two states
 * @param value - Value Hannah sent
 */
export function colorWrites(
    compose: ColorCompose,
    value: v2.device_model.SlotValue | undefined,
): Array<{ stateId: string; value: number }> | undefined {
    if (typeof value?.rgb !== 'number') {
        return undefined;
    }
    const rgb = value.rgb & 0xffffff;
    const r = ((rgb >> 16) & 0xff) / 255;
    const g = ((rgb >> 8) & 0xff) / 255;
    const b = (rgb & 0xff) / 255;
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    let degrees = 0;
    if (delta > 0) {
        if (max === r) {
            degrees = 60 * (((g - b) / delta + 6) % 6);
        } else if (max === g) {
            degrees = 60 * ((b - r) / delta + 2);
        } else {
            degrees = 60 * ((r - g) / delta + 4);
        }
    }
    const saturation = max === 0 ? 0 : delta / max;
    return [
        { stateId: compose.hue.stateId, value: rawOf(compose.hue, DEFAULT_HUE_MAX, degrees / 360) },
        { stateId: compose.saturation.stateId, value: rawOf(compose.saturation, DEFAULT_SATURATION_MAX, saturation) },
    ];
}

// ------------------------------------------------------------------ classification

function preliminaryKind(state: DeviceState, blind: boolean, climate: boolean): SlotKind | undefined {
    const key = state.key;
    if (climate && key === 'mode') {
        return SlotKind.SLOT_KIND_MODE;
    }
    if (climate && key === 'fanSpeed') {
        return SlotKind.SLOT_KIND_FAN_SPEED;
    }
    if (key === 'level') {
        return blind ? SlotKind.SLOT_KIND_POSITION : SlotKind.SLOT_KIND_BRIGHTNESS;
    }
    if (key === 'current') {
        if (state.typeHint === 'humidity_sensor') {
            return SlotKind.SLOT_KIND_HUMIDITY;
        }
        if (state.typeHint === 'illuminance_sensor') {
            return SlotKind.SLOT_KIND_ILLUMINANCE;
        }
        return SlotKind.SLOT_KIND_TEMPERATURE;
    }
    return KIND_BY_KEY[key];
}

/**
 * state ID → slot kind for the states that unambiguously carry a standard kind.
 *
 * @param states - The states of one device
 * @param blind - The device is a blind (a level is a position)
 * @param climate - The device is an air conditioner (mode and fan speed are slots)
 * @param report - Where to report what is not used the way it could have been, and for which device
 * @param report.deviceId - ID of the device the states belong to
 * @param report.explain - Receives the findings
 */
function resolveKinds(
    states: DeviceState[],
    blind: boolean,
    climate: boolean,
    report?: { deviceId: string; explain: Explain },
): Map<string, SlotKind> {
    const groups = new Map<SlotKind, DeviceState[]>();
    // States the admin assigned to a slot (`slot` in common.custom): they beat the tie-breaking and the unit check
    const explicit = new Map<SlotKind, DeviceState[]>();
    for (const state of states) {
        if (state.slotOverride) {
            const named = STANDARD_KIND_BY_SLOT_ID.get(state.slotOverride);
            if (named !== undefined) {
                explicit.set(named, [...(explicit.get(named) ?? []), state]);
                continue;
            }
            report?.explain({
                code: 'slot-unknown',
                deviceId: report.deviceId,
                stateId: state.stateId,
                slot: state.slotOverride,
            });
        }
        const kind = preliminaryKind(state, blind, climate);
        if (kind === undefined) {
            continue;
        }
        if (unitFits(kind, state.unit)) {
            groups.set(kind, [...(groups.get(kind) ?? []), state]);
        } else {
            report?.explain({
                code: 'unit-mismatch',
                deviceId: report.deviceId,
                stateId: state.stateId,
                slot: slotIdForKind(kind),
                unit: state.unit,
            });
        }
    }
    const chosen = new Map<string, SlotKind>();
    for (const [kind, members] of explicit) {
        // the others that fit the kind lose either way: with one explicit state it wins, with several none is used
        groups.delete(kind);
        if (members.length === 1) {
            chosen.set(members[0].stateId, kind);
        } else {
            report?.explain({
                code: 'slot-ambiguous',
                deviceId: report.deviceId,
                slot: slotIdForKind(kind),
                candidates: members.map(m => m.stateId),
                remaining: members.map(m => m.stateId),
            });
        }
    }
    for (const [kind, members] of groups) {
        const left = narrowCandidates(kind, members);
        if (left.length === 1) {
            chosen.set(left[0].stateId, kind);
        } else {
            // no clear winner: nothing is chosen
            report?.explain({
                code: 'slot-ambiguous',
                deviceId: report.deviceId,
                slot: slotIdForKind(kind),
                candidates: members.map(m => m.stateId),
                remaining: left.map(m => m.stateId),
            });
        }
    }
    return chosen;
}

/**
 * The standard slot kinds the states of a group would carry, what the grouping looks at to
 * tell whether two channels would use the same slot.
 *
 * @param states - The states of one group
 */
export function standardKindsOf(states: DeviceState[]): Set<SlotKind> {
    const blind = states.some(s => s.typeHint === 'blind');
    const climate = states.some(s => s.typeHint === CLIMATE_HINT);
    return new Set(resolveKinds(states, blind, climate).values());
}

/**
 * A state in a unit that belongs to another quantity (power in mA) can't carry the kind.
 *
 * @param kind - Slot kind a state competes for
 * @param unit - common.unit of the state
 */
function unitFits(kind: SlotKind, unit: string): boolean {
    return !FOREIGN_UNITS[kind]?.has(normalizeUnit(unit));
}

/** Slot kinds a user sets (a writable state is the control, a read-only one a reading of it). */
const CONTROL_KINDS = new Set<SlotKind>([
    SlotKind.SLOT_KIND_ON,
    SlotKind.SLOT_KIND_BRIGHTNESS,
    SlotKind.SLOT_KIND_COLOR,
    SlotKind.SLOT_KIND_COLOR_TEMPERATURE,
    SlotKind.SLOT_KIND_POSITION,
    SlotKind.SLOT_KIND_TARGET_TEMPERATURE,
]);

/**
 * The state that carries a kind if several states fit it. The candidates are narrowed step by
 * step (a step that would leave none is skipped): exact role, then unit, then writability (a
 * setpoint is writable, a measurement is not), then the name as the last resort (comfort, eco
 * and the like are no setpoints). Not exactly one left = nobody wins.
 *
 * @param kind - The slot kind the candidates compete for
 * @param candidates - The states that fit the kind
 * @returns The states that are left, exactly one if there is a winner
 */
function narrowCandidates(kind: SlotKind, candidates: DeviceState[]): DeviceState[] {
    const preferredUnit = PREFERRED_UNIT[kind];
    const roles = ROLES_BY_KIND[kind];
    const steps: Array<(s: DeviceState) => boolean> = [
        s => roles?.includes(s.role) === true,
        s => preferredUnit !== undefined && normalizeUnit(s.unit) === preferredUnit,
        s => (CONTROL_KINDS.has(kind) ? s.writable : !s.writable),
        s => ![...tokens(s.suffix)].some(t => SETPOINT_EXCLUDE.has(t)),
    ];
    let left = candidates;
    for (const step of steps) {
        if (left.length === 1) {
            break;
        }
        const narrowed = left.filter(step);
        if (narrowed.length > 0) {
            left = narrowed;
        }
    }
    return left;
}

function decideClass(slots: v2.device_model.Slot[], typeHints: Set<string>): DeviceClass {
    const byKind = new Map(slots.filter(s => !GENERIC_KINDS.has(s.kind)).map(s => [s.kind, s]));
    const has = (kind: SlotKind): boolean => byKind.has(kind);
    const writable = (kind: SlotKind): boolean => byKind.get(kind)?.writable === true;
    const anyKind = (kinds: Set<SlotKind>): boolean => [...byKind.keys()].some(k => kinds.has(k));

    if (writable(SlotKind.SLOT_KIND_ON) && (typeHints.has(CLIMATE_HINT) || anyKind(ENUM_KINDS))) {
        return DeviceClass.DEVICE_CLASS_CLIMATE;
    }
    if (has(SlotKind.SLOT_KIND_TARGET_TEMPERATURE)) {
        return DeviceClass.DEVICE_CLASS_THERMOSTAT;
    }
    if (writable(SlotKind.SLOT_KIND_POSITION)) {
        return DeviceClass.DEVICE_CLASS_COVER;
    }
    if (writable(SlotKind.SLOT_KIND_ON)) {
        if (
            typeHints.has('light') ||
            writable(SlotKind.SLOT_KIND_BRIGHTNESS) ||
            writable(SlotKind.SLOT_KIND_COLOR) ||
            writable(SlotKind.SLOT_KIND_COLOR_TEMPERATURE)
        ) {
            return DeviceClass.DEVICE_CLASS_LIGHT;
        }
        if (typeHints.has('socket') || has(SlotKind.SLOT_KIND_POWER)) {
            return DeviceClass.DEVICE_CLASS_SOCKET;
        }
        return DeviceClass.DEVICE_CLASS_GENERIC_BINARY_SWITCH;
    }
    if (has(SlotKind.SLOT_KIND_OPEN) && !writable(SlotKind.SLOT_KIND_OPEN)) {
        return DeviceClass.DEVICE_CLASS_CONTACT;
    }
    if (anyKind(MEASUREMENT_KINDS) && ![...byKind.values()].some(s => s.writable)) {
        return DeviceClass.DEVICE_CLASS_SENSOR;
    }
    return DeviceClass.DEVICE_CLASS_GENERIC;
}

function subtypeFor(deviceClass: DeviceClass, typeHints: Set<string>): DeviceSubtype {
    if (deviceClass === DeviceClass.DEVICE_CLASS_CONTACT) {
        const lowered = [...typeHints].map(h => h.toLowerCase());
        if (lowered.some(h => DOOR_HINTS.some(d => h.includes(d)))) {
            return DeviceSubtype.DEVICE_SUBTYPE_DOOR;
        }
        if (lowered.some(h => WINDOW_HINTS.some(w => h.includes(w)))) {
            return DeviceSubtype.DEVICE_SUBTYPE_WINDOW;
        }
    }
    return DeviceSubtype.DEVICE_SUBTYPE_UNSPECIFIED;
}

function genericKind(state: DeviceState): SlotKind {
    if (state.valueType === 'boolean') {
        return SlotKind.SLOT_KIND_GENERIC_BOOL;
    }
    if (state.valueType === 'number') {
        return SlotKind.SLOT_KIND_GENERIC_NUMBER;
    }
    return SlotKind.SLOT_KIND_GENERIC_TEXT;
}

/**
 * The COLOR slot of a lamp whose colour is a hue and a saturation state.
 *
 * @param deviceId - ID of the device
 * @param states - The states of the device
 * @param compose - The hue and the saturation state
 * @param slots - The slots of the device, the colour is added
 * @param targets - The targets of the device, the colour is added
 * @param model - The model, the two states are registered for live updates
 */
function addComposedColor(
    deviceId: string,
    states: DeviceState[],
    compose: ColorCompose,
    slots: Map<string, v2.device_model.Slot>,
    targets: Map<string, SlotTarget>,
    model: DeviceModel,
): void {
    const slotId = slotIdForKind(SlotKind.SLOT_KIND_COLOR);
    const parts = states.filter(s => s.stateId === compose.hue.stateId || s.stateId === compose.saturation.stateId);
    const trust = parts.map(s => s.requiredTrustLevel).filter((t): t is number => t !== undefined);
    const requiredTrustLevel = trust.length > 0 ? Math.max(...trust) : undefined;
    const writable = parts.every(s => s.writable);
    const target: SlotTarget = {
        stateId: compose.hue.stateId,
        kind: SlotKind.SLOT_KIND_COLOR,
        inverted: false,
        writable,
        valueType: 'color',
        requiredTrustLevel,
        compose,
    };
    slots.set(slotId, {
        slotId,
        kind: SlotKind.SLOT_KIND_COLOR,
        value: composedColor(compose),
        writable,
        unit: '',
        label: '',
        requiredTrustLevel,
        options: [],
        identifier: compose.hue.stateId,
    });
    targets.set(slotId, target);
    model.bySlotState.set(compose.hue.stateId, { deviceId, slotId, target });
    model.bySlotState.set(compose.saturation.stateId, { deviceId, slotId, target });
}

function classifyDevice(input: DeviceInput, model: DeviceModel, explain?: Explain): v2.device_model.TypedDevice {
    const reachableStates = input.states.filter(isReachableState);
    const states = input.states.filter(s => !isReachableState(s));
    if (reachableStates.length > 0) {
        const byState = new Map(reachableStates.map(s => [s.stateId, s.value !== false]));
        model.reachability.states.set(input.deviceId, byState);
        reachableStates.forEach(s => model.reachability.deviceOf.set(s.stateId, input.deviceId));
    }
    const blind = states.some(s => s.typeHint === 'blind');
    const climate = states.some(s => s.typeHint === CLIMATE_HINT);
    const kinds = resolveKinds(states, blind, climate, explain && { deviceId: input.deviceId, explain });
    const standardIds = new Set([...kinds.values()].map(slotIdForKind));
    const compose = composableColor(states, kinds);
    if (compose) {
        standardIds.add(slotIdForKind(SlotKind.SLOT_KIND_COLOR));
    }

    const slots = new Map<string, v2.device_model.Slot>();
    const targets = new Map<string, SlotTarget>();
    for (const state of states) {
        if (compose && (state.stateId === compose.hue.stateId || state.stateId === compose.saturation.stateId)) {
            continue;
        }
        let kind = kinds.get(state.stateId);
        let slotId: string;
        let label = '';
        if (kind !== undefined) {
            slotId = slotIdForKind(kind);
        } else {
            kind = genericKind(state);
            slotId = state.suffix;
            label = state.key;
            let n = 2;
            while (slots.has(slotId) || standardIds.has(slotId)) {
                slotId = `${state.suffix}_${n++}`;
            }
        }
        const inverted = state.inverted && kind === SlotKind.SLOT_KIND_POSITION;
        const transform = transformFor(kind, state.unit, state.min, state.max);
        const target: SlotTarget = {
            stateId: state.stateId,
            kind,
            inverted,
            writable: state.writable,
            valueType: state.valueType,
            requiredTrustLevel: state.requiredTrustLevel,
            transform,
        };
        slots.set(slotId, {
            slotId,
            kind,
            value: toSlotValue(kind, state.value, inverted, transform),
            writable: state.writable,
            unit: '',
            label,
            requiredTrustLevel: state.requiredTrustLevel,
            options: ENUM_KINDS.has(kind) ? [...state.options].sort() : [],
            identifier: state.stateId,
        });
        targets.set(slotId, target);
        model.bySlotState.set(state.stateId, { deviceId: input.deviceId, slotId, target });
    }
    if (compose) {
        addComposedColor(input.deviceId, states, compose, slots, targets, model);
    }
    model.targets.set(input.deviceId, targets);

    const typeHints = new Set(states.map(s => s.typeHint).filter(Boolean));
    const deviceClass = decideClass([...slots.values()], typeHints);
    return {
        deviceId: input.deviceId,
        name: input.name,
        room: input.room,
        floor: input.floor,
        deviceClass,
        slots: [...slots.values()],
        available: isReachable(model.reachability.states.get(input.deviceId)),
        subtype: subtypeFor(deviceClass, typeHints),
    };
}

/**
 * The typed devices for the states of an ioBroker setup. States without a room or a device
 * are raw states (weather, car, ...) and belong to no device. A device none of whose states
 * is recognized (a config channel, a status block) is not reported either: there is nothing
 * Hannah could do with it. The generic slots of a recognized device stay.
 *
 * @param inputs - One entry per device, in the order the devices are reported
 * @param explain - Receives the reasons why a device or a state was not used the way it could have been
 */
export function buildDeviceModel(inputs: DeviceInput[], explain?: Explain): DeviceModel {
    const model = emptyDeviceModel();
    for (const input of inputs) {
        if (!input.deviceId || input.states.length === 0) {
            continue;
        }
        if (!input.room) {
            explain?.({ code: 'no-room', deviceId: input.deviceId, stateIds: input.states.map(s => s.stateId) });
            continue;
        }
        // states that were already explained as ambiguous or in a foreign unit are not "unknown" as well
        const explained = new Set<string>();
        const own = emptyDeviceModel();
        const device = classifyDevice(
            input,
            own,
            explain &&
                (d => {
                    if (d.code === 'slot-ambiguous') {
                        d.candidates.forEach(id => explained.add(id));
                    } else if (d.code === 'unit-mismatch') {
                        explained.add(d.stateId);
                    }
                    explain(d);
                }),
        );
        if (device.slots.every(slot => GENERIC_KINDS.has(slot.kind))) {
            // states that fit a slot but were ambiguous or in a foreign unit are explained already
            if (explained.size === 0) {
                explain?.({
                    code: 'no-recognized-slot',
                    deviceId: input.deviceId,
                    stateIds: input.states.map(s => s.stateId),
                });
            }
            continue;
        }
        if (explain) {
            for (const state of input.states) {
                const slot = device.slots.find(s => s.identifier === state.stateId);
                if (slot && GENERIC_KINDS.has(slot.kind) && !explained.has(state.stateId)) {
                    explain({
                        code: 'state-generic',
                        deviceId: input.deviceId,
                        stateId: state.stateId,
                        key: state.key,
                        role: state.role,
                    });
                }
            }
        }
        model.devices.push(device);
        own.bySlotState.forEach((value, key) => model.bySlotState.set(key, value));
        own.targets.forEach((value, key) => model.targets.set(key, value));
        own.reachability.deviceOf.forEach((value, key) => model.reachability.deviceOf.set(key, value));
        own.reachability.states.forEach((value, key) => model.reachability.states.set(key, value));
    }
    return model;
}
