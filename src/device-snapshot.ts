/**
 * The typed devices (class and slots) of a set of ioBroker states. Pure: the states with their
 * resolved meta data and the objects go in, the device model comes out, so it runs the same on
 * a live ioBroker and on an object dump.
 */
import { v1 } from '@m1kad0/hannah-proto';
import shared = v1.shared;
import { DeviceDetector, type DetectedState } from './device-detection';
import type { Explain } from './device-diagnostics';
import type { DeviceMeta, ObjectMap } from './device-meta';
import { groupIdFor, isInstanceLevel, parentId, planMerges, type Merge, type MergeCandidate } from './device-grouping';
import {
    buildDeviceModel,
    slotKey,
    standardKindsOf,
    type DeviceInput,
    type DeviceModel,
    type DeviceState,
    type ValueType,
} from './device-model';

/** One state of the snapshot with what was resolved about it. */
export interface CollectedState {
    /** ioBroker state ID */
    id: string;
    /** the current value of the state */
    state: Pick<ioBroker.State, 'val'>;
    /** what was resolved about the state, see `resolveDeviceMeta()` */
    meta: DeviceMeta;
}

const VALUE_TYPE_BY_STATE_TYPE: Partial<Record<shared.StateType, ValueType>> = {
    [shared.StateType.BOOLEAN]: 'boolean',
    [shared.StateType.NUMERIC]: 'number',
    [shared.StateType.ENUM]: 'enum',
    [shared.StateType.COLOR]: 'color',
    [shared.StateType.TEXT]: 'text',
};

/**
 * The IDs of the objects that `buildTypedDevices()` reads besides the ones of the states: the
 * device object a merged device is named after.
 *
 * @param collected - Every state of the snapshot
 */
export function mergeDeviceIds(collected: Array<{ id: string }>): string[] {
    return [...new Set(collected.map(c => parentId(parentId(c.id))))].filter(id => !isInstanceLevel(id));
}

/** The typed devices of a snapshot, and which channels were merged on the way. */
export interface TypedDevices {
    /** the devices and the indexes live updates and SetSlot use */
    model: DeviceModel;
    /** the sibling channels that were merged into one device */
    merges: Merge[];
}

/**
 * The typed devices of the snapshot.
 *
 * @param collected - Every state of the snapshot with its resolved meta data
 * @param objects - Further objects: the device objects (`mergeDeviceIds()`) a merged device is named after
 * @param enums - The room and function enums, the device detector uses them too
 * @param explain - Receives the reasons why a device or a state was not used the way it could have been
 */
export function buildTypedDevices(
    collected: CollectedState[],
    objects: ObjectMap,
    enums: Record<string, ioBroker.Object>,
    explain?: Explain,
): TypedDevices {
    const detector = new DeviceDetector(detectionObjects(collected, enums));
    const detectedByGroup = new Map<string, Map<string, DetectedState>>();
    const inputs = new Map<string, DeviceInput>();
    const groupFunctions = new Map<string, string[]>();
    /** group → name override → the states that carry it */
    const nameOverrides = new Map<string, Map<string, string[]>>();
    const seen = new Set<string>();
    for (const { id, state, meta } of collected) {
        if (seen.has(id)) {
            continue;
        }
        seen.add(id);
        const suffix = id.split('.').at(-1) ?? id;
        const groupId = groupIdFor(id);
        let detected = detectedByGroup.get(groupId);
        if (!detected) {
            detected = detector.detect(groupId, explain);
            detectedByGroup.set(groupId, detected);
        }
        const found = detected.get(id);
        const deviceState: DeviceState = {
            stateId: id,
            suffix,
            key: slotKey({
                canonicalKeyOverride: meta.canonicalKeyOverride,
                detectedKey: found?.key,
                role: meta.role,
                canonicalKey: meta.canonicalKey,
                suffix,
            }),
            role: meta.role,
            unit: meta.unit,
            min: meta.min,
            max: meta.max,
            value: state.val,
            valueType: VALUE_TYPE_BY_STATE_TYPE[meta.stateType] ?? 'text',
            writable: meta.writable,
            typeHint: meta.type || found?.typeHint || '',
            inverted: meta.inverted === true,
            requiredTrustLevel: meta.requiredTrustLevel,
            options: Object.keys(meta.enumValues?.values ?? {}),
            slotOverride: meta.slotOverride,
        };
        groupFunctions.set(groupId, [...(groupFunctions.get(groupId) ?? []), ...meta.functionIds]);
        if (meta.nameOverride && groupId !== id) {
            const byName = nameOverrides.get(groupId) ?? new Map<string, string[]>();
            byName.set(meta.nameOverride, [...(byName.get(meta.nameOverride) ?? []), id]);
            nameOverrides.set(groupId, byName);
        }
        const input = inputs.get(groupId);
        if (input) {
            input.floor ||= meta.floor;
            input.states.push(deviceState);
        } else {
            inputs.set(groupId, {
                deviceId: groupId,
                // a state at root or instance level is a device of its own, named after itself
                name: groupId === id ? meta.ownName : (meta.plainDeviceName ?? meta.device),
                room: meta.room,
                floor: meta.floor,
                states: [deviceState],
            });
        }
    }
    // The name override may sit on any state of the device. The same name on several states is one
    // override, different names are a conflict: none is applied, the admin is told.
    const nameOf = new Map<string, string>();
    for (const [groupId, byName] of nameOverrides) {
        const input = inputs.get(groupId);
        if (byName.size === 1 && input) {
            const [name] = byName.keys();
            nameOf.set(groupId, name);
            input.name = name;
        } else if (byName.size > 1) {
            explain?.({
                code: 'name-conflict',
                deviceId: groupId,
                stateIds: [...byName.values()].flat(),
                names: [...byName.keys()],
            });
        }
    }
    const groupTypes = new Map(collected.map(c => [c.meta.deviceId, c.meta.deviceObject?.type]));
    const merges = mergeSiblingChannels(inputs, groupFunctions, objects, groupTypes, nameOf, nameOverrides, explain);
    return { model: buildDeviceModel([...inputs.values()], explain), merges };
}

