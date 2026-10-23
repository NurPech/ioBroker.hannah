/**
 * Why a device was or was not recognized, and what to change in ioBroker to fix it.
 *
 * The detection and the device model drop states and devices at several points: no room, no state
 * Hannah knows, several states for one slot with no clear winner, a unit of another quantity.
 * Each of these reports a structured `Diagnostic` to an optional `Explain` callback (without one,
 * nothing changes and nothing is collected). The texts are made from the structure by
 * `describeDiagnostic()`, so the standalone tool and the admin UI show the same thing, and a
 * translation needs no change in the detection.
 *
 * Pure: no adapter, no I/O.
 */
import { parentId } from './device-grouping';
import type { ObjectMap } from './device-meta';

/** Why a state is not read at all: it is not subscribed. */
export type NotReadReason = 'no-room' | 'no-function' | 'outside-selection';

/** One finding about a state or a device. */
export type Diagnostic =
    | {
          /** the state is not subscribed, so Hannah never sees it */
          code: 'not-read';
          stateId: string;
          reasons: NotReadReason[];
          /** for `outside-selection`: the rooms and functions the state is in that are not selected, as enum IDs */
          unselected?: { rooms: string[]; functions: string[] };
      }
    | {
          /** none of the states of the device has a room, the device is not reported */
          code: 'no-room';
          deviceId: string;
          stateIds: string[];
      }
    | {
          /** none of the states of the device is one Hannah knows, the device is not reported */
          code: 'no-recognized-slot';
          deviceId: string;
          stateIds: string[];
      }
    | {
          /** a state of a reported device that Hannah knows nothing about stays a generic slot */
          code: 'state-generic';
          deviceId: string;
          stateId: string;
          key: string;
          role: string;
      }
    | {
          /** several states fit one slot and nothing tells them apart, none is used */
          code: 'slot-ambiguous';
          deviceId: string;
          slot: string;
          candidates: string[];
          remaining: string[];
      }
    | {
          /** a state in the unit of another quantity (power in mA) can't carry the slot */
          code: 'unit-mismatch';
          deviceId: string;
          stateId: string;
          slot: string;
          unit: string;
      }
    | {
          /** a writable boolean with the plain role `state` whose name does not say it switches something */
          code: 'switch-implausible';
          stateId: string;
      }
    | {
          /** sibling channels that were merged into one device */
          code: 'merged';
          deviceId: string;
          groupIds: string[];
      }
    | {
          /** sibling channels that stay devices of their own, because they would use a slot twice */
          code: 'merge-blocked';
          deviceId: string;
          groupIds: string[];
      };

/** Receives the findings. */
export type Explain = (diagnostic: Diagnostic) => void;

/** How much a finding matters: a `warning` means something is not used the way it could be, `info` explains a decision or a state that stays a generic slot. */
export type Severity = 'info' | 'warning';

/** A finding in words. */
export interface Explanation {
    /** what happened and why */
    text: string;
    /** what to change in ioBroker, empty = nothing to fix */
    fix: string;
}

const FIX_RECOGNIZE =
    'Set the role of the state (for example level.dimmer, switch.light or value.temperature), or a canonicalKey in its custom settings.';

const NOT_READ_REASONS: Record<NotReadReason, string> = {
    'no-room': 'it is in no room',
    'no-function': 'it is in no function, and functions are selected in the adapter settings',
    'outside-selection': 'its room or function is not among the ones selected in the adapter settings',
};

/**
 * Why states are not read, and what to change.
 *
 * @param reasons - The reasons of a `not-read` finding
 * @param unselected - The rooms and functions the state is in that are not selected, if known
 * @param unselected.rooms - Room enum IDs
 * @param unselected.functions - Function enum IDs
 */
export function describeNotRead(
    reasons: NotReadReason[],
    unselected?: { rooms: string[]; functions: string[] },
): { reason: string; fix: string } {
    const missing = reasons.flatMap(r => (r === 'no-room' ? ['a room'] : r === 'no-function' ? ['a function'] : []));
    const name = (id: string): string => id.replace(/^enum.(rooms|functions)./, '');
    const where = [
        ...(unselected?.functions.length ? [`the function ${unselected.functions.map(name).join(', ')}`] : []),
        ...(unselected?.rooms.length ? [`the room ${unselected.rooms.map(name).join(', ')}`] : []),
    ];
    if (reasons.includes('outside-selection') && where.length > 0) {
        return {
            reason: `it is only in ${where.join(' and ')}, which ${where.length > 1 || (unselected?.functions.length ?? 0) + (unselected?.rooms.length ?? 0) > 1 ? 'are' : 'is'} not selected in the adapter settings`,
            fix: 'Select it in the adapter settings, or assign the state to a function and room that are selected.',
        };
    }
    return {
        reason: reasons.map(r => NOT_READ_REASONS[r]).join(' and '),
        fix:
            missing.length > 0
                ? `Assign the state, its channel or its device to ${missing.join(' and ')} in ioBroker, or change the selection in the adapter settings.`
                : 'Change the selection in the adapter settings, or assign the state to a selected room or function.',
    };
}

