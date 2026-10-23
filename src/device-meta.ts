/**
 * What the adapter makes of one ioBroker state: its device, room, floor, functions, type hint,
 * value shape and slot data. A pure function of the objects (state, parent, alias target) and
 * the room and function enums, so it runs on a live ioBroker as well as on an object dump, and
 * every rule is testable without an adapter.
 */
import { v1 } from '@m1kad0/hannah-proto';
import shared = v1.shared;
import { parentId } from './device-grouping';

/** ioBroker objects by ID, the ones a state needs: itself, its parent and its alias target. */
export type ObjectMap = Record<string, ioBroker.Object | null | undefined>;

/** Label to abbreviation pair for floor detection. */
export interface FloorMapping {
    /** the floor as an admin writes it, e.g. "Erdgeschoss" */
    label: string;
    /** the short form Hannah uses, e.g. "EG" */
    abbreviation: string;
}

/** The settings of the adapter instance that the resolution depends on. */
export interface DeviceMetaOptions {
    /** adapter namespace, e.g. "hannah.0": the key of the `common.custom` overrides */
    namespace: string;
    /** label to abbreviation pairs for floor detection (empty = hardcoded defaults) */
    floorMappings: FloorMapping[];
}

/** What is resolved about one ioBroker state: its device, room, type hint and shape. */
export interface DeviceMeta {
    /** ID of the room (last part of the `enum.rooms.*` ID), empty = none */
    room: string;
    /** display names of the room by language */
    roomNames: { [key: string]: string };
    /** name of the device the state belongs to */
    device: string;
    /** the name of the state itself, for a state that is a device of its own */
    ownName: string;
    /**
     * IDs of the function enums the state, its device or its channel's device is a member of,
     * for the typed device model. `functions` only has the exact matches (hannah.v1 snapshot).
     */
    functionIds: string[];
    /** device category (hannah.v1), empty = none */
    type: string;
    /** floor abbreviation, empty = none */
    floor: string;
    /** names of the functions the state itself is a member of (hannah.v1 snapshot) */
    functions: string[];
    /** value shape of the state */
    stateType: shared.StateType;
    /** the values and labels of a state with `common.states` */
    enumValues: shared.EnumValues | undefined;
    /** whether the state can be written */
    writable: boolean;
    /** ID of the object the state sits in */
    deviceId: string;
    /** the semantic role of the state (hannah.v1 snapshot), empty = none */
    canonicalKey: string;
    /** common.role of the state, for the typed device model */
    role: string;
    /** common.unit of the state, empty = none */
    unit: string;
    /** common.min of the state, undefined = none */
    min: number | undefined;
    /** common.max of the state, undefined = none */
    max: number | undefined;
    /** `canonicalKey` from common.custom, empty = none */
    canonicalKeyOverride: string;
    /** the object of the state, for the device detector */
    stateObject: ioBroker.Object | null | undefined;
    /** the object of the state's parent (channel or device), for the device detector */
    deviceObject: ioBroker.Object | null | undefined;
    /** a blind that uses 0 % = open, undefined = not configured */
    inverted: boolean | undefined;
    /** neededTrust from common.custom (0–10), undefined = no restriction */
    requiredTrustLevel: number | undefined;
}

/** The meta data of a state, and what was off about its configuration on the way. */
export interface DeviceMetaResult {
    /** what was resolved */
    meta: DeviceMeta;
    /** things worth telling the admin, e.g. a neededTrust that is not a level */
    warnings: string[];
}

const KNOWN_FLOORS = new Set(['EG', 'OG', 'UG', 'DG', 'KG', 'ZG']);

