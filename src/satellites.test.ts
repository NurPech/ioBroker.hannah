import type * as adapterCore from '@iobroker/adapter-core';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { utils } from '@iobroker/testing';
import { SatelliteWatcher } from './satellites';

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
