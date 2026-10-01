/**
 * Bridge between the adapter's hannah.v2 messages and the AgentConnect stream of a Hannah
 * Core that only speaks hannah.v1 (the N−1 path of the versioned client).
 *
 * The adapter works with hannah.v2 messages everywhere. Only the device sync differs between
 * the generations (typed devices vs. the per-state snapshot), and that part is not bridged:
 * on a hannah.v1 stream the StateWatcher sends the legacy v1 snapshot itself. Everything else
 * has the same field numbers in both generations, so it is transcoded through the two
 * generations' own serializers: a field the other side doesn't know is dropped, never guessed.
 */
import { v1, v2 } from '@m1kad0/hannah-proto';

/**
 * A command in hannah.v2 form. A command from a hannah.v1 Core additionally carries what v2
 * dropped from `AgentSetResident`: the legacy `presence_state`, which a Core older than
 * compat_version 2 sends instead of an `action`.
 */
export type BridgedCommand = v2.agent.AgentCommand & { legacyPresenceState?: number };

/**
 * hannah.v2 message → hannah.v1 stream. Typed device messages have no hannah.v1 counterpart
 * and come out without a payload: check `hasPayload`.
 *
 * @param msg - Message in hannah.v2 form
 */
export function messageToV1(msg: v2.agent.AgentMessage): v1.agent.AgentMessage {
    return v1.agent.AgentMessage.decode(v2.agent.AgentMessage.encode(msg).finish());
}

/**
 * hannah.v1 command from the stream → hannah.v2.
 *
 * @param cmd - Command in hannah.v1 form
 */
export function commandToV2(cmd: v1.agent.AgentCommand): BridgedCommand {
    const out: BridgedCommand = v2.agent.AgentCommand.decode(v1.agent.AgentCommand.encode(cmd).finish());
    if (cmd.setResident) {
        out.legacyPresenceState = cmd.setResident.presenceState;
    }
    return out;
}

/**
 * Whether a message carries something a hannah.v1 Core understands.
 *
 * @param msg - Message in hannah.v1 form
 */
export function hasPayload(msg: v1.agent.AgentMessage): boolean {
    return Object.entries(msg).some(([key, value]) => key !== 'ackId' && value !== undefined);
}