/**
 * Sibling channels of one device that clearly belong together become one device (same room
 * and function, no slot used twice, see `planMerges()`). The merged device takes the ID of the
 * device object and is named after the name override of one of its states, else after the device object.
 *
 * @param inputs - The devices of the snapshot by group ID, merged in place
 * @param groupFunctions - The functions of the states of every group
 * @param objects - Holds the device objects the merged devices are named after
 * @param groupTypes - The ioBroker object type of every group, undefined = not known
 * @param nameOf - The name override of every group that has exactly one
 * @param nameOverrides - Every name override by group, with the states that carry it
 * @param explain - Receives a finding for every merge, for channels that stay apart, and for names that disagree
 * @returns The merges that were made
 */
function mergeSiblingChannels(
    inputs: Map<string, DeviceInput>,
    groupFunctions: Map<string, string[]>,
    objects: ObjectMap,
    groupTypes: Map<string, string | undefined>,
    nameOf: Map<string, string>,
    nameOverrides: Map<string, Map<string, string[]>>,
    explain?: Explain,
): Merge[] {
    const candidates: MergeCandidate[] = [...inputs.values()].map(input => ({
        groupId: input.deviceId,
        room: input.room,
        functions: groupFunctions.get(input.deviceId) ?? [],
        kinds: standardKindsOf(input.states),
        groupType: groupTypes.get(input.deviceId),
        parentType: objects[parentId(input.deviceId)]?.type,
    }));
    const merges = planMerges(candidates, explain);
    for (const merge of merges) {
        const members = merge.groupIds.map(id => inputs.get(id)).filter((i): i is DeviceInput => i !== undefined);
        let name = members[0].name;
        const objectName = objects[merge.deviceId]?.common?.name;
        if (typeof objectName === 'string' && objectName && !objectName.includes('.')) {
            name = objectName;
        }
        // a name override of a member beats the name of the device object, different ones cancel out
        const overrides = [...new Set(merge.groupIds.flatMap(id => nameOf.get(id) ?? []))];
        if (overrides.length === 1) {
            name = overrides[0];
        } else if (overrides.length > 1) {
            explain?.({
                code: 'name-conflict',
                deviceId: merge.deviceId,
                stateIds: merge.groupIds.flatMap(id => [...(nameOverrides.get(id)?.values() ?? [])].flat()),
                names: overrides,
            });
        }
        for (const id of merge.groupIds) {
            inputs.delete(id);
        }
        inputs.set(merge.deviceId, {
            deviceId: merge.deviceId,
            name,
            room: members[0].room,
            floor: members.map(m => m.floor).find(Boolean) ?? '',
            states: members.flatMap(m => m.states),
        });
        explain?.({ code: 'merged', deviceId: merge.deviceId, groupIds: merge.groupIds });
    }
    return merges;
}

/**
 * The objects the device detector looks at: the states of the snapshot, their channels and
 * devices, and the enums.
 *
 * @param collected - Every state of the snapshot with its resolved meta data
 * @param enums - The room and function enums
 */
function detectionObjects(
    collected: Array<{ id: string; meta: DeviceMeta }>,
    enums: Record<string, ioBroker.Object>,
): Record<string, ioBroker.Object> {
    const objects: Record<string, ioBroker.Object> = { ...enums };
    for (const { id, meta } of collected) {
        if (meta.deviceObject) {
            objects[meta.deviceId] = meta.deviceObject;
        }
        if (meta.stateObject) {
            objects[id] = meta.stateObject;
        }
    }
    return objects;
}
