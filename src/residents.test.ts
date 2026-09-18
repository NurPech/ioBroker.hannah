import type * as adapterCore from '@iobroker/adapter-core';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { utils } from '@iobroker/testing';
import { agent } from '@m1kad0/hannah-proto';
import { ResidentsWatcher } from './residents';

const { createMocks } = utils.unit;

describe('ResidentsWatcher', () => {
    const { adapter, database } = createMocks({ name: 'hannah' });
    const adapterInstance = adapter as unknown as adapterCore.AdapterInstance;

    afterEach(() => {
        adapter.resetMock();
        database.clear();
    });

    function makeWatcher(): ResidentsWatcher {
        return new ResidentsWatcher(adapterInstance, sinon.stub(), '0');
    }

    /**
     * hannah-proto#7 — an action (AWAY/HOME/ASLEEP/AWAKE) writes only the single
     * presence.{away,home,night} flag it names, letting the residents adapter's own
     * cross-consistency guard handle the rest, instead of the combined presence.state
     * write that could clobber an unrelated flag (root cause of gessinger/voice/hannah#299).
     */
    describe('handleSetResident with an action', () => {
        it('AWAY writes presence.away=true and leaves presence.state untouched', async () => {
            const watcher = makeWatcher();

            await watcher.handleSetResident('leonie', 0, agent.ResidentType.ROOMIE, agent.ResidentPresenceAction.AWAY);

            expect(database.getState('residents.0.roomie.leonie.presence.away')).to.include({ val: true, ack: false });
            expect(database.hasState('residents.0.roomie.leonie.presence.state')).to.equal(false);
        });

        it('HOME writes presence.home=true', async () => {
            const watcher = makeWatcher();

            await watcher.handleSetResident('leonie', 1, agent.ResidentType.ROOMIE, agent.ResidentPresenceAction.HOME);

            expect(database.getState('residents.0.roomie.leonie.presence.home')).to.include({ val: true, ack: false });
        });

        it('ASLEEP writes presence.night=true', async () => {
            const watcher = makeWatcher();

            await watcher.handleSetResident(
                'leonie',
                2,
                agent.ResidentType.ROOMIE,
                agent.ResidentPresenceAction.ASLEEP,
            );

            expect(database.getState('residents.0.roomie.leonie.presence.night')).to.include({ val: true, ack: false });
        });

        it('AWAKE writes presence.night=false, independent of the passed-through legacy presenceState', async () => {
            const watcher = makeWatcher();

            await watcher.handleSetResident('leonie', 1, agent.ResidentType.ROOMIE, agent.ResidentPresenceAction.AWAKE);

            expect(database.getState('residents.0.roomie.leonie.presence.night')).to.include({
                val: false,
                ack: false,
            });
        });

        it('respects the resident type path segment (guest)', async () => {
            const watcher = makeWatcher();

            await watcher.handleSetResident('someone', 0, agent.ResidentType.GUEST, agent.ResidentPresenceAction.HOME);

            expect(database.getState('residents.0.guest.someone.presence.home')).to.include({ val: true, ack: false });
        });
    });

    describe('handleSetResident without an action (legacy Core, compat_version < 2)', () => {
        it('falls back to writing the combined presence.state', async () => {
            const watcher = makeWatcher();

            await watcher.handleSetResident('leonie', 2, agent.ResidentType.ROOMIE);

            expect(database.getState('residents.0.roomie.leonie.presence.state')).to.include({ val: 2, ack: false });
            expect(database.hasState('residents.0.roomie.leonie.presence.away')).to.equal(false);
        });

        it('also falls back when action is explicitly RESIDENT_PRESENCE_ACTION_UNSPECIFIED', async () => {
            const watcher = makeWatcher();

            await watcher.handleSetResident(
                'leonie',
                0,
                agent.ResidentType.ROOMIE,
                agent.ResidentPresenceAction.RESIDENT_PRESENCE_ACTION_UNSPECIFIED,
            );

            expect(database.getState('residents.0.roomie.leonie.presence.state')).to.include({ val: 0, ack: false });
        });
    });
});
