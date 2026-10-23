/**
 * The device diagnostics for the admin UI: what Hannah gets from the setup of this ioBroker, and
 * what is left out and why. It loads the objects that matter (the rooms and functions with
 * everything below their members, and the extra prefixes), runs the same analysis as the
 * standalone tool (`analyzeObjects()`) with the adapter settings, and turns the result into plain
 * data for the UI.
 */
import type * as utils from '@iobroker/adapter-core';
import { v2 } from '@m1kad0/hannah-proto';
import { analyzeObjects, type Analysis } from './device-analysis';
import { describeDiagnostic, groupNotRead, severityOf, type Diagnostic, type NotReadGroup } from './device-diagnostics';
import { isInstanceLevel, parentId } from './device-grouping';

import DeviceClass = v2.device_model.DeviceClass;
import SlotKind = v2.device_model.SlotKind;

/** What the UI asks for: the settings as they are in the form, saved or not. */
export interface DiagnosticsRequest {
    /** room enum IDs the adapter reads, empty = no selection (every room) */
    selectedRooms?: string[];
    /** function enum IDs the adapter reads, empty = no selection (no function needed) */
    selectedFunctions?: string[];
    /** state ID prefixes the adapter reads besides the enums */
    extraStatePrefixes?: string[];
    /** only look at states below one of these ID prefixes, empty = all */
    prefixes?: string[];
}

/** A finding in words. */
export interface DiagnosticsFinding {
    /** `warning` = something is not used the way it could be, `info` = explains a decision */
    severity: 'info' | 'warning';
    /** what happened and why */
    text: string;
    /** what to change in ioBroker, empty = nothing to fix */
    fix: string;
}

/** One slot of a device. */
export interface DiagnosticsSlot {
    /** ID of the slot */
    id: string;
    /** what it means, e.g. BRIGHTNESS, GENERIC_NUMBER */
    kind: string;
    /** the slot can be set */
    writable: boolean;
    /** the ioBroker state behind it */
    stateId: string;
    /** common.role of the state */
    role: string;
    /** common.unit of the state */
    unit: string;
}

/** A device as Hannah gets it. */
export interface DiagnosticsDevice {
    /** ID of the device */
    id: string;
    /** name */
    name: string;
    /** display name of the room */
    room: string;
    /** the class, e.g. LIGHT */
    deviceClass: string;
    /** the slots Hannah knows */
    slots: DiagnosticsSlot[];
    /** the states that stay generic slots, by slot ID */
    genericSlots: string[];
    /** what is to know about the device */
    findings: DiagnosticsFinding[];
}

/** The answer to the UI. */
export interface DiagnosticsResult {
    /** how many states were looked at, how many the adapter reads, and how many of those as raw states */
    counts: { states: number; read: number; raw: number };
    /** the devices Hannah gets */
    devices: DiagnosticsDevice[];
    /** the states that are not read, by reason */
    notRead: NotReadGroup[];
    /** devices and states that are left out for other reasons, and other warnings */
    other: DiagnosticsFinding[];
    /** things to know about the settings, e.g. a room that is selected but does not exist */
    notes: string[];
}

/** The findings that belong to a device that is reported. */
const OF_DEVICE = new Set<Diagnostic['code']>(['state-generic', 'slot-ambiguous', 'unit-mismatch', 'merged']);

/** Last character of the ID range of a prefix, like the enum discovery uses it. */
const RANGE_END = '香';

const GENERIC_KINDS = new Set<SlotKind>([
    SlotKind.SLOT_KIND_GENERIC_NUMBER,
    SlotKind.SLOT_KIND_GENERIC_BOOL,
    SlotKind.SLOT_KIND_GENERIC_TEXT,
]);

function findingOf(d: Diagnostic): DiagnosticsFinding {
    const { text, fix } = describeDiagnostic(d);
    return { severity: severityOf(d), text, fix };
}

/**
 * The analysis as plain data for the UI.
 *
 * @param analysis - The result of `analyzeObjects()`
 */
export function summarize(analysis: Analysis): DiagnosticsResult {
    const reported = new Set(analysis.devices.map(d => d.deviceId));
    const shown = new Set<Diagnostic>();
    const devices = analysis.devices.map((device): DiagnosticsDevice => {
        const findings = analysis.findings.filter(
            d => OF_DEVICE.has(d.code) && 'deviceId' in d && d.deviceId === device.deviceId,
        );
        findings.forEach(d => shown.add(d));
        return {
            id: device.deviceId,
            name: device.name,
            room: analysis.rooms[device.room] ?? device.room,
            deviceClass: DeviceClass[device.deviceClass].replace('DEVICE_CLASS_', ''),
            slots: device.slots
                .filter(s => !GENERIC_KINDS.has(s.kind))
                .map(s => ({
                    id: s.slotId,
                    kind: SlotKind[s.kind].replace('SLOT_KIND_', ''),
                    writable: s.writable,
                    stateId: s.identifier,
                    role: analysis.states.get(s.identifier)?.role ?? '',
                    unit: analysis.states.get(s.identifier)?.unit ?? '',
                })),
            genericSlots: device.slots.filter(s => GENERIC_KINDS.has(s.kind)).map(s => s.slotId),
            findings: findings.map(findingOf),
        };
    });
    analysis.findings.filter(d => d.code === 'not-read').forEach(d => shown.add(d));

    const notes: string[] = [];
    if (analysis.unknownSelection.length > 0) {
        notes.push(`Selected but not in ioBroker: ${analysis.unknownSelection.join(', ')}`);
    }
    return {
        counts: analysis.counts,
        devices: devices.sort((a, b) => `${a.room} ${a.name}`.localeCompare(`${b.room} ${b.name}`)),
        notRead: groupNotRead(analysis.findings),
        // what is left: devices without a room, with nothing known, and other warnings; the ones about a
        // device that is reported are with the device, and what only explains a decision is not news
        other: analysis.findings
            .filter(d => !shown.has(d) && severityOf(d) === 'warning')
            .filter(d => !('deviceId' in d) || !reported.has(d.deviceId) || !OF_DEVICE.has(d.code))
            .map(findingOf),
        notes,
    };
}

