/**
 * Shows how the adapter understands the devices of an ioBroker setup, from an object dump, without
 * an adapter and without ioBroker:
 *
 *     node build/cli.js objects.json --states states.json --simulate
 *
 * See `printUsage()` for the options.
 */
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import { analyzeObjects, type AnalysisOptions } from './device-analysis';
import { formatReport } from './device-report';
import { parseObjectDump, parseStateDump } from './object-dump';

/** What was asked for on the command line. */
export interface CliArguments {
    /** the file with the objects */
    objectsFile: string;
    /** the file with the states, if any */
    statesFile: string | undefined;
    /** print the analysis as JSON */
    json: boolean;
    /** list everything */
    all: boolean;
    /** the options of the analysis */
    analysis: Partial<AnalysisOptions>;
}

const USAGE = `Usage: node build/cli.js <objects-file> [options]

Shows how the adapter understands the devices of an ioBroker setup.

  <objects-file>          objects of the setup: admin export, objects.json or objects.jsonl (.gz is fine)

Options:
  --states <file>         states of the setup (states.json or states.jsonl), for the values
  --simulate              pretend every device is in a room and a function, to see what is
                          understood regardless of the assignment
  --prefix <id>           only states below this ID, e.g. hm-rpc.0. (repeatable, or comma separated)
  --rooms <enum ids>      read only these rooms, like the adapter setting (comma separated)
  --functions <enum ids>  read only these functions, like the adapter setting (comma separated)
  --extra-prefix <id>     state ID prefix the adapter reads besides the enums (repeatable)
  --namespace <name>      adapter instance whose common.custom overrides count (default hannah.0)
  --all                   list every state and device that is left out, and what only explains a decision
  --json                  print devices and findings as JSON
  -h, --help              this text
`;

/** The usage text. */
export function printUsage(): string {
    return USAGE;
}

function list(value: string): string[] {
    return value
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
}

/**
 * Reads the command line.
 *
 * @param argv - The arguments after the script name
 * @returns The arguments, or the text to tell the user what is wrong with them
 */
export function parseArguments(argv: string[]): CliArguments | string {
    const args: CliArguments = { objectsFile: '', statesFile: undefined, json: false, all: false, analysis: {} };
    const analysis: Partial<AnalysisOptions> = {};
    const value = (i: number, name: string): string => {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            throw new Error(`${name} needs a value`);
        }
        return next;
    };
    try {
        for (let i = 0; i < argv.length; i++) {
            const arg = argv[i];
            switch (arg) {
                case '--states':
                    args.statesFile = value(i++, arg);
                    break;
                case '--simulate':
                    analysis.simulate = true;
                    break;
                case '--prefix':
                    analysis.prefixes = [...(analysis.prefixes ?? []), ...list(value(i++, arg))];
                    break;
                case '--rooms':
                    analysis.selectedRooms = list(value(i++, arg));
                    break;
                case '--functions':
                    analysis.selectedFunctions = list(value(i++, arg));
                    break;
                case '--extra-prefix':
                    analysis.extraStatePrefixes = [...(analysis.extraStatePrefixes ?? []), ...list(value(i++, arg))];
                    break;
                case '--namespace':
                    analysis.namespace = value(i++, arg);
                    break;
                case '--all':
                    args.all = true;
                    break;
                case '--json':
                    args.json = true;
                    break;
                default:
                    if (arg.startsWith('-') || args.objectsFile) {
                        return `Unknown argument ${arg}`;
                    }
                    args.objectsFile = arg;
            }
        }
    } catch (e) {
        return (e as Error).message;
    }
    if (!args.objectsFile) {
        return 'No objects file given';
    }
    args.analysis = analysis;
    return args;
}

function readText(file: string): string {
    const raw = fs.readFileSync(file);
    return (file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8');
}

/**
 * Runs the tool.
 *
 * @param argv - The arguments after the script name
 * @returns The text to print and the exit code
 */
export function run(argv: string[]): { output: string; code: number } {
    if (argv.includes('-h') || argv.includes('--help')) {
        return { output: USAGE, code: 0 };
    }
    const args = parseArguments(argv);
    if (typeof args === 'string') {
        return { output: `${args}\n\n${USAGE}`, code: 2 };
    }
    let objects;
    let values = {};
    try {
        objects = parseObjectDump(readText(args.objectsFile));
        if (args.statesFile) {
            values = parseStateDump(readText(args.statesFile));
        }
    } catch (e) {
        return { output: `Cannot read the dump: ${(e as Error).message}\n`, code: 1 };
    }
    if (Object.keys(objects).length === 0) {
        return { output: `No objects found in ${args.objectsFile}\n`, code: 1 };
    }
    const analysis = analyzeObjects(objects, values, args.analysis);
    if (args.json) {
        const { devices, findings, counts } = analysis;
        // values of slots can be 64-bit numbers
        const output = JSON.stringify(
            { counts, devices, findings },
            (_k, v) => (typeof v === 'bigint' ? String(v) : v),
            2,
        );
        return { output: `${output}\n`, code: 0 };
    }
    return { output: formatReport(analysis, { all: args.all }), code: 0 };
}

if (require.main === module) {
    const { output, code } = run(process.argv.slice(2));
    process.stdout.write(output);
    process.exitCode = code;
}
