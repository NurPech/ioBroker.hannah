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
    /** room enum IDs the adapter reads, empty = all */
    selectedRooms: string[];
    /** function enum IDs the adapter reads, empty = all */
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
    /** how many states were looked at, and how many of them the adapter reads */
    counts: { states: number; read: number };
}

const DEFAULTS: AnalysisOptions = {
    prefixes: [],
    simulate: false,
    selectedRooms: [],
    selectedFunctions: [],
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
 * Analyzes an object dump.
 *
 * @param objects - The objects of the setup, with the `enum.rooms.*` and `enum.functions.*` enums
 * @param values - The values of the states by ID, missing = no value
 * @param options - What to look at, see `AnalysisOptions`
 */
export function analyzeObjects(
    objects: Record<string, ioBroker.Object>,
    values: Record<string, unknown> = {},
    options: Partial<AnalysisOptions> = {},
): Analysis {
    const opts = { ...DEFAULTS, ...options };
    let rooms = enumsWith(objects, 'enum.rooms.');
    let functions = enumsWith(objects, 'enum.functions.');
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
                selectedRooms: opts.selectedRooms,
                selectedFunctions: opts.selectedFunctions,
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
        findings,
        states: new Map(collected.map(c => [c.id, { role: c.meta.role, unit: c.meta.unit }])),
        rooms: roomNames,
        counts: { states: stateIds.length, read: read.length },
    };
}
