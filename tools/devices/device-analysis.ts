/**
 * What the adapter makes of a set of ioBroker objects: the typed devices Hannah would get, and
 * the findings that explain what was left out and why. Runs the same steps as the adapter's
 * snapshot, on an object dump instead of a live ioBroker, so it needs neither: it is a pure
 * function of the objects (and optionally the values of the states).
 */
import type { v2 } from '@m1kad0/hannah-proto';
import { explainDiscovery, type Diagnostic } from '../../src/device-diagnostics';
import { parentId } from '../../src/device-grouping';
import { resolveDeviceMeta } from '../../src/device-meta';
import { buildTypedDevices } from '../../src/device-snapshot';

/** What to analyze and how the adapter would be configured. */
export interface AnalysisOptions {
    /** only states below one of these ID prefixes, empty = all */
    prefixes: string[];
    /** pretend every state is in a room and a function, to see what the parser understands regardless of the assignment */
    simulate: boolean;
    /** room enum IDs the adapter reads, `all` = every room of the dump (the default), empty = no selection, which reads every room */
    selectedRooms: string[];
    /** function enum IDs the adapter reads, `all` = every function of the dump (the default), empty = no selection, which needs no function */
    selectedFunctions: string[];
    /** state ID prefixes the adapter reads besides the enums */
    extraStatePrefixes: string[];
    /** adapter namespace, the key of the `common.custom` overrides */
    namespace: string;
}

/** What the analysis knows about a state that ended up in a device. */
export interface AnalyzedState {
    /** common.role of the state */
    role: string;
    /** common.unit of the state */
    unit: string;
}

/** The result of an analysis. */
export interface Analysis {
    /** the devices Hannah would get */
    devices: v2.device_model.TypedDevice[];
    /** what was left out or decided, and why */
    findings: Diagnostic[];
    /** the states the adapter would read, with what is needed to describe their slots */
    states: Map<string, AnalyzedState>;
    /** display name of every room by ID */
    rooms: Record<string, string>;
    /** how many room enums the dump has, none means no state is in a room */
    roomEnums: number;
    /** the IDs of the room and function enums the dump has */
    enumIds: { rooms: string[]; functions: string[] };
    /** room and function enums that were selected but are not in the dump, so they match nothing */
    unknownSelection: string[];
    /** every state was taken as being in a room and a function */
    simulated: boolean;
    /** neither a room nor a function selection was given, so every room and function of the dump counted as selected */
    defaultSelection: boolean;
    /** how many states were looked at, how many of them the adapter reads, and how many of those only as raw states (extra prefixes) */
    counts: { states: number; read: number; raw: number };
}

const DEFAULTS: AnalysisOptions = {
    prefixes: [],
    simulate: false,
    // every room and function of the dump: a state needs a room and a function to be read
    selectedRooms: ['all'],
    selectedFunctions: ['all'],
    extraStatePrefixes: [],
    namespace: 'hannah.0',
};

function enumsWith(objects: Record<string, ioBroker.Object>, prefix: string): Record<string, ioBroker.Object> {
    return Object.fromEntries(
        Object.entries(objects).filter(([id, obj]) => id.startsWith(prefix) && obj?.type === 'enum'),
    );
}

function enumObject(id: string, members: string[]): ioBroker.Object {
    return { _id: id, type: 'enum', common: { name: 'simulation', members }, native: {} } as unknown as ioBroker.Object;
}

function displayName(name: unknown, fallback: string): string {
    if (typeof name === 'string' && name) {
        return name;
    }
    if (name && typeof name === 'object') {
        const names = name as Record<string, unknown>;
        const text = names.de ?? names.en ?? Object.values(names).find(v => typeof v === 'string');
        if (typeof text === 'string' && text) {
            return text;
        }
    }
    return fallback;
}

/**
 * An export with the system info carries the rooms and functions on the objects themselves
 * (`common.enums`) instead of as enum objects with members. This turns them into enum objects: an
 * object is a member of every enum it lists. Enum objects the dump has are kept, their members too.
 *
 * @param objects - The objects of the dump
 */
export function withEmbeddedEnums(objects: Record<string, ioBroker.Object>): Record<string, ioBroker.Object> {
    const embedded = new Map<string, { enumObject: Record<string, any>; members: Set<string> }>();
    for (const [id, obj] of Object.entries(objects)) {
        const list = (obj?.common as { enums?: unknown } | undefined)?.enums;
        if (!Array.isArray(list)) {
            continue;
        }
        for (const entry of list) {
            const enumId = (entry as { _id?: unknown } | undefined)?._id;
            if (typeof enumId !== 'string') {
                continue;
            }
            const found = embedded.get(enumId) ?? {
                enumObject: entry as Record<string, any>,
                members: new Set<string>(),
            };
            found.members.add(id);
            embedded.set(enumId, found);
        }
    }
    const result = { ...objects };
    for (const [enumId, { enumObject, members }] of embedded) {
        const existing = objects[enumId];
        const known = (existing?.common as { members?: string[] } | undefined)?.members ?? [];
        result[enumId] = {
            ...(existing ?? { native: {} }),
            _id: enumId,
            type: 'enum',
            common: {
                ...(existing?.common ?? { name: enumObject.common?.name ?? enumId.split('.').pop() }),
                members: [...new Set([...known, ...members])],
            },
        } as unknown as ioBroker.Object;
    }
    return result;
}