// Rolle → {Kategorie, kanonischer State-Key}. Die Kategorie wird pro Gerät aggregiert
// (erster nicht-leerer Wert über alle Sibling-States gewinnt, siehe hannah#133 auf
// Core-Seite); der kanonische Key wird dagegen direkt pro State übernommen, ohne
// Aggregation — ein Thermostat trägt z.B. gleichzeitig "current" (value.temperature)
// und "expected" (level.temperature) auf zwei verschiedenen Sibling-States desselben
// Geräts (hannah#257). Roh-Suffixe ohne passende Rolle liefern hier canonicalKey='' —
// Core fällt dafür auf sein eigenes iobroker.state_names-Default zurück (hannah#256).
const ROLE_TABLE: Record<string, { type: string; canonicalKey: string }> = {
    'level.dimmer': { type: 'light', canonicalKey: 'level' },
    'switch.light': { type: 'light', canonicalKey: 'on' },
    'level.temperature': { type: 'thermostat', canonicalKey: 'expected' },
    'value.temperature': { type: 'temperature_sensor', canonicalKey: 'current' },
    'value.humidity': { type: 'humidity_sensor', canonicalKey: 'current' },
    'value.brightness': { type: 'illuminance_sensor', canonicalKey: 'illuminance' },
    'value.power': { type: '', canonicalKey: 'power' },
    'sensor.door': { type: 'door', canonicalKey: 'open' },
    'indicator.open': { type: 'door', canonicalKey: 'open' },
    'sensor.window': { type: 'window', canonicalKey: 'open' },
    'level.blind': { type: 'blind', canonicalKey: 'level' },
    'level.curtain': { type: 'blind', canonicalKey: 'level' },
    'value.blind': { type: 'blind', canonicalKey: 'level' },
    'value.curtain': { type: 'blind', canonicalKey: 'level' },
};

/**
 * The ID of the state an alias points to, so the caller can load it before resolving.
 *
 * @param obj - The state's own object
 */
export function aliasTargetId(obj: ioBroker.Object | null | undefined): string | undefined {
    const alias = (obj?.common as { alias?: any } | undefined)?.alias;
    if (!obj || !alias) {
        return undefined;
    }
    const targetId: unknown = typeof alias.id === 'string' ? alias.id : (alias.id?.read ?? alias.id?.write);
    return typeof targetId === 'string' && targetId ? targetId : undefined;
}

/**
 * An alias state often carries only a name, the room and the function, while role, type,
 * unit and range are those of the state it points to. What the alias lacks is taken from
 * that target, so it is recognized like the target would be. A value the alias converts
 * with a read or write function has its own scale: unit and range are then not inherited.
 *
 * @param obj - The state's own object
 * @param target - The object the alias points to, if it could be loaded
 */
export function inheritFromAliasTarget(
    obj: ioBroker.Object | null | undefined,
    target: ioBroker.Object | null | undefined,
): ioBroker.Object | null | undefined {
    const alias = (obj?.common as { alias?: any } | undefined)?.alias;
    if (!obj || !alias || !target?.common) {
        return obj;
    }
    const own = obj.common as Record<string, unknown>;
    const from = target.common as Record<string, unknown>;
    const converted = Boolean(alias.read || alias.write);
    const inherited: Record<string, unknown> = {};
    for (const field of converted ? ['role', 'type', 'states'] : ['role', 'type', 'unit', 'min', 'max', 'states']) {
        if (own[field] === undefined && from[field] !== undefined) {
            inherited[field] = from[field];
        }
    }
    return { ...obj, common: { ...own, ...inherited } } as ioBroker.Object;
}

/**
 * #203: common.custom["hannah.0"].neededTrust — minimum trust level (0–10) needed to set
 * this state. State-level only, like canonicalKey: a lock and its battery indicator sit
 * on the same device but need different protection. undefined (not 0) when unset or
 * invalid — the proto distinguishes "no restriction" from an explicit 0.
 *
 * @param stateCustom - The state's common.custom entry for this adapter instance
 */
export function resolveNeededTrust(stateCustom: any): { level: number | undefined; warning?: string } {
    if (!stateCustom?.enabled) {
        return { level: undefined };
    }
    const raw = stateCustom.neededTrust;
    if (raw === undefined || raw === null || raw === '') {
        return { level: undefined };
    }
    const level = Number(raw);
    if (!Number.isInteger(level) || level < 0 || level > 10) {
        return { level: undefined, warning: `Ignoring invalid neededTrust ${JSON.stringify(raw)} (expected 0–10)` };
    }
    return { level };
}

/**
 * Normalizes ioBroker's common.states (object map, string array, or the deprecated
 * "val1:text1;val2:text2" string format) into the value->label shape EnumValues needs.
 *
 * @param rawStates - The state object's common.states field, in any of its supported shapes
 */
