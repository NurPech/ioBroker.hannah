import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'chai';

describe('README', () => {
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    const dialog = JSON.parse(readFileSync(join(__dirname, '..', 'admin', 'jsonCustom.json'), 'utf8')) as {
        items: Record<string, { options?: string[] }>;
    };

    it('documents every field of the custom settings dialog', () => {
        for (const key of Object.keys(dialog.items)) {
            expect(readme, key).to.contain(`\`${key}\``);
        }
    });

    it('names every value the dialog offers for category, canonical key and slot', () => {
        for (const field of ['type', 'canonicalKey', 'slot']) {
            for (const option of dialog.items[field].options ?? []) {
                expect(readme, `${field}: ${option}`).to.contain(`\`${option}\``);
            }
        }
    });
});