/**
 * The states a finding is about.
 *
 * @param d - The finding
 */
function statesOf(d: Diagnostic): string[] {
    switch (d.code) {
        case 'no-room':
        case 'no-recognized-slot':
            return d.stateIds;
        case 'slot-ambiguous':
            return d.candidates;
        case 'merged':
        case 'merge-blocked':
            return [];
        default:
            return [d.stateId];
    }
}

/**
 * Analyzes an object dump.
 *
 * @param dump - The objects of the setup, with the `enum.rooms.*` and `enum.functions.*` enums, or with `common.enums` on the objects
 * @param values - The values of the states by ID, missing = no value
 * @param options - What to look at, see `AnalysisOptions`
 */
export function analyzeObjects(
    dump: Record<string, ioBroker.Object>,
    values: Record<string, unknown> = {},
    options: Partial<AnalysisOptions> = {},
): Analysis {
    const opts = { ...DEFAULTS, ...options };
    const objects = withEmbeddedEnums(dump);
    let rooms = enumsWith(objects, 'enum.rooms.');
    let functions = enumsWith(objects, 'enum.functions.');
    const roomEnums = Object.keys(rooms).length;
    const enumIds = { rooms: Object.keys(rooms).sort(), functions: Object.keys(functions).sort() };
    // "all" selects every enum of the dump, like an adapter setting with every room or function ticked
    const selectedRooms = opts.selectedRooms.includes('all') ? Object.keys(rooms) : opts.selectedRooms;
    const selectedFunctions = opts.selectedFunctions.includes('all') ? Object.keys(functions) : opts.selectedFunctions;
    const unknownSelection = [
        ...selectedRooms.filter(id => !(id in rooms)),
        ...selectedFunctions.filter(id => !(id in functions)),
    ];
    const roomNames = Object.fromEntries(
        Object.entries(rooms).map(([id, obj]) => {
            const roomId = id.split('.').pop() ?? id;
            return [roomId, displayName(obj.common?.name, roomId)];
        }),
    );

    const stateIds = Object.keys(objects)
        .filter(id => objects[id]?.type === 'state' && !id.startsWith('system.'))
        .filter(id => opts.prefixes.length === 0 || opts.prefixes.some(p => id.startsWith(p)))
        .sort();

    const findings: Diagnostic[] = [];
    let read = stateIds;
    // states that are read only because of an extra prefix: raw states (car, weather), no devices
    let raw = new Set<string>();
    if (opts.simulate) {
        // every device gets a room and a function of its own making, unless it has one
        const devices = [...new Set(stateIds.map(parentId))];
        rooms = { ...rooms, 'enum.rooms.simulation': enumObject('enum.rooms.simulation', devices) };
        functions = { ...functions, 'enum.functions.simulation': enumObject('enum.functions.simulation', devices) };
        roomNames.simulation = 'simulation';
    } else {
        const notRead = new Set<string>();
        explainDiscovery(
            stateIds,
            rooms,
            functions,
            objects,
            {
                selectedRooms,
                selectedFunctions,
                extraStatePrefixes: opts.extraStatePrefixes,
            },
            d => {
                findings.push(d);
                if (d.code === 'not-read') {
                    notRead.add(d.stateId);
                }
            },
        );
        read = stateIds.filter(id => !notRead.has(id));

        const byEnums = new Set(read);
        explainDiscovery(
            read,
            rooms,
            functions,
            objects,
            { selectedRooms, selectedFunctions, extraStatePrefixes: [] },
            d => d.code === 'not-read' && byEnums.delete(d.stateId),
        );
        raw = new Set(read.filter(id => !byEnums.has(id)));
    }

    const collected = read.map(id => ({
        id,
        state: { val: (values[id] ?? null) as ioBroker.StateValue },
        meta: resolveDeviceMeta(id, objects, rooms, functions, {
            namespace: opts.namespace,
            floorMappings: [],
        }).meta,
    }));
    const { model } = buildTypedDevices(collected, objects, { ...rooms, ...functions }, d => findings.push(d));

    return {
        devices: model.devices,
        // a raw state is no device: what is missing for one is no problem
        findings: findings.filter(d => {
            const states = statesOf(d);
            return states.length === 0 || !states.every(id => raw.has(id));
        }),
        states: new Map(collected.map(c => [c.id, { role: c.meta.role, unit: c.meta.unit }])),
        rooms: roomNames,
        roomEnums,
        enumIds,
        unknownSelection,
        simulated: opts.simulate,
        defaultSelection: options.selectedRooms === undefined && options.selectedFunctions === undefined,
        counts: { states: stateIds.length, read: read.length, raw: raw.size },
    };
}
