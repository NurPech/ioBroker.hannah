import { expect } from 'chai';
import { MessagesHandler } from './messages';

/**
 * Runs a `sendNotification` through the handler and returns what is forwarded to Hannah Core.
 *
 * @param message - The notification as ioBroker sends it
 */
async function forwarded(message: unknown): Promise<{ text: string; severity: string } | null> {
    let sent: { text: string; severity: string } | null = null;
    const adapter = { log: { debug: () => {}, warn: () => {} }, sendTo: () => {} };
    const handler = new MessagesHandler(
        adapter as never,
        (text, _direct, severity) => {
            sent = { text, severity };
            return Promise.resolve({ ok: true });
        },
        () => {},
        () => Promise.resolve({ ok: true }),
        () => Promise.resolve(null),
    );

    handler.onMessage({ command: 'sendNotification', message, from: 'system.adapter.admin.0' } as ioBroker.Message);
    await new Promise(resolve => setImmediate(resolve));
    return sent;
}

describe('messages', () => {
    describe('sendNotification', () => {
        it('puts the title of the category in front of a message that is only a date', async () => {
            const result = await forwarded({
                scope: { name: 'Abonnement-Warnung' },
                category: {
                    instances: { 'system.adapter.iot.0': { messages: [{ message: '11/1/2026, 11:59:59 PM' }] } },
                    description: 'Ihr IoT- oder Remote-Abonnement läuft bald ab.',
                    name: 'IoT- oder Remote-Abonnement läuft bald ab.',
                    severity: 'notify',
                },
            });

            expect(result).to.deep.equal({
                text: 'IoT- oder Remote-Abonnement läuft bald ab: 11/1/2026, 11:59:59 PM',
                severity: 'notify',
            });
        });

        it('puts the title in front of a message that is only a device name', async () => {
            const result = await forwarded({
                scope: { name: 'Shelly' },
                category: {
                    instances: {
                        'system.adapter.shelly.0': { messages: [{ message: 'Power Strip 4 Gen4 (shellypstripg4#1)' }] },
                    },
                    description: 'Neues Firmware-Update ist für deine Geräte verfügbar.',
                    name: 'Firmware-Update verfügbar',
                    severity: 'notify',
                },
            });

            expect(result?.text).to.equal('Firmware-Update verfügbar: Power Strip 4 Gen4 (shellypstripg4#1)');
        });

        it('takes the title of a category with a text per language from German, then English', async () => {
            const category = (name: unknown): unknown => ({
                category: { instances: { 'system.adapter.x.0': { messages: [{ message: 'Wert' }] } }, name },
            });

            expect((await forwarded(category({ en: 'Warning', de: 'Warnung' })))?.text).to.equal('Warnung: Wert');
            expect((await forwarded(category({ en: 'Warning' })))?.text).to.equal('Warning: Wert');
        });

        it('does not double the text of a message that already says what it is about', async () => {
            const result = await forwarded({
                category: {
                    instances: {
                        'system.adapter.admin.0': {
                            messages: [{ message: 'Adapter admin kann von 8.2.0 auf 8.3.5 aktualisiert werden.' }],
                        },
                    },
                    name: 'Adapter admin kann von 8.2.0 auf 8.3.5 aktualisiert werden.',
                },
            });

            expect(result?.text).to.equal('Adapter admin kann von 8.2.0 auf 8.3.5 aktualisiert werden.');
        });

        it('forwards the messages alone if the category has no title, and joins several of them', async () => {
            const result = await forwarded({
                category: {
                    instances: {
                        'system.adapter.a.0': {
                            messages: [{ message: 'Eins' }, { message: 'Zwei' }, { message: 'Eins' }],
                        },
                    },
                },
            });

            expect(result?.text).to.equal('Eins. Zwei');
        });

        it('still falls back to the description and the title of a notification without messages', async () => {
            expect((await forwarded({ category: { description: 'Beschreibung', name: 'Titel' } }))?.text).to.equal(
                'Beschreibung',
            );
            expect((await forwarded({ category: { name: 'Titel' } }))?.text).to.equal('Titel');
            expect(await forwarded({ category: {} })).to.equal(null);
        });
    });
});