export function statesToEnumValues(
    rawStates: Record<string, string> | string[] | string | undefined,
): shared.EnumValues | undefined {
    if (!rawStates) {
        return undefined;
    }
    if (Array.isArray(rawStates)) {
        if (rawStates.length === 0) {
            return undefined;
        }
        return { values: Object.fromEntries(rawStates.map(v => [v, v])) };
    }
    if (typeof rawStates === 'string') {
        const values = Object.fromEntries(
            rawStates
                .split(';')
                .map(pair => pair.split(':'))
                .filter((pair): pair is [string, string] => pair.length === 2),
        );
        return Object.keys(values).length > 0 ? { values } : undefined;
    }
    if (Object.keys(rawStates).length === 0) {
        return undefined;
    }
    return { values: Object.fromEntries(Object.entries(rawStates).map(([k, v]) => [k, String(v)])) };
}

/**
 * Classifies a state's value shape (#117) from ioBroker's own common.type/role/states —
 * no separate discovery step needed, this metadata is already loaded alongside stateObj.
 *
 * @param stateObj - The state's own ioBroker object
 */
export function resolveStateType(stateObj: ioBroker.Object | null | undefined): {
    stateType: shared.StateType;
    enumValues: shared.EnumValues | undefined;
} {
    const role = stateObj?.common?.role ?? '';
    const rawStates = (stateObj?.common as { states?: Record<string, string> | string[] | string } | undefined)?.states;
    const enumValues = statesToEnumValues(rawStates);

    if (role.startsWith('level.color')) {
        return { stateType: shared.StateType.COLOR, enumValues };
    }
    if (enumValues) {
        return { stateType: shared.StateType.ENUM, enumValues };
    }

    const type = stateObj?.common?.type;
    if (type === 'boolean') {
        return { stateType: shared.StateType.BOOLEAN, enumValues: undefined };
    }
    if (type === 'number') {
        return { stateType: shared.StateType.NUMERIC, enumValues: undefined };
    }
    return { stateType: shared.StateType.TEXT, enumValues: undefined };
}

/**
 * Resolves everything the adapter knows about one state.
 *
 * @param stateId - ioBroker state ID
 * @param objects - The objects of the state, its parent and its alias target (`aliasTargetId()`), by ID
 * @param rooms - The `enum.rooms.*` objects
 * @param functions - The `enum.functions.*` objects
 * @param options - Namespace of the adapter and floor mappings
 */
