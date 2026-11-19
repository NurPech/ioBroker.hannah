import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'chai';
import { COMMANDS, HELP } from './help';

/**
 * The commands a source file compares `obj.command` with.
 *
 * @param file - Path of the file
 */
function commandsOf(file: string): string[] {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(/obj\.command === '([^']+)'/g)].map(m => m[1]);
}

describe('help', () => {
    const own = COMMANDS.map(c => c.command).filter(c => !c.startsWith('dm:'));
    const dm = COMMANDS.map(c => c.command).filter(c => c.startsWith('dm:'));

    it('lists exactly the commands of onMessage and the MessagesHandler', () => {
        const answered = [...commandsOf(join(__dirname, 'main.ts')), ...commandsOf(join(__dirname, 'messages.ts'))];
        expect([...own].sort()).to.deep.equal([...new Set(answered)].sort());
    });

    it('lists only commands the device manager answers', () => {
        const source = readFileSync(require.resolve('@iobroker/dm-utils/build/DeviceManagement.js'), 'utf8');
        const answered = [...source.matchAll(/case '(dm:[^']+)':/g)].map(m => m[1]);
        expect(dm.length).to.be.greaterThan(0);
        for (const command of dm) {
            expect(answered, command).to.include(command);
        }
    });

    it('lists every command once and names it in the text', () => {
        const names = COMMANDS.map(c => c.command);
        expect(new Set(names).size).to.equal(names.length);
        for (const name of names.filter(n => n !== 'help')) {
            expect(HELP, name).to.contain(name);
        }
    });

    it('marks the commands that act as writing', () => {
        const write = Object.fromEntries(COMMANDS.map(c => [c.command, c.write]));
        for (const name of ['announce', 'ask', 'sendDirect', 'sendNotification', 'provisionSatellite']) {
            expect(write[name], name).to.equal(true);
        }
        for (const name of ['help', 'getDiagnostics']) {
            expect(write[name], name).to.equal(false);
        }
    });

    it('keeps the lines short', () => {
        for (const line of HELP.split('\n')) {
            expect(line.length, line).to.be.at.most(120);
        }
    });
});