/**
 * The shortest list of IDs that covers all of them: an ID below another one is dropped.
 *
 * @param ids - ioBroker object IDs
 */
export function collapseRoots(ids: string[]): string[] {
    const kept: string[] = [];
    for (const id of [...new Set(ids)].filter(Boolean).sort()) {
        if (!kept.some(k => id === k || id.startsWith(`${k}.`))) {
            kept.push(id);
        }
    }
    return kept;
}

/** The objects of the setup, and the IDs that could not be loaded. */
export interface LoadedObjects {
    /** the objects by ID */
    objects: Record<string, ioBroker.Object>;
    /** IDs that ioBroker refused, with the reason, e.g. a member of an enum that ends in a dot */
    skipped: string[];
    /** members of enums that are no object in ioBroker (and have nothing below them), with the enums that list them */
    missing: string[];
}

/**
 * The objects the analysis needs: the enums, everything below their members and below the extra
 * prefixes, and the two objects above each of those (their type tells a device from a folder). An
 * ID that ioBroker refuses is skipped and named, it does not stop the rest.
 *
 * @param adapter - The adapter instance
 * @param prefixes - Further IDs to load, besides the members of the enums
 */
export async function loadObjects(adapter: utils.AdapterInstance, prefixes: string[]): Promise<LoadedObjects> {
    const objects: Record<string, ioBroker.Object> = {};
    const skipped: string[] = [];
    const attempt = async <T>(id: string, load: () => Promise<T>): Promise<T | undefined> => {
        try {
            return await load();
        } catch (e) {
            skipped.push(`${id}: ${(e as Error).message}`);
            return undefined;
        }
    };
    for (const kind of ['rooms', 'functions']) {
        const view = await adapter.getObjectViewAsync('system', 'enum', {
            startkey: `enum.${kind}.`,
            endkey: `enum.${kind}.${RANGE_END}`,
        });
        for (const row of view.rows) {
            if (row.value) {
                objects[row.id] = row.value;
            }
        }
    }
    // a member that ends in a dot is no valid ID, the object it means is the one without the dot
    const members = new Set(prefixes.map(p => p.replace(/\.+$/, '')));
    const enumsOf = new Map<string, string[]>();
    for (const [id, obj] of Object.entries(objects)) {
        if (id.startsWith('enum.')) {
            for (const member of (obj.common as { members?: string[] }).members ?? []) {
                const clean = member.replace(/\.+$/, '');
                members.add(clean);
                enumsOf.set(clean, [...(enumsOf.get(clean) ?? []), id]);
            }
        }
    }
    members.delete('');
    const above = new Set<string>();
    const missing: string[] = [];
    for (const root of collapseRoots([...members])) {
        const own = await attempt(root, () => adapter.getForeignObjectAsync(root));
        if (own) {
            objects[root] = own;
        }
        const below = await attempt(root, () => adapter.getForeignObjectsAsync(`${root}.*`));
        Object.assign(objects, below);
        if (own === null && below && Object.keys(below).length === 0 && enumsOf.has(root)) {
            missing.push(`${root} (in ${enumsOf.get(root)?.join(', ')})`);
        }
        for (const id of [parentId(root), parentId(parentId(root))]) {
            if (!isInstanceLevel(id) && !id.endsWith('.')) {
                above.add(id);
            }
        }
    }
    for (const id of above) {
        if (!(id in objects)) {
            const obj = await attempt(id, () => adapter.getForeignObjectAsync(id));
            if (obj) {
                objects[id] = obj;
            }
        }
    }
    return { objects, skipped, missing };
}

/**
 * Runs the diagnostics for the settings of the request.
 *
 * @param adapter - The adapter instance
 * @param request - The settings to look at
 */
export async function runDiagnostics(
    adapter: utils.AdapterInstance,
    request: DiagnosticsRequest,
): Promise<DiagnosticsResult> {
    const extra = (request.extraStatePrefixes ?? []).filter(Boolean);
    const { objects, skipped, missing } = await loadObjects(adapter, [...extra, ...(request.prefixes ?? [])]);
    const result = summarize(
        analyzeObjects(
            objects,
            {},
            {
                selectedRooms: request.selectedRooms ?? [],
                selectedFunctions: request.selectedFunctions ?? [],
                extraStatePrefixes: extra,
                prefixes: request.prefixes ?? [],
                namespace: adapter.namespace,
            },
        ),
    );
    return {
        ...result,
        notes: [
            ...result.notes,
            ...missing.map(m => `Member of an enum that does not exist in ioBroker: ${m}`),
            ...skipped.map(s => `Not loaded: ${s}`),
        ],
    };
}
