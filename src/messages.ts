import type * as utils from '@iobroker/adapter-core';
import type { AgentMessageSender } from './grpc-client';

interface NotificationMessage {
    category?: {
        severity?: string;
        description?: string | { de?: string; en?: string };
        name?: string | { de?: string; en?: string };
        instances?: Record<string, { messages?: Array<{ message?: string }> }>;
    };
    instances?: Record<string, { messages?: Array<{ message?: string }> }>;
}

export class MessagesHandler {
    private adapter: utils.AdapterInstance;

    private send: AgentMessageSender;

    constructor(adapter: utils.AdapterInstance, send: AgentMessageSender) {
        this.adapter = adapter;
        this.send = send;
    }

    public onMessage(obj: ioBroker.Message): void {
        if (!obj) {
            return;
        }

        if (obj.command === 'sendDirect') {
            const { text, severity = 'notify' } = (obj.message ?? {}) as {
                text?: string;
                severity?: string;
            };
            if (!text) {
                if (obj.callback) {
                    this.adapter.sendTo(obj.from, obj.command, { sent: false, error: 'no payload' }, obj.callback);
                }
                return;
            }
            const payload = JSON.stringify({ type: 'direct', text, severity });
            //send to gRPC
            return;
        } else if (obj.command === 'sendNotification') {
            this.adapter.log.debug(`sendNotification: ${JSON.stringify(obj.message)}`);
            const notification = obj.message as NotificationMessage | undefined;
            const text = this.extractText(notification);

            if (!text) {
                this.adapter.log.warn('Received notification without content — ignored.');
                if (obj.callback) {
                    this.adapter.sendTo(obj.from, obj.command, { sent: false, error: 'no payload' }, obj.callback);
                }
                return;
            }

            const severity = notification?.category?.severity ?? 'notify';
            const payload = JSON.stringify({ text, severity });
            //send to gRPC
        }
    }

    private extractText(notification: NotificationMessage | undefined): string | null {
        try {
            const instances = notification?.category?.instances ?? notification?.instances ?? {};
            const parts: string[] = [];
            for (const data of Object.values(instances)) {
                for (const msg of data.messages ?? []) {
                    if (msg.message) {
                        parts.push(msg.message);
                    }
                }
            }
            if (parts.length) {
                return parts.join('. ');
            }

            const desc = notification?.category?.description;
            if (typeof desc === 'string') {
                return desc;
            }
            if (desc && typeof desc === 'object') {
                return desc.de ?? desc.en ?? null;
            }

            const name = notification?.category?.name;
            if (typeof name === 'string') {
                return name;
            }
            if (name && typeof name === 'object') {
                return name.de ?? name.en ?? null;
            }
        } catch (e) {
            this.log.warn(`Failed to extract text: ${(e as Error).message}`);
        }
        return null;
    }
}