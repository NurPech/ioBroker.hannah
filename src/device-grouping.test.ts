import { expect } from 'chai';
import { groupIdFor, isInstanceLevel, parentId, planMerges, type MergeCandidate } from './device-grouping';

function candidate(groupId: string, kinds: number[], over: Partial<MergeCandidate> = {}): MergeCandidate {
    return { groupId, room: 'wohnzimmer', functions: ['Licht'], kinds: new Set(kinds), ...over };
}

describe('device-grouping', () => {
    describe('groupIdFor', () => {
        it('groups a state with the object it sits in', () => {
            expect(groupIdFor('hm-rpc.0.ABC123.1.LEVEL')).to.equal('hm-rpc.0.ABC123.1');
            expect(groupIdFor('alias.0.Licht.on')).to.equal('alias.0.Licht');
        });

        it('makes every state at root or instance level a device of its own', () => {
            expect(groupIdFor('alias.0.Lampe')).to.equal('alias.0.Lampe');
            expect(groupIdFor('0_userdata.0.Flag')).to.equal('0_userdata.0.Flag');
        });

        it('knows the parent and the instance level', () => {
            expect(parentId('a.0.b.c')).to.equal('a.0.b');
            expect(isInstanceLevel('alias.0')).to.equal(true);
            expect(isInstanceLevel('alias')).to.equal(true);
            expect(isInstanceLevel('alias.0.Licht')).to.equal(false);
        });
    });

    describe('planMerges', () => {
        it('merges sibling channels of one room and function that use different slots', () => {
            const merges = planMerges([candidate('dev.0.D.1', [1]), candidate('dev.0.D.2', [10])]);

            expect(merges).to.deep.equal([{ deviceId: 'dev.0.D', groupIds: ['dev.0.D.1', 'dev.0.D.2'] }]);
        });

        it('keeps the relays of a multi-relay plug apart, they use the same slots', () => {
            const merges = planMerges([
                candidate('shelly.0.plug.Relay0', [1, 10]),
                candidate('shelly.0.plug.Relay1', [1, 10]),
            ]);

            expect(merges).to.deep.equal([]);
        });

        it('merges nothing in a device where a third channel makes it unclear', () => {
            const merges = planMerges([
                candidate('shelly.0.plug.Relay0', [1, 10]),
                candidate('shelly.0.plug.Relay1', [1, 10]),
                candidate('shelly.0.plug.Meter', [11]),
            ]);

            expect(merges).to.deep.equal([]);
        });

        it('does not merge across rooms or functions, nor without a function', () => {
            expect(
                planMerges([candidate('d.0.D.1', [1]), candidate('d.0.D.2', [10], { room: 'kueche' })]),
            ).to.deep.equal([]);
            expect(
                planMerges([candidate('d.0.D.1', [1]), candidate('d.0.D.2', [10], { functions: ['Heizung'] })]),
            ).to.deep.equal([]);
            expect(
                planMerges([
                    candidate('d.0.D.1', [1], { functions: [] }),
                    candidate('d.0.D.2', [10], { functions: [] }),
                ]),
            ).to.deep.equal([]);
        });

        it('keeps devices that contain devices apart: a group that is itself a device does not absorb its channels', () => {
            const merges = planMerges([
                candidate('hue.0.Group', [1]),
                candidate('hue.0.Group.lamp1', [2]),
                candidate('hue.0.Group.lamp2', [3]),
            ]);

            expect(merges).to.deep.equal([]);
        });

        it('never merges at root or instance level', () => {
            expect(planMerges([candidate('alias.0.Lampe', [1]), candidate('alias.0.Temp', [20])])).to.deep.equal([]);
        });
    });
});