export function resolveDeviceMeta(
    stateId: string,
    objects: ObjectMap,
    rooms: Record<string, ioBroker.Object>,
    functions: Record<string, ioBroker.Object>,
    options: DeviceMetaOptions,
): DeviceMetaResult {
    const warnings: string[] = [];
    const deviceId = parentId(stateId);

    const ownStateObj = objects[stateId];
    const targetId = aliasTargetId(ownStateObj);
    const stateObj = inheritFromAliasTarget(ownStateObj, targetId ? objects[targetId] : undefined);
    const deviceObj = objects[deviceId];

    // hannah#164/#256/#257: common.custom["hannah.0"] overrides — shared here so both
    // the type/canonicalKey resolution below and the device-name fallback chain read
    // the same enabled lookup instead of duplicating it. State-level only: ioBroker offers
    // common.custom on states, not on channels or devices.
    const stateCustom = (stateObj?.common?.custom as any)?.[options.namespace];

    const trust = resolveNeededTrust(stateCustom);
    if (trust.warning) {
        warnings.push(trust.warning);
    }
    const requiredTrustLevel = trust.level;
    const rawFloorFromObj =
        typeof deviceObj?.common?.floor === 'string' && deviceObj.common.floor ? deviceObj.common.floor : null;

    const resolveFloor = (value: string): string | null => {
        const upper = value.toUpperCase();
        const match = options.floorMappings.find(
            m => m.label.toUpperCase() === upper || m.abbreviation.toUpperCase() === upper,
        );
        if (match) {
            return match.abbreviation;
        }
        if (KNOWN_FLOORS.has(upper)) {
            return upper;
        }
        return null;
    };

    const floorFromObj = rawFloorFromObj !== null ? (resolveFloor(rawFloorFromObj) ?? rawFloorFromObj) : null;

    let floorFromId = '';
    for (const part of deviceId.split('.')) {
        const resolved = resolveFloor(part);
        if (resolved !== null) {
            floorFromId = resolved;
            break;
        }
    }

    const floor = floorFromObj ?? floorFromId;

    // hannah-iobroker#187: a room can be assigned directly to the leaf state instead of
    // its parent channel/device (common for manually-built alias constructs with no real
    // device level) — check that before falling back to device/grandparent-device.
    let roomObj = Object.values(rooms).find(
        (obj: any) => obj?._id?.startsWith('enum.rooms.') && obj.common?.members?.includes(stateId),
    );

    if (roomObj == null) {
        roomObj = Object.values(rooms).find(
            (obj: any) => obj?._id?.startsWith('enum.rooms.') && obj.common?.members?.includes(deviceId),
        );
    }

    if (roomObj == null) {
        const grandparentId = parentId(deviceId);
        roomObj = Object.values(rooms).find(
            (obj: any) => obj?._id?.startsWith('enum.rooms.') && obj.common?.members?.includes(grandparentId),
        );
    }

    const roomId = roomObj ? (roomObj._id.split('.').pop() ?? '') : '';
    const roomNamesRaw = roomObj?.common?.name;
    const roomNames: { [key: string]: string } = {};
    if (roomNamesRaw) {
        if (typeof roomNamesRaw === 'string') {
            roomNames.de = roomNamesRaw;
        } else if (typeof roomNamesRaw === 'object') {
            for (const [lang, val] of Object.entries(roomNamesRaw)) {
                if (typeof val === 'string') {
                    roomNames[lang] = val;
                }
            }
        }
    }

    const matchingFunctionObjs = Object.values(functions).filter(
        (obj: any) => obj?._id?.startsWith('enum.functions.') && obj.common?.members?.includes(stateId),
    );

    const functionNames = matchingFunctionObjs.map((obj: any) =>
        String(obj.common?.name?.de ?? obj.common?.name ?? obj._id),
    );

    // like rooms, a function is often assigned to the device or channel, not to each state
    const functionHolders = [stateId, deviceId, parentId(deviceId)];
    const functionIds = Object.values(functions)
        .filter(
            (obj: any) =>
                obj?._id?.startsWith('enum.functions.') &&
                functionHolders.some(id => obj.common?.members?.includes(id)),
        )
        .map((obj: any) => String(obj._id));

    const role = stateObj?.common?.role ?? '';

    const resolveTypeAndCanonicalKey = (): { type: string; canonicalKey: string } => {
        const typeOverride = stateCustom?.enabled && stateCustom?.type;
        // Anders als die Kategorie ist der kanonische Key pro State unterschiedlich (s.o.),
        // ein Device-weiter Override ergäbe keinen Sinn.
        const canonicalKeyOverride = stateCustom?.enabled && stateCustom?.canonicalKey;

        const roleMatch = ROLE_TABLE[role];

        if (role.startsWith('level.color')) {
            return {
                type: String(typeOverride || 'light'),
                canonicalKey: String(canonicalKeyOverride || 'color'),
            };
        }
        if (roleMatch) {
            return {
                type: String(typeOverride || roleMatch.type),
                canonicalKey: String(canonicalKeyOverride || roleMatch.canonicalKey),
            };
        }

        if (typeOverride) {
            return { type: String(typeOverride), canonicalKey: String(canonicalKeyOverride || '') };
        }

        const funcIds = matchingFunctionObjs.map((obj: any) => (obj._id as string).toLowerCase());
        // Read-only Helligkeits-/Lux-Sensoren landen oft mit unter der "Licht"-Funktion einsortiert —
        // deshalb vor dem generischen light/licht-Fallback geprüft, und nur bei write===false gematcht,
        // damit ein tatsächlich steuerbares Licht (write möglich) nicht fälschlich als Sensor erkannt wird.
        if (stateObj?.common?.write === false && funcIds.some(id => id.includes('helligkeit') || id.includes('lux'))) {
            return { type: 'illuminance_sensor', canonicalKey: String(canonicalKeyOverride || '') };
        }
        if (funcIds.some(id => id.includes('light') || id.includes('licht'))) {
            return { type: 'light', canonicalKey: String(canonicalKeyOverride || '') };
        }
        if (funcIds.some(id => id.includes('scene') || id.includes('szene'))) {
            return { type: 'scene', canonicalKey: String(canonicalKeyOverride || '') };
        }
        if (funcIds.some(id => id.includes('socket') || id.includes('stecker') || id.includes('plug'))) {
            return { type: 'socket', canonicalKey: String(canonicalKeyOverride || '') };
        }
        if (funcIds.some(id => id.includes('heat') || id.includes('heiz') || id.includes('therm'))) {
            return { type: 'thermostat', canonicalKey: String(canonicalKeyOverride || '') };
        }
        if (funcIds.some(id => id.includes('window') || id.includes('fenster'))) {
            return { type: 'window', canonicalKey: String(canonicalKeyOverride || '') };
        }
        if (funcIds.some(id => id.includes('door') || id.includes('tuer') || id.includes('türen'))) {
            return { type: 'door', canonicalKey: String(canonicalKeyOverride || '') };
        }
        if (funcIds.some(id => id.includes('temp'))) {
            return { type: 'temperature_sensor', canonicalKey: String(canonicalKeyOverride || '') };
        }
        if (funcIds.some(id => id.includes('klima') || id.includes('aircon') || id.includes('climate'))) {
            return { type: 'climate', canonicalKey: String(canonicalKeyOverride || '') };
        }

        if ((role === 'switch' || role === 'switch.power') && stateObj?.common?.write) {
            return { type: 'socket', canonicalKey: String(canonicalKeyOverride || 'on') };
        }

        return { type: '', canonicalKey: String(canonicalKeyOverride || '') };
    };

    const readableName = (n: unknown): string | null => {
        if (typeof n !== 'string' || !n || n.includes('.')) {
            return null;
        }
        return n;
    };

    // hannah#164: lets users fix Hannah's voice-matching name for devices whose
    // ioBroker friendly name is unsuited for it (too long, technical prefixes,
    // duplicates across rooms, ...) without renaming the actual object.
    const nameOverride = stateCustom?.enabled && stateCustom?.name;

    const { stateType, enumValues } = resolveStateType(stateObj);
    const { type, canonicalKey } = resolveTypeAndCanonicalKey();

    // hannah#177/hannah-proto#4: analog zum type/name-Override, aber nur für über die
    // ROLE_TABLE als 'blind' aufgelöste States relevant — Rolladen/Markise-Aktoren, die
    // von sich aus die umgekehrte Konvention (0%=auf/100%=zu) nutzen (z.B. Homematic/KNX).
    // undefined (nicht false) wenn kein Override gesetzt ist — Core unterscheidet "kein
    // Override" von "explizit nicht invertiert" nicht, aber das Proto-Feld erlaubt die
    // Unterscheidung bewusst.
    const shutterInvertedOverride = stateCustom?.enabled ? stateCustom?.shutterInverted : undefined;
    const inverted =
        ROLE_TABLE[role]?.type === 'blind' && shutterInvertedOverride !== undefined
            ? Boolean(shutterInvertedOverride)
            : undefined;

    const meta: DeviceMeta = {
        room: roomId,
        roomNames: roomNames,
        functionIds,
        ownName:
            readableName(stateCustom?.enabled && stateCustom?.name) ??
            readableName(stateObj?.common?.name) ??
            stateId.split('.').at(-1) ??
            '',
        device:
            readableName(nameOverride) ??
            readableName(deviceObj?.common?.name) ??
            readableName(stateObj?.common?.name) ??
            deviceId.split('.').at(-1) ??
            '',
        type,
        floor,
        functions: functionNames,
        stateType,
        enumValues,
        writable: Boolean(stateObj?.common?.write),
        deviceId,
        canonicalKey,
        role,
        unit: typeof stateObj?.common?.unit === 'string' ? stateObj.common.unit : '',
        min: typeof stateObj?.common?.min === 'number' ? stateObj.common.min : undefined,
        max: typeof stateObj?.common?.max === 'number' ? stateObj.common.max : undefined,
        canonicalKeyOverride: stateCustom?.enabled && stateCustom?.canonicalKey ? String(stateCustom.canonicalKey) : '',
        stateObject: stateObj,
        deviceObject: deviceObj,
        inverted,
        requiredTrustLevel,
    };
    return { meta, warnings };
}