/**
 * How much a finding matters.
 *
 * @param diagnostic - The finding
 */
export function severityOf(diagnostic: Diagnostic): Severity {
    return diagnostic.code === 'merged' || diagnostic.code === 'merge-blocked' || diagnostic.code === 'state-generic'
        ? 'info'
        : 'warning';
}

/**
 * The finding in words, with the fix.
 *
 * @param diagnostic - The finding
 */
export function describeDiagnostic(diagnostic: Diagnostic): Explanation {
    switch (diagnostic.code) {
        case 'not-read': {
            const { reason, fix } = describeNotRead(diagnostic.reasons, diagnostic.unselected);
            return { text: `${diagnostic.stateId} is not read by Hannah: ${reason}.`, fix };
        }
        case 'no-room':
            return {
                text: `${diagnostic.deviceId} is not reported: none of its ${diagnostic.stateIds.length} states is in a room.`,
                fix: 'Assign the device, its channel or one of its states to a room (enum.rooms.*).',
            };
        case 'no-recognized-slot':
            return {
                text: `${diagnostic.deviceId} is not reported: none of its ${diagnostic.stateIds.length} states is one Hannah knows.`,
                fix: FIX_RECOGNIZE,
            };
        case 'state-generic':
            return {
                text: `${diagnostic.stateId} is only a generic slot: the key "${diagnostic.key}" with the role "${diagnostic.role || 'none'}" is not one Hannah knows.`,
                fix: FIX_RECOGNIZE,
            };
        case 'slot-ambiguous':
            return {
                text: `${diagnostic.deviceId}: ${diagnostic.candidates.length} states fit the slot "${diagnostic.slot}" (${diagnostic.candidates.join(', ')}) and role, unit, writability and name do not tell them apart (${diagnostic.remaining.join(', ')} remain), so none is used.`,
                fix: 'Set a canonicalKey in the custom settings of the state that should be used, or the role of the others to something else.',
            };
        case 'unit-mismatch':
            return {
                text: `${diagnostic.stateId} is not used as "${diagnostic.slot}": its unit "${diagnostic.unit}" belongs to another quantity.`,
                fix: 'Check the role and the unit (common.unit) of the state.',
            };
        case 'switch-implausible':
            return {
                text: `${diagnostic.stateId} is not taken for a switch: it has the plain role "state" and its name does not say it switches something.`,
                fix: 'Set the role switch, switch.light or switch.power, or a canonicalKey "on" in its custom settings.',
            };
        case 'merged':
            return {
                text: `The channels ${diagnostic.groupIds.join(', ')} are one device, ${diagnostic.deviceId}: same room and function, no slot used twice.`,
                fix: '',
            };
        case 'merge-blocked':
            return {
                text: `In ${diagnostic.deviceId}, ${diagnostic.groupIds.map(g => g.split('.').pop()).join(', ')} stay devices of their own: each has the same controls (for example on), so they are not combined into one device, like the relays of a multi-relay plug. Nothing to fix.`,
                fix: '',
            };
    }
}

/** States that are not read, with the reason and what to change, by the object they sit in. */
export interface NotReadGroup {
    /** why the states are not read */
    reason: string;
    /** what to change in ioBroker */
    fix: string;
    /** the objects the states sit in, with the names of the states */
    objects: Array<{ id: string; states: string[] }>;
}

/**
 * The `not-read` findings grouped by reason, and within that by the object the states sit in.
 *
 * @param findings - Every finding of an analysis
 */
export function groupNotRead(findings: Diagnostic[]): NotReadGroup[] {
    const groups = new Map<string, { reason: string; fix: string; objects: Map<string, string[]> }>();
    for (const d of findings) {
        if (d.code !== 'not-read') {
            continue;
        }
        const { reason, fix } = describeNotRead(d.reasons, d.unselected);
        const group = groups.get(reason) ?? { reason, fix, objects: new Map<string, string[]>() };
        const object = parentId(d.stateId);
        group.objects.set(object, [...(group.objects.get(object) ?? []), d.stateId.slice(object.length + 1)]);
        groups.set(reason, group);
    }
    return [...groups.values()].map(g => ({
        reason: g.reason,
        fix: g.fix,
        objects: [...g.objects].map(([id, states]) => ({ id, states })),
    }));
}

