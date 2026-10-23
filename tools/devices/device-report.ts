/**
 * An analysis (`analyzeObjects()`) as text: the devices with their slots, and what was left out
 * and why. Pure: the caller prints it.
 */
import { v2 } from '@m1kad0/hannah-proto';
import type { Analysis } from '../../src/device-analysis';
import { describeDiagnostic, groupNotRead, severityOf, type Diagnostic } from '../../src/device-diagnostics';

import DeviceClass = v2.device_model.DeviceClass;
import SlotKind = v2.device_model.SlotKind;

/** How much of the report to print. */
export interface ReportOptions {
    /** list every device and state that is left out, and the findings that only explain a decision */
    all: boolean;
}

/** How many states and devices that are left out are listed without `all`. */
const LIST_LIMIT = 20;

const GENERIC_KINDS = new Set<SlotKind>([
    SlotKind.SLOT_KIND_GENERIC_NUMBER,
    SlotKind.SLOT_KIND_GENERIC_BOOL,
    SlotKind.SLOT_KIND_GENERIC_TEXT,
]);

/** The findings that say a device is left out altogether, in the order they are printed. */
const NOT_REPORTED: Array<{ code: Diagnostic['code']; title: string }> = [
    { code: 'no-room', title: 'Devices without a room' },
    { code: 'no-recognized-slot', title: 'Devices with no state Hannah knows' },
];

/** The findings that belong to a device that is reported. */
const OF_DEVICE = new Set<Diagnostic['code']>(['state-generic', 'slot-ambiguous', 'unit-mismatch']);

function indent(text: string, by: string): string {
    return text
        .split('\n')
        .map(line => by + line)
        .join('\n');
}

function finding(diagnostic: Diagnostic): string {
    const { text, fix } = describeDiagnostic(diagnostic);
    return fix ? `${text}\n  Fix: ${fix}` : text;
}

function listLimited(items: string[], all: boolean): string[] {
    if (all || items.length <= LIST_LIMIT) {
        return items;
    }
    return [...items.slice(0, LIST_LIMIT), `... and ${items.length - LIST_LIMIT} more (use --all to list them)`];
}

/**
 * The ID of a state without the ID of its device, which the line above already names.
 *
 * @param stateId - ioBroker state ID
 * @param deviceId - ID of the device the state belongs to
 */
function shortId(stateId: string, deviceId: string): string {
    return stateId.startsWith(`${deviceId}.`) ? stateId.slice(deviceId.length) : stateId;
}

/**
 * The states that are not read, by the object they sit in and the reason.
 *
 * @param findings - Every finding of the analysis
 * @param all - List every object, not only the first ones
 */
function notReadSection(findings: Diagnostic[], all: boolean): string[] {
    const groups = groupNotRead(findings);
    if (groups.length === 0) {
        return [];
    }
    const count = (g: (typeof groups)[number]): number => g.objects.reduce((n, o) => n + o.states.length, 0);
    const lines = [`States the adapter does not read (${groups.reduce((n, g) => n + count(g), 0)})`];
    for (const group of groups) {
        lines.push(
            `  ${count(group)} states in ${group.objects.length} objects: ${group.reason}.`,
            `  Fix: ${group.fix}`,
        );
        lines.push(
            ...listLimited(
                group.objects.map(o => `    ${o.id}: ${o.states.join(', ')}`),
                all,
            ),
        );
    }
    return [...lines, ''];
}

/**
 * The analysis as text.
 *
 * @param analysis - The result of `analyzeObjects()`
 * @param options - How much to print
 */
