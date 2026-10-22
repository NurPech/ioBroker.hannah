import type * as adapterCore from '@iobroker/adapter-core';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { utils } from '@iobroker/testing';
import type { AckResult } from './grpc-client';
import { ledBrightnessSupported, SatelliteWatcher } from './satellites';

const { createMocks } = utils.unit;

describe('SatelliteWatcher', () => {
    const { adapter, database } = createMocks({ name: 'hannah' });
    const adapterInstance = adapter as unknown as adapterCore.AdapterInstance;

    afterEach(() => {
        adapter.resetMock();
        database.clear();
    });

    type PatchedAdapter = {
        getForeignStatesAsync: sinon.SinonStub;
        delObjectAsync: sinon.SinonStub;
        delObject: (id: string, ...args: unknown[]) => void;
    };

    function makeWatcher(getGrpc: () => unknown = () => null): SatelliteWatcher {
        // Neither is in this mock library's auto-promisified method list — only used
        // for anyOnline aggregation / subtree cleanup, irrelevant to the room-path
        // behavior under test here, so a thin manual wrapper is enough.
        const patched = adapter as unknown as PatchedAdapter;
        patched.getForeignStatesAsync = sinon.stub().resolves({});
        patched.delObjectAsync = sinon.stub().callsFake(
            (id: string, opts?: unknown) =>
                new Promise<void>(resolve => {
                    patched.delObject(id, opts, () => resolve());
                }),
        );
        return new SatelliteWatcher(adapterInstance, sinon.stub(), getGrpc as () => never);
    }

    async function exists(id: string): Promise<boolean> {
        return !!(await adapter.getObjectAsync(id));
    }

    /**
     * Regression test for GitHub ioBroker.hannah#96: a room string that changes
     * case/format between calls for the same satellite (e.g. "Leonie Schlafzimmer"
     * vs "leonie_schlafzimmer") must not fork into two separate object trees.
     */
    it('does not create a duplicate room tree when the room string only differs by case/format', async () => {
        const watcher = makeWatcher();

        await watcher.handleSatelliteUpdate('e072a1d01adc', 'leonie_schlafzimmer', '10.0.0.5:5005', true);
        expect(await exists('hannah.0.satellites.rooms.leonie_schlafzimmer.e072a1d01adc')).to.equal(true);

        // Same logical room, different raw representation (space instead of underscore,
        // different case) — must resolve to the exact same path, not a second tree.
        await watcher.handleSatelliteUpdate('e072a1d01adc', 'Leonie Schlafzimmer', '10.0.0.5:5005', true);

        expect(await exists('hannah.0.satellites.rooms.Leonie_Schlafzimmer.e072a1d01adc')).to.equal(false);
        expect(await exists('hannah.0.satellites.rooms.leonie_schlafzimmer.e072a1d01adc')).to.equal(true);
    });

    it('still cleans up the old room tree on a genuine room move', async () => {
        const watcher = makeWatcher();

        await watcher.handleSatelliteUpdate('e072a1d01adc', 'kueche', '10.0.0.5:5005', true);
        await watcher.handleSatelliteUpdate('e072a1d01adc', 'wohnzimmer', '10.0.0.5:5005', true);

        expect(await exists('hannah.0.satellites.rooms.kueche.e072a1d01adc')).to.equal(false);
        expect(await exists('hannah.0.satellites.rooms.wohnzimmer.e072a1d01adc')).to.equal(true);
    });

    it('cleans up the previous room tree when an offline event reports a differently-formatted room', async () => {
        const watcher = makeWatcher();

        await watcher.handleSatelliteUpdate('e072a1d01adc', 'leonie_schlafzimmer', '10.0.0.5:5005', true);
        // Disconnect fallback path uses a display-name-style room string instead of the
        // live technical one — same logical room, must not leave the old tree orphaned.
        await watcher.handleSatelliteUpdate('e072a1d01adc', 'Leonie Schlafzimmer', '', false);

        expect(await exists('hannah.0.satellites.rooms.leonie_schlafzimmer.e072a1d01adc')).to.equal(true);
    });

    it('triggers a satellite restart and resets the button state on restart=true', async () => {
        const triggerSatelliteRestart = sinon.stub().resolves({ ok: true });
        const watcher = makeWatcher(() => ({ triggerSatelliteRestart }));

        await watcher.handleSatelliteUpdate('e072a1d01adc', 'kueche', '10.0.0.5:5005', true);
        const id = 'hannah.0.satellites.rooms.kueche.e072a1d01adc.restart';
        await adapter.setStateAsync(id, { val: true, ack: false });
        const handled = watcher.onStateChange(id, { val: true, ack: false } as ioBroker.State);
        // onStateChange dispatches the actual gRPC call fire-and-forget; flush microtasks.
        await new Promise(resolve => setImmediate(resolve));

        expect(handled).to.equal(true);
        expect(triggerSatelliteRestart.calledOnceWith('e072a1d01adc')).to.equal(true);
        const state = await adapter.getStateAsync(id);
        expect(state?.val).to.equal(false);
        expect(state?.ack).to.equal(true);
    });

    // hannah#56/#156: functions live primarily on the satellite now.

    it('creates announcement/announcementSsml/announcementRephrase/dnd/speaking/lastTranscript per satellite, not just at room level', async () => {
        const watcher = makeWatcher();

        await watcher.handleSatelliteUpdate('e072a1d01adc', 'kueche', '10.0.0.5:5005', true);

        for (const key of [
            'announcement',
            'announcementSsml',
            'announcementRephrase',
            'dnd',
            'speaking',
            'lastTranscript',
        ]) {
            expect(await exists(`hannah.0.satellites.rooms.kueche.e072a1d01adc.${key}`)).to.equal(
                true,
                `per-satellite ${key} should exist`,
            );
        }
    });

    it('confirms a reported dnd state with ack:true, mirroring mute (hannah#213)', async () => {
        const watcher = makeWatcher();

        await watcher.handleSatelliteUpdate(
            'e072a1d01adc',
            'kueche',
            '10.0.0.5:5005',
            true,
            undefined,
            undefined,
            true,
        );

        const state = await adapter.getStateAsync('hannah.0.satellites.rooms.kueche.e072a1d01adc.dnd');
        expect(state?.val).to.equal(true);
        expect(state?.ack).to.equal(true);
    });

    it('no longer creates speaking/lastTranscript at room level (moved to per-satellite only)', async () => {
        const watcher = makeWatcher();

        await watcher.handleSatelliteUpdate('e072a1d01adc', 'kueche', '10.0.0.5:5005', true);

        expect(await exists('hannah.0.satellites.rooms.kueche.speaking')).to.equal(false);
        expect(await exists('hannah.0.satellites.rooms.kueche.lastTranscript')).to.equal(false);
    });

    it('still creates announcement/announcementSsml/announcementRephrase/dnd/mute at room level (broadcast convenience)', async () => {
        const watcher = makeWatcher();

        await watcher.handleSatelliteUpdate('e072a1d01adc', 'kueche', '10.0.0.5:5005', true);

        for (const key of ['announcement', 'announcementSsml', 'announcementRephrase', 'dnd', 'mute']) {
            expect(await exists(`hannah.0.satellites.rooms.kueche.${key}`)).to.equal(
                true,
                `room-level ${key} should still exist`,
            );
        }
    });

    it('forwards a per-satellite dnd write with the satellite device_id, resetting is not applicable', async () => {
        const send = sinon.stub();
        const watcher = new SatelliteWatcher(adapterInstance, send, () => null);
        (adapter as unknown as PatchedAdapter).getForeignStatesAsync = sinon.stub().resolves({});

        await watcher.handleSatelliteUpdate('e072a1d01adc', 'kueche', '10.0.0.5:5005', true);
        const id = 'hannah.0.satellites.rooms.kueche.e072a1d01adc.dnd';
        const handled = watcher.onStateChange(id, { val: true, ack: false } as ioBroker.State);

        expect(handled).to.equal(true);
        expect(
            send.calledOnceWith({
                satelliteControl: { room: 'kueche', deviceId: 'e072a1d01adc', dnd: true },
            }),
        ).to.equal(true);
    });

    it('forwards a per-satellite announcement write with the device_id and resets the state to empty', async () => {
        const send = sinon.stub();
        const watcher = new SatelliteWatcher(adapterInstance, send, () => null);
        (adapter as unknown as PatchedAdapter).getForeignStatesAsync = sinon.stub().resolves({});

        await watcher.handleSatelliteUpdate('e072a1d01adc', 'kueche', '10.0.0.5:5005', true);
        const id = 'hannah.0.satellites.rooms.kueche.e072a1d01adc.announcement';
        const handled = watcher.onStateChange(id, { val: 'Hallo', ack: false } as ioBroker.State);
        await new Promise(resolve => setImmediate(resolve));

        expect(handled).to.equal(true);
        expect(
            send.calledOnceWith({
                satelliteControl: { room: 'kueche', deviceId: 'e072a1d01adc', announcement: 'Hallo' },
            }),
        ).to.equal(true);
        const state = await adapter.getStateAsync(id);
        expect(state?.val).to.equal('');
        expect(state?.ack).to.equal(true);
    });

    it('fans out a room-level dnd write to every satellite currently in that room', async () => {
        const send = sinon.stub();
        const watcher = new SatelliteWatcher(adapterInstance, send, () => null);
        (adapter as unknown as PatchedAdapter).getForeignStatesAsync = sinon.stub().resolves({});

        await watcher.handleSatelliteUpdate('e072a1d01adc', 'kueche', '10.0.0.5:5005', true);
        await watcher.handleSatelliteUpdate('e072a1d01ad0', 'kueche', '10.0.0.6:5005', true);
        const id = 'hannah.0.satellites.rooms.kueche.dnd';
        const handled = watcher.onStateChange(id, { val: true, ack: false } as ioBroker.State);

        expect(handled).to.equal(true);
        expect(send.callCount).to.equal(2);
        expect(send.calledWith({ satelliteControl: { room: 'kueche', deviceId: 'e072a1d01adc', dnd: true } })).to.equal(
            true,
        );
        expect(send.calledWith({ satelliteControl: { room: 'kueche', deviceId: 'e072a1d01ad0', dnd: true } })).to.equal(
            true,
        );
    });

    describe('led_brightness', () => {
        const ledId = 'hannah.0.satellites.rooms.kueche.e072a1d01adc.led_brightness';

        async function onlineWatcher(
            sendWithAck?: sinon.SinonStub,
        ): Promise<{ watcher: SatelliteWatcher; send: sinon.SinonStub }> {
            const send = sinon.stub();
            const watcher = new SatelliteWatcher(adapterInstance, send, () => null, sendWithAck);
            (adapter as unknown as PatchedAdapter).getForeignStatesAsync = sinon.stub().resolves({});
            await watcher.handleSatelliteUpdate('e072a1d01adc', 'kueche', '10.0.0.5:5005', true);
            return { watcher, send };
        }

        const unknown = (field: number): AckResult => ({
            kind: 'ack',
            ack: {
                ackId: 1n,
                unknownFields: [{ messageType: 'hannah.v2.AgentSatelliteControl', fieldNumbers: [field] }],
            },
        });

        it('creates a writable 0–100 dimmer state per satellite, default 100', async () => {
            await onlineWatcher();

            const obj = await adapter.getObjectAsync(ledId);
            expect(obj?.common).to.include({
                type: 'number',
                role: 'level.dimmer',
                unit: '%',
                min: 0,
                max: 100,
                def: 100,
            });
            expect(obj?.common.write).to.equal(true);
        });

        it('shows the value reported by Core as a confirmed state, 0 included', async () => {
            const { watcher } = await onlineWatcher();

            await watcher.handleSatelliteUpdate(
                'e072a1d01adc',
                'kueche',
                '',
                true,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                30,
            );
            expect((await adapter.getStateAsync(ledId))?.val).to.equal(30);

            await watcher.handleSatelliteUpdate(
                'e072a1d01adc',
                'kueche',
                '',
                true,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                0,
            );
            const state = await adapter.getStateAsync(ledId);
            expect(state?.val).to.equal(0);
            expect(state?.ack).to.equal(true);
        });

        it('leaves the state alone when Core reports no value', async () => {
            const { watcher } = await onlineWatcher();
            await adapter.setStateAsync(ledId, { val: 40, ack: true });

            await watcher.handleSatelliteUpdate('e072a1d01adc', 'kueche', '', true, 80);

            expect((await adapter.getStateAsync(ledId))?.val).to.equal(40);
        });

        it('forwards a write with the satellite device_id', async () => {
            const { watcher, send } = await onlineWatcher();

            const handled = watcher.onStateChange(ledId, { val: 25, ack: false } as ioBroker.State);
            await new Promise(resolve => setImmediate(resolve));

            expect(handled).to.equal(true);
            expect(
                send.calledOnceWith({
                    satelliteControl: { room: 'kueche', deviceId: 'e072a1d01adc', ledBrightness: 25 },
                }),
            ).to.equal(true);
        });

        it('forwards 0 (ring off) and clamps a value beyond the range', async () => {
            const { watcher, send } = await onlineWatcher();

            watcher.onStateChange(ledId, { val: 0, ack: false } as ioBroker.State);
            watcher.onStateChange(ledId, { val: 150, ack: false } as ioBroker.State);
            watcher.onStateChange(ledId, { val: -5, ack: false } as ioBroker.State);
            await new Promise(resolve => setImmediate(resolve));

            expect(send.args.map(a => a[0].satelliteControl.ledBrightness)).to.deep.equal([0, 100, 0]);
        });

        it('does not forward a value that is not a number', async () => {
            const { watcher, send } = await onlineWatcher();

            watcher.onStateChange(ledId, { val: 'hell', ack: false } as ioBroker.State);
            await new Promise(resolve => setImmediate(resolve));

            expect(send.called).to.equal(false);
        });

        it('does not forward a confirmed (ack) state', async () => {
            const { watcher, send } = await onlineWatcher();

            watcher.onStateChange(ledId, { val: 25, ack: true } as ioBroker.State);

            expect(send.called).to.equal(false);
        });

        it('is not part of the room-level broadcast', async () => {
            const { watcher, send } = await onlineWatcher();

            const handled = watcher.onStateChange('hannah.0.satellites.rooms.kueche.led_brightness', {
                val: 25,
                ack: false,
            } as ioBroker.State);

            expect(handled).to.equal(false);
            expect(send.called).to.equal(false);
        });

        it('asks for the ack on the first write only, once Core is known to support the field', async () => {
            const sendWithAck = sinon.stub().resolves({ kind: 'ack', ack: { ackId: 1n, unknownFields: [] } });
            const { watcher, send } = await onlineWatcher(sendWithAck);

            watcher.onStateChange(ledId, { val: 25, ack: false } as ioBroker.State);
            await new Promise(resolve => setImmediate(resolve));
            watcher.onStateChange(ledId, { val: 50, ack: false } as ioBroker.State);
            await new Promise(resolve => setImmediate(resolve));

            expect(sendWithAck.callCount).to.equal(1);
            expect(send.callCount).to.equal(1);
            expect(send.firstCall.args[0].satelliteControl.ledBrightness).to.equal(50);
        });

        it('logs once and stops sending when Core does not know the field', async () => {
            const sendWithAck = sinon.stub().resolves(unknown(10));
            const { watcher, send } = await onlineWatcher(sendWithAck);
            const warn = adapter.log.warn as unknown as sinon.SinonStub;

            watcher.onStateChange(ledId, { val: 25, ack: false } as ioBroker.State);
            await new Promise(resolve => setImmediate(resolve));
            watcher.onStateChange(ledId, { val: 50, ack: false } as ioBroker.State);
            watcher.onStateChange(ledId, { val: 75, ack: false } as ioBroker.State);
            await new Promise(resolve => setImmediate(resolve));

            expect(sendWithAck.callCount).to.equal(1);
            expect(send.called).to.equal(false);
            expect(warn.calledWithMatch('LED brightness')).to.equal(true);
            expect(warn.callCount).to.equal(1);
        });

        it('asks again after a reconnect, a different Core may be there', async () => {
            const sendWithAck = sinon.stub().resolves(unknown(10));
            const { watcher } = await onlineWatcher(sendWithAck);

            watcher.onStateChange(ledId, { val: 25, ack: false } as ioBroker.State);
            await new Promise(resolve => setImmediate(resolve));
            watcher.resetCoreSupport();
            watcher.onStateChange(ledId, { val: 50, ack: false } as ioBroker.State);
            await new Promise(resolve => setImmediate(resolve));

            expect(sendWithAck.callCount).to.equal(2);
        });
    });

    describe('ledBrightnessSupported', () => {
        it('is true when the ack does not list the field', () => {
            expect(ledBrightnessSupported({ kind: 'ack', ack: { ackId: 1n, unknownFields: [] } })).to.equal(true);
        });

        it('is true when the ack lists other unknown fields', () => {
            const result: AckResult = {
                kind: 'ack',
                ack: {
                    ackId: 1n,
                    unknownFields: [{ messageType: 'hannah.v2.AgentSatelliteControl', fieldNumbers: [11] }],
                },
            };
            expect(ledBrightnessSupported(result)).to.equal(true);
        });

        it('is false when Core lists the field as unknown, in either generation', () => {
            for (const messageType of ['hannah.v1.AgentSatelliteControl', 'hannah.v2.AgentSatelliteControl']) {
                const result: AckResult = {
                    kind: 'ack',
                    ack: { ackId: 1n, unknownFields: [{ messageType, fieldNumbers: [10] }] },
                };
                expect(ledBrightnessSupported(result)).to.equal(false);
            }
        });

        it('is false when Core never answers, it is too old to send an ack', () => {
            expect(ledBrightnessSupported({ kind: 'timeout' })).to.equal(false);
        });

        it('has no verdict while disconnected', () => {
            expect(ledBrightnessSupported({ kind: 'disconnected' })).to.equal(null);
        });
    });

    it('does not forward a room-level broadcast to a satellite in a different room', async () => {
        const send = sinon.stub();
        const watcher = new SatelliteWatcher(adapterInstance, send, () => null);
        (adapter as unknown as PatchedAdapter).getForeignStatesAsync = sinon.stub().resolves({});

        await watcher.handleSatelliteUpdate('e072a1d01adc', 'kueche', '10.0.0.5:5005', true);
        await watcher.handleSatelliteUpdate('e072a1d01ad0', 'wohnzimmer', '10.0.0.6:5005', true);
        const id = 'hannah.0.satellites.rooms.kueche.dnd';
        watcher.onStateChange(id, { val: true, ack: false } as ioBroker.State);

        expect(send.callCount).to.equal(1);
        expect(send.calledWith({ satelliteControl: { room: 'kueche', deviceId: 'e072a1d01adc', dnd: true } })).to.equal(
            true,
        );
    });
});