/** What the adapter is configured to read, see `StateWatcher.start()`. */
export interface DiscoveryConfig {
    /** room enum IDs to include, empty = all */
    selectedRooms: string[];
    /** function enum IDs to include, empty = all */
    selectedFunctions: string[];
    /** state ID prefixes that are subscribed besides the enums */
    extraStatePrefixes: string[];
}

/**
 * The members of the enums (all of them, or only the selected ones).
 *
 * @param enums - The room or function enums
 * @param selected - IDs of the enums to look at, empty = all
 */
function membersOf(enums: Record<string, ioBroker.Object>, selected: string[]): Set<string> {
    const members = new Set<string>();
    for (const [id, obj] of Object.entries(enums)) {
        if (obj?.type !== 'enum' || (selected.length > 0 && !selected.includes(id))) {
            continue;
        }
        for (const member of (obj.common as { members?: string[] }).members ?? []) {
            members.add(member);
        }
    }
    return members;
}

function below(prefix: string, id: string): boolean {
    return id === prefix || id.startsWith(`${prefix}.`);
}

/**
 * Which of the states the adapter does not read, and why. Follows the subscription rules of the
 * enum discovery: without a selection every state below a room member is read; with a room
 * selection only those; with a function selection a state is read if it is, or (for a device or
 * channel) lies below, a member of a selected function, and with both, if that member also lies
 * within a selected room. A state below an extra prefix is read in any case.
 *
 * @param stateIds - The states to look at
 * @param rooms - The `enum.rooms.*` objects
 * @param functions - The `enum.functions.*` objects
 * @param objects - The objects of the members of the function enums, to tell a channel from a state
 * @param config - What the adapter is configured to read
 * @param explain - Receives a finding for every state that is not read
 */
export function explainDiscovery(
    stateIds: string[],
    rooms: Record<string, ioBroker.Object>,
    functions: Record<string, ioBroker.Object>,
    objects: ObjectMap,
    config: DiscoveryConfig,
    explain: Explain,
): void {
    const isContainer = (id: string): boolean => ['device', 'channel', 'folder'].includes(objects[id]?.type ?? '');
    const covers = (member: string, id: string): boolean =>
        id === member || (isContainer(member) && id.startsWith(`${member}.`));

    const roomDevices = membersOf(rooms, config.selectedRooms);
    const functionMembers = membersOf(functions, config.selectedFunctions);
    const prefixes = config.extraStatePrefixes
        .filter(p => p)
        .map(p => p.replace(/\//g, '.'))
        .map(p => (p.endsWith('.') ? p : `${p}.`));
    const roomsSelected = config.selectedRooms.length > 0;
    const functionsSelected = config.selectedFunctions.length > 0;

    const discovered = (id: string): boolean => {
        if (!functionsSelected) {
            return [...roomDevices].some(d => below(d, id));
        }
        const functionHits = [...functionMembers].filter(m => covers(m, id));
        if (!roomsSelected) {
            return functionHits.length > 0;
        }
        return functionHits.some(m => [...roomDevices].some(d => below(d, m)));
    };

    const allRoomDevices = membersOf(rooms, []);
    const allFunctionMembers = membersOf(functions, []);
    for (const id of stateIds) {
        if (prefixes.some(p => id.startsWith(p)) || discovered(id)) {
            continue;
        }
        const reasons: NotReadReason[] = [];
        // a room only counts if rooms are looked at: with a function selection alone, it doesn't
        if ((roomsSelected || !functionsSelected) && ![...allRoomDevices].some(d => below(d, id))) {
            reasons.push('no-room');
        }
        if (functionsSelected && ![...allFunctionMembers].some(m => covers(m, id))) {
            reasons.push('no-function');
        }
        if (reasons.length > 0) {
            explain({ code: 'not-read', stateId: id, reasons });
            continue;
        }
        // in a room and a function, just not in the selected ones: say which
        const notSelected = (
            enums: Record<string, ioBroker.Object>,
            selected: string[],
            hit: (m: string) => boolean,
        ): string[] =>
            Object.entries(enums)
                .filter(([enumId, obj]) => obj?.type === 'enum' && !selected.includes(enumId))
                .filter(([, obj]) => ((obj.common as { members?: string[] }).members ?? []).some(hit))
                .map(([enumId]) => enumId);
        explain({
            code: 'not-read',
            stateId: id,
            reasons: ['outside-selection'],
            unselected: {
                rooms: roomsSelected ? notSelected(rooms, config.selectedRooms, m => below(m, id)) : [],
                functions: functionsSelected
                    ? notSelected(functions, config.selectedFunctions, m => covers(m, id))
                    : [],
            },
        });
    }
}