export function formatReport(analysis: Analysis, options: Partial<ReportOptions> = {}): string {
    const all = options.all === true;
    const lines: string[] = [
        `States looked at: ${analysis.counts.states}, read by the adapter: ${analysis.counts.read}${analysis.counts.raw > 0 ? ` (${analysis.counts.raw} of them raw states through extra prefixes, no devices)` : ''}, devices for Hannah: ${analysis.devices.length}`,
    ];
    if (analysis.roomEnums === 0 && !analysis.simulated && analysis.counts.states > 0) {
        lines.push(
            '',
            'Note: the dump has no room enums (enum.rooms.*), so no state is in a room. Export the enums with the objects, or use --simulate to see what is understood regardless of the assignment.',
        );
    }
    if (analysis.unknownSelection.length > 0) {
        const roomsWrong = analysis.unknownSelection.some(id => !id.startsWith('enum.functions.'));
        const functionsWrong = analysis.unknownSelection.some(id => id.startsWith('enum.functions.'));
        lines.push(
            '',
            `Note: ${analysis.unknownSelection.join(', ')} ${analysis.unknownSelection.length === 1 ? 'is' : 'are'} not in the dump, so nothing matches.`,
            ...(roomsWrong ? [`  Rooms in the dump: ${analysis.enumIds.rooms.join(', ') || 'none'}`] : []),
            ...(functionsWrong ? [`  Functions in the dump: ${analysis.enumIds.functions.join(', ') || 'none'}`] : []),
        );
    }
    if (analysis.defaultSelection && !analysis.simulated) {
        lines.push(
            '',
            'Assuming every room and function of the dump is selected in the adapter: a state needs a room and a function. Use --config <file> for the selection of your adapter.',
        );
    }
    lines.push('');

    const reported = new Set(analysis.devices.map(d => d.deviceId));
    const shown = new Set<Diagnostic>();
    const devices = [...analysis.devices].sort((a, b) =>
        `${analysis.rooms[a.room] ?? a.room} ${a.name}`.localeCompare(`${analysis.rooms[b.room] ?? b.room} ${b.name}`),
    );
    for (const device of devices) {
        const room = analysis.rooms[device.room] ?? device.room;
        lines.push(
            `${room} · ${device.name}: ${DeviceClass[device.deviceClass].replace('DEVICE_CLASS_', '')} (${device.deviceId})`,
        );
        const generic: string[] = [];
        for (const slot of device.slots) {
            if (GENERIC_KINDS.has(slot.kind)) {
                generic.push(slot.slotId);
                continue;
            }
            const state = analysis.states.get(slot.identifier);
            const detail = [state?.role, state?.unit].filter(Boolean).join(', ');
            lines.push(
                `    ${slot.slotId.padEnd(20)} ${SlotKind[slot.kind].replace('SLOT_KIND_', '').padEnd(18)} ${slot.writable ? 'rw' : 'ro'}  ${shortId(slot.identifier, device.deviceId)}${detail ? ` (${detail})` : ''}`,
            );
        }
        if (generic.length > 0) {
            lines.push(`    + ${generic.length} generic slots: ${generic.join(', ')}`);
        }
        for (const d of analysis.findings) {
            if (d.code === 'merged' && d.deviceId === device.deviceId) {
                lines.push(`    merged from the channels ${d.groupIds.join(', ')}`);
                shown.add(d);
            } else if (OF_DEVICE.has(d.code) && 'deviceId' in d && d.deviceId === device.deviceId) {
                shown.add(d);
                // a state that stays a generic slot is listed above, its explanation only on request
                if (all || severityOf(d) === 'warning') {
                    lines.push(indent(`${severityOf(d) === 'warning' ? '!' : '-'} ${finding(d)}`, '    '));
                }
            }
        }
        lines.push('');
    }

    lines.push(...notReadSection(analysis.findings, all));
    analysis.findings.filter(d => d.code === 'not-read').forEach(d => shown.add(d));

    for (const { code, title } of NOT_REPORTED) {
        const group = analysis.findings.filter(d => d.code === code);
        if (group.length === 0) {
            continue;
        }
        group.forEach(d => shown.add(d));
        lines.push(
            `${title} (${group.length})`,
            ...listLimited(
                group.map(d => indent(finding(d), '  ')),
                all,
            ),
            '',
        );
    }

    const other = analysis.findings.filter(d => !shown.has(d) && (all || severityOf(d) === 'warning'));
    if (other.length > 0) {
        // a finding about a device that is not reported belongs to the devices that are left out
        const label = (d: Diagnostic): string =>
            d.code !== 'merged' && d.code !== 'merge-blocked' && 'deviceId' in d && !reported.has(d.deviceId)
                ? '(not reported) '
                : '';
        lines.push(
            `Other findings (${other.length})`,
            ...listLimited(
                other.map(d => indent(label(d) + finding(d), '  ')),
                all,
            ),
            '',
        );
    }
    return `${lines.join('\n').trimEnd()}\n`;
}
