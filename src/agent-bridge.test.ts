import { expect } from 'chai';
import { v1, v2 } from '@m1kad0/hannah-proto';
import { commandToV2, hasPayload, messageToV1 } from './agent-bridge';

describe('agent-bridge', () => {
    describe('messageToV1', () => {
        it('carries a resident update over with its enum', () => {
            const msg = v2.agent.AgentMessage.fromPartial({
                residentUpdate: { roomieId: 'felix', type: v2.agent.ResidentType.PET, presenceState: 1 },
            });

            const out = messageToV1(msg);

            expect(out.residentUpdate?.roomieId).to.equal('felix');
            expect(out.residentUpdate?.type).to.equal(v1.agent.ResidentType.PET);
            expect(out.residentUpdate?.presenceState).to.equal(1);
        });

        it('carries satellite control, text commands and the room catalog over', () => {
            const control = messageToV1(
                v2.agent.AgentMessage.fromPartial({ satelliteControl: { room: 'kueche', announcement: 'Hallo' } }),
            );
            const text = messageToV1(v2.agent.AgentMessage.fromPartial({ textCommand: { text: 'Licht an' } }));
            const rooms = messageToV1(
                v2.agent.AgentMessage.fromPartial({
                    sendRooms: { rooms: [{ roomId: 'kueche', displayNames: { de: 'Küche' } }] },
                }),
            );

            expect(control.satelliteControl).to.include({ room: 'kueche', announcement: 'Hallo' });
            expect(text.textCommand?.text).to.equal('Licht an');
            expect(rooms.sendRooms?.rooms[0]).to.deep.include({ roomId: 'kueche', displayNames: { de: 'Küche' } });
        });

        it('keeps the ack_id', () => {
            const out = messageToV1(v2.agent.AgentMessage.fromPartial({ textCommand: { text: 'x' }, ackId: 7n }));

            expect(out.ackId).to.equal(7n);
        });

        it('drops typed device messages, which have no hannah.v1 counterpart', () => {
            const snapshot = messageToV1(v2.agent.AgentMessage.fromPartial({ typedSnapshot: { devices: [] } }));
            const update = messageToV1(
                v2.agent.AgentMessage.fromPartial({ slotUpdate: { deviceId: 'a', slotId: 'on', ts: 1n } }),
            );

            expect(hasPayload(snapshot)).to.equal(false);
            expect(hasPayload(update)).to.equal(false);
        });

        it('reports a message with a payload as having one', () => {
            const out = messageToV1(v2.agent.AgentMessage.fromPartial({ textCommand: { text: 'x' } }));

            expect(hasPayload(out)).to.equal(true);
        });
    });

    describe('commandToV2', () => {
        it('carries a satellite update over', () => {
            const cmd = v1.agent.AgentCommand.fromPartial({
                satelliteUpdate: { deviceId: 'aa:bb', room: 'kueche', online: true, volume: 40 },
            });

            const out = commandToV2(cmd);

            expect(out.satelliteUpdate).to.include({ deviceId: 'aa:bb', room: 'kueche', online: true, volume: 40 });
        });

        it('carries set_state and watch_more over', () => {
            const setState = commandToV2(
                v1.agent.AgentCommand.fromPartial({ setState: { stateId: 'a.b', value: '1' } }),
            );
            const watch = commandToV2(v1.agent.AgentCommand.fromPartial({ watchMore: { stateIds: ['a.b', 'c.d'] } }));

            expect(setState.setState).to.include({ stateId: 'a.b', value: '1' });
            expect(watch.watchMore?.stateIds).to.deep.equal(['a.b', 'c.d']);
        });

        it('carries an ack with its unknown fields over', () => {
            const cmd = v1.agent.AgentCommand.fromPartial({
                ack: { ackId: 3n, unknownFields: [{ messageType: 'hannah.v1.AgentDevice', fieldNumbers: [15] }] },
            });

            const out = commandToV2(cmd);

            expect(out.ack?.ackId).to.equal(3n);
            expect(out.ack?.unknownFields[0]).to.deep.include({
                messageType: 'hannah.v1.AgentDevice',
                fieldNumbers: [15],
            });
        });

        it('keeps the action of a set_resident and hands the legacy presence_state on next to it', () => {
            const cmd = v1.agent.AgentCommand.fromPartial({
                setResident: {
                    residentId: 'leonie',
                    presenceState: 1,
                    type: v1.agent.ResidentType.ROOMIE,
                    action: v1.agent.ResidentPresenceAction.ASLEEP,
                },
            });

            const out = commandToV2(cmd);

            expect(out.setResident?.action).to.equal(v2.agent.ResidentPresenceAction.ASLEEP);
            expect(out.legacyPresenceState).to.equal(1);
        });

        it('does not invent an action for a Core that only sends the legacy presence_state', () => {
            const out = commandToV2(
                v1.agent.AgentCommand.fromPartial({
                    setResident: { residentId: 'leonie', presenceState: 2, type: v1.agent.ResidentType.ROOMIE },
                }),
            );

            expect(out.setResident?.action).to.equal(
                v2.agent.ResidentPresenceAction.RESIDENT_PRESENCE_ACTION_UNSPECIFIED,
            );
            expect(out.legacyPresenceState).to.equal(2);
        });

        it('has no legacy presence_state on other commands', () => {
            const out = commandToV2(v1.agent.AgentCommand.fromPartial({ setState: { stateId: 'a', value: '1' } }));

            expect(out.legacyPresenceState).to.equal(undefined);
        });
    });
});
