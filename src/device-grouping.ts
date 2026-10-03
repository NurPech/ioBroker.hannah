/**
 * Which ioBroker states make up one device of the typed device model.
 *
 * The base group of a state is its parent object (channel or device folder), except at root or
 * instance level (`alias.0.`), where the parent holds everything of the adapter and every state
 * is a device of its own. Sibling channels of one device are merged only when they clearly
 * belong together. Pure functions of IDs, rooms, functions and slot kinds, so every rule is
 * testable without an adapter.
 */

/**
 * ID of the object a state sits in.
 *
 * @param id - ioBroker object ID
 */
export function parentId(id: string): string {
    return id.split('.').slice(0, -1).join('.');
}

/**
 * Root or instance level: `alias.0` holds all the states of the instance, so it is no device.
 *
 * @param id - ioBroker object ID of a would-be group
 */
export function isInstanceLevel(id: string): boolean {
    return id.split('.').length <= 2;
}

/**
 * The group a state belongs to: its parent, or the state itself at root or instance level.
 *
 * @param stateId - ioBroker state ID
 */
export function groupIdFor(stateId: string): string {
    const parent = parentId(stateId);
    return isInstanceLevel(parent) ? stateId : parent;
}

/** A group of states that may be merged with a sibling. */
export interface MergeCandidate {
    /** ID of the group (a channel or device folder) */
    groupId: string;
    /** room ID, empty = none */
    room: string;
    /** functions of the states of the group */
    functions: string[];
    /** the standard slot kinds the group's states carry */
    kinds: Set<number>;
}

/** Groups that become one device: the device object they all sit in and the groups to merge. */
export interface Merge {
    /** the device object the channels sit in, becomes the ID of the merged device */
    deviceId: string;
    /** the merged groups */
    groupIds: string[];
}

/**
 * Which sibling channels of one device are really one device. They merge only for the same
 * room and the same (non-empty) function, and only if no slot would be used twice, so the
 * relays of a multi-relay plug stay devices of their own (all or nothing per device). Groups that are nested in each other
 * (a light group with its single lamps) are never merged, the device object itself being a group
 * keeps its channels apart.
 *
 * @param candidates - Every group of the snapshot
 */
export function planMerges(candidates: MergeCandidate[]): Merge[] {
    const groupIds = new Set(candidates.map(c => c.groupId));
    const buckets = new Map<string, MergeCandidate[]>();
    for (const candidate of candidates) {
        const parent = parentId(candidate.groupId);
        if (!candidate.room || candidate.functions.length === 0 || isInstanceLevel(parent) || groupIds.has(parent)) {
            continue;
        }
        const key = JSON.stringify([parent, candidate.room, [...new Set(candidate.functions)].sort()]);
        buckets.set(key, [...(buckets.get(key) ?? []), candidate]);
    }

    const merges: Merge[] = [];
    for (const bucket of buckets.values()) {
        // all or nothing: if two channels would use the same slot (the relays of a plug), it is
        // unclear what belongs to what, so nothing in the bucket is merged
        const all = bucket.flatMap(c => [...c.kinds]);
        if (bucket.length > 1 && new Set(all).size === all.length) {
            const sorted = [...bucket].sort((a, b) => a.groupId.localeCompare(b.groupId));
            merges.push({ deviceId: parentId(sorted[0].groupId), groupIds: sorted.map(c => c.groupId) });
        }
    }
    return merges;
}
