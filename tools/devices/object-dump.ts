/**
 * Reads what ioBroker writes when you export its objects and states: the admin export (a JSON
 * object of ID to object, or a list of objects), the result of an object view (`rows`) and the
 * `objects.jsonl` / `states.jsonl` files of the file database (one `{"id", "value"}` per line).
 * Pure: the caller reads the file.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The entries of a dump as `[id, value]`, whatever its shape.
 *
 * @param text - The content of the dump file
 */
function entriesOf(text: string): Array<[string, unknown]> {
    const trimmed = text.trim();
    if (trimmed === '') {
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        // not one JSON value: one entry per line
        return trimmed
            .split(/\r?\n/)
            .filter(line => line.trim() !== '')
            .flatMap(line => entriesOf(line));
    }
    if (Array.isArray(parsed)) {
        return parsed.flatMap(item => entryOf(item));
    }
    if (!isRecord(parsed)) {
        return [];
    }
    if (Array.isArray(parsed.rows)) {
        return parsed.rows.flatMap(item => entryOf(item));
    }
    if (isRecord(parsed.objects)) {
        return Object.entries(parsed.objects);
    }
    // a single line of a jsonl file, or a map of ID to value
    const single = entryOf(parsed);
    return single.length > 0 ? single : Object.entries(parsed);
}

function entryOf(item: unknown): Array<[string, unknown]> {
    if (!isRecord(item)) {
        return [];
    }
    if (typeof item.id === 'string' && 'value' in item) {
        return [[item.id, item.value]];
    }
    if (typeof item._id === 'string') {
        return [[item._id, item]];
    }
    return [];
}

/**
 * The objects of an export, by ID.
 *
 * @param text - The content of the dump file
 */
export function parseObjectDump(text: string): Record<string, ioBroker.Object> {
    const objects: Record<string, ioBroker.Object> = {};
    for (const [id, value] of entriesOf(text)) {
        if (isRecord(value) && typeof value.type === 'string') {
            objects[id] = { ...value, _id: id } as unknown as ioBroker.Object;
        }
    }
    return objects;
}

/**
 * The values of an export of states, by ID. A state is `{ "val": ... }`, a plain value is taken as it is.
 *
 * @param text - The content of the dump file
 */
export function parseStateDump(text: string): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const [id, value] of entriesOf(text)) {
        values[id] = isRecord(value) && 'val' in value ? value.val : value;
    }
    return values;
}
