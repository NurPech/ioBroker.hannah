import * as grpc from '@grpc/grpc-js';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { v1, v2 } from '@m1kad0/hannah-proto';
import { GrpcClient } from './grpc-client';
import type { Generation } from './grpc-client';

/**
 * The stream to a real gRPC server of each generation: the version probe, the generation of
 * the AgentConnect stream, what goes over the wire in each direction.
 */
describe('GrpcClient against a Hannah Core', () => {
    interface FakeCore {
        port: number;
        received: any[];
        /** whether the adapter's AgentConnect stream is open */
        connected: () => boolean;
        /** a command to the adapter, in the message form of this Core's generation */
        send: (command: object) => void;
        close: () => void;
    }

    async function startCore(generation: Generation): Promise<FakeCore> {
        const server = new grpc.Server();
        const received: any[] = [];
        let stream: grpc.ServerDuplexStream<any, any> | undefined;
        const Command: { fromPartial: (o: any) => any } =
            generation === 'v2' ? v2.agent.AgentCommand : v1.agent.AgentCommand;
        const implementation = {
            getSatellites: (_call: unknown, cb: (err: null, res: { satellites: unknown[] }) => void) =>
                cb(null, { satellites: [] }),
            agentConnect: (call: grpc.ServerDuplexStream<any, any>) => {
                stream = call;
                call.on('data', (msg: any) => {
                    received.push(msg);
                    if (msg.ackId !== undefined) {
                        call.write(Command.fromPartial({ ack: { ackId: msg.ackId, unknownFields: [] } }));
                    }
                });
                call.on('end', () => call.end());
            },
        };
        const definition = generation === 'v2' ? v2.hannah.HannahServiceService : v1.hannah.HannahServiceService;
        // only the generation this Core speaks: the other one answers UNIMPLEMENTED
        server.addService(definition, implementation);
        const port = await new Promise<number>((resolve, reject) =>
            server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, bound) =>
                err ? reject(err) : resolve(bound),
            ),
        );
        return {
            port,
            received,
            connected: () => stream !== undefined,
            send: command => stream?.write(Command.fromPartial(command)),
            close: () => server.forceShutdown(),
        };
    }

    async function until(condition: () => boolean, what: string): Promise<void> {
        for (let i = 0; i < 200; i++) {
            if (condition()) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error(`timeout waiting for ${what}`);
    }

    let cores: FakeCore[] = [];
    let clients: GrpcClient[] = [];

    afterEach(() => {
        clients.forEach(c => c.disconnect());
        cores.forEach(c => c.close());
        clients = [];
        cores = [];
    });

    async function connect(
        generation: Generation,
    ): Promise<{ core: FakeCore; client: GrpcClient; commands: any[]; generation: () => Generation | undefined }> {
        const core = await startCore(generation);
        cores.push(core);
        const commands: any[] = [];
        let seen: Generation | undefined;
        const client = new GrpcClient({
            onCommand: cmd => commands.push(cmd),
            // like the adapter's: onConnected returns a Promise
            onConnected: g => {
                seen = g;
                return Promise.resolve();
            },
            onDisconnected: sinon.stub(),
            log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() },
            setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
            clearTimeout: t => clearTimeout(t),
        });
        clients.push(client);
        client.connect('127.0.0.1', core.port);
        await until(() => seen !== undefined, 'the connection');
        return { core, client, commands, generation: () => seen };
    }

    describe('hannah.v2', () => {
        it('uses the v2 stream and sends typed devices, which Core acks', async () => {
            const { core, client, generation } = await connect('v2');
            expect(generation()).to.equal('v2');
            expect(client.generation).to.equal('v2');

            const result = await client.sendWithAck({
                typedSnapshot: {
                    devices: [
                        {
                            deviceId: 'dev',
                            name: 'Lampe',
                            room: 'wohnzimmer',
                            floor: '',
                            deviceClass: v2.device_model.DeviceClass.DEVICE_CLASS_LIGHT,
                            slots: [
                                {
                                    slotId: 'on',
                                    kind: v2.device_model.SlotKind.SLOT_KIND_ON,
                                    value: { boolean: true },
                                    writable: true,
                                    unit: '',
                                    label: '',
                                    requiredTrustLevel: 6,
                                    options: [],
                                    identifier: 'hannah.0.dev.on',
                                },
                            ],
                            available: true,
                            subtype: v2.device_model.DeviceSubtype.DEVICE_SUBTYPE_UNSPECIFIED,
                        },
                    ],
                },
            });

            expect(result.kind).to.equal('ack');
            const slot = core.received[0].typedSnapshot.devices[0].slots[0];
            expect(slot).to.deep.include({ slotId: 'on', requiredTrustLevel: 6, identifier: 'hannah.0.dev.on' });
            expect(slot.value).to.deep.include({ boolean: true });
        });

        it('sends a start value marked initial', async () => {
            const { core, client } = await connect('v2');
            await until(() => core.connected(), 'the stream');

            client.send({
                stateUpdate: { stateId: 'hannah.0.flag', value: 'true', ack: true, ts: 5n, initial: true },
            });

            await until(() => core.received.length > 0, 'the update');
            expect(core.received[0].stateUpdate).to.deep.include({ stateId: 'hannah.0.flag', initial: true });
        });

        it('receives a SetSlot command', async () => {
            const { core, commands } = await connect('v2');
            await until(() => core.connected(), 'the stream');

            core.send({ setSlot: { deviceId: 'dev', slotId: 'brightness', value: { number: 40 } } });
            await until(() => commands.length > 0, 'the command');

            expect(commands[0].setSlot).to.deep.include({ deviceId: 'dev', slotId: 'brightness' });
            expect(commands[0].setSlot.value.number).to.equal(40);
        });

        it('calls Core with hannah.v2 messages', async () => {
            const { client } = await connect('v2');

            expect(await client.getSatellites()).to.deep.equal([]);
        });
    });

    describe('hannah.v1 (Core too old for hannah.v2)', () => {
        it('uses the v1 stream and the legacy device sync, and still reaches Core with hannah.v2 calls', async () => {
            const { core, client, generation } = await connect('v1');
            expect(generation()).to.equal('v1');
            expect(client.generation).to.equal('v1');

            // a hannah.v2 call, translated by the library
            expect(await client.getSatellites()).to.deep.equal([]);

            const result = await client.sendLegacyWithAck({ sendSnapshot: { devices: [] } });
            expect(result.kind).to.equal('ack');
            expect(core.received[0]).to.have.property('sendSnapshot');
        });

        it('bridges messages to hannah.v1 and sends no typed devices', async () => {
            const { core, client } = await connect('v1');

            client.send({ typedSnapshot: { devices: [] } });
            client.send({ residentUpdate: { roomieId: 'felix', type: v2.agent.ResidentType.PET } });
            await until(() => core.received.length > 0, 'the resident update');

            expect(core.received).to.have.length(1);
            expect(core.received[0].residentUpdate).to.deep.include({ roomieId: 'felix' });
            expect(core.received[0].residentUpdate.type).to.equal(v1.agent.ResidentType.PET);
        });

        it('hands a legacy presence_state over next to the action', async () => {
            const { core, commands } = await connect('v1');
            await until(() => core.connected(), 'the stream');

            core.send({ setResident: { residentId: 'leonie', presenceState: 2, type: 1 } });
            await until(() => commands.length > 0, 'the command');

            expect(commands[0].setResident.residentId).to.equal('leonie');
            expect(commands[0].legacyPresenceState).to.equal(2);
        });
    });
});
