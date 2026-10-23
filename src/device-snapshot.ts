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
        };
        groupFunctions.set(groupId, [...(groupFunctions.get(groupId) ?? []), ...meta.functionIds]);
        const input = inputs.get(groupId);
        if (input) {
            input.floor ||= meta.floor;
            input.states.push(deviceState);
        } else {
            inputs.set(groupId, {
                deviceId: groupId,
                // a state at root or instance level is a device of its own, named after itself
                name: groupId === id ? meta.ownName : meta.device,
                room: meta.room,
                floor: meta.floor,
                states: [deviceState],
            });
        }
    }
    const groupTypes = new Map(collected.map(c => [c.meta.deviceId, c.meta.deviceObject?.type]));
    const merges = mergeSiblingChannels(inputs, groupFunctions, objects, groupTypes, explain);
    return { model: buildDeviceModel([...inputs.values()], explain), merges };
}

/**
 * Sibling channels of one device that clearly belong together become one device (same room
 * and function, no slot used twice, see `planMerges()`). The merged device is named after
 * the device object, and takes the ID of it.
 *
 * @param inputs - The devices of the snapshot by group ID, merged in place
 * @param groupFunctions - The functions of the states of every group
 * @param objects - Holds the device objects the merged devices are named after
 * @param groupTypes - The ioBroker object type of every group, undefined = not known
 * @param explain - Receives a finding for every merge, and for channels that stay apart
 * @returns The merges that were made
 */
function mergeSiblingChannels(
    inputs: Map<string, DeviceInput>,
    groupFunctions: Map<string, string[]>,
    objects: ObjectMap,
    groupTypes: Map<string, string | undefined>,
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
