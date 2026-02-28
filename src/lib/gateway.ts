import { WebSocket } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface GatewayMessage {
    type: string;
    payload?: any;
}

const PROTOCOL_VERSION = 3;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class OpenClawGateway {
    private ws: WebSocket | null = null;
    private url: string;
    private token: string;
    private connected = false;
    private deviceIdentity: { deviceId: string; publicKeyPem: string; privateKeyPem: string } | null = null;
    private deviceToken: string | null = null;

    constructor(url?: string, token?: string) {
        this.url = url || process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789';
        this.token = token || process.env.OPENCLAW_GATEWAY_TOKEN || '';
    }

    private getIdentityPath() {
        return path.join(os.homedir(), '.openclaw', 'identity', 'mission-control.json');
    }

    private base64UrlEncode(buf: Buffer) {
        return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
    }

    private derivePublicKeyRaw(publicKeyPem: string) {
        const key = crypto.createPublicKey(publicKeyPem);
        const spki = key.export({ type: 'spki', format: 'der' });
        if (spki.length === ED25519_SPKI_PREFIX.length + 32 && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
            return spki.subarray(ED25519_SPKI_PREFIX.length);
        }
        return spki;
    }

    private loadOrCreateIdentity() {
        if (this.deviceIdentity) return this.deviceIdentity;

        const idPath = this.getIdentityPath();
        try {
            if (fs.existsSync(idPath)) {
                const data = JSON.parse(fs.readFileSync(idPath, 'utf8'));
                if (data.deviceId && data.publicKeyPem && data.privateKeyPem) {
                    this.deviceIdentity = {
                        deviceId: data.deviceId,
                        publicKeyPem: data.publicKeyPem,
                        privateKeyPem: data.privateKeyPem
                    };
                    return this.deviceIdentity;
                }
            }
        } catch (e) {
            console.error('Failed to load identity, creating new one...');
        }

        // Generate new Ed25519 identity
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
        const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

        // Derive deviceId (OpenClaw style: sha256 of raw public key)
        const rawPub = this.derivePublicKeyRaw(publicKeyPem);
        const deviceId = crypto.createHash('sha256').update(rawPub).digest('hex');

        this.deviceIdentity = { deviceId, publicKeyPem, privateKeyPem };

        // Save it
        try {
            fs.mkdirSync(path.dirname(idPath), { recursive: true });
            fs.writeFileSync(idPath, JSON.stringify({ ...this.deviceIdentity, version: 1, createdAtMs: Date.now() }, null, 2), { mode: 0o600 });
        } catch (e) {
            console.error('Failed to save identity:', e);
        }

        return this.deviceIdentity;
    }

    private normalizeMetadata(value: any): string {
        if (typeof value !== 'string') return '';
        const trimmed = value.trim();
        if (!trimmed) return '';
        return trimmed.toLowerCase();
    }

    private buildAuthPayload(params: {
        deviceId: string;
        clientId: string;
        clientMode: string;
        role: string;
        scopes: string[];
        signedAtMs: number;
        token: string;
        nonce: string;
        platform: string;
        deviceFamily?: string;
    }) {
        const scopes = params.scopes.join(",");
        const token = params.token ?? "";
        const platform = this.normalizeMetadata(params.platform);
        const deviceFamily = this.normalizeMetadata(params.deviceFamily);

        return [
            "v3",
            params.deviceId,
            params.clientId,
            params.clientMode,
            params.role,
            scopes,
            String(params.signedAtMs),
            token,
            params.nonce,
            platform,
            deviceFamily
        ].join("|");
    }

    private signPayload(payload: string) {
        const identity = this.loadOrCreateIdentity();
        const key = crypto.createPrivateKey(identity.privateKeyPem);
        const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
        return this.base64UrlEncode(signature);
    }

    private getPublicKeyRawBase64Url() {
        const identity = this.loadOrCreateIdentity();
        const rawPub = this.derivePublicKeyRaw(identity.publicKeyPem);
        return this.base64UrlEncode(rawPub);
    }

    private generateId() {
        return crypto.randomUUID();
    }

    async connect(): Promise<WebSocket> {
        if (this.ws && this.ws.readyState === WebSocket.OPEN && this.connected) {
            return this.ws;
        }

        return new Promise((resolve, reject) => {
            console.log(`Connecting to OpenClaw Gateway at ${this.url}...`);

            this.ws = new WebSocket(this.url, {
                headers: {
                    'User-Agent': 'mission-control/1.0.0',
                    'Origin': 'http://127.0.0.1:18789'
                }
            });

            const timeout = setTimeout(() => {
                if (!this.connected) {
                    this.ws?.terminate();
                    reject(new Error('Connection handshake timed out'));
                }
            }, 10000);

            this.ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    console.log('Gateway Message:', msg.type || msg.event);

                    if (msg.type === 'event' && msg.event === 'connect.challenge') {
                        const nonce = msg.payload.nonce;
                        const identity = this.loadOrCreateIdentity();
                        console.log('Handshaking with deviceId:', identity.deviceId);

                        const signedAt = Date.now();
                        const clientId = 'gateway-client';
                        const clientMode = 'backend';
                        const role = 'operator';
                        const scopes = ['operator.admin', 'operator.read', 'operator.write', 'operator.pairing', 'operator.approvals'];
                        const platform = 'darwin';

                        const payload = this.buildAuthPayload({
                            deviceId: identity.deviceId,
                            clientId,
                            clientMode,
                            role,
                            scopes,
                            signedAtMs: signedAt,
                            token: this.token,
                            nonce,
                            platform
                        });

                        const signature = this.signPayload(payload);

                        const connectReq = {
                            type: 'req',
                            id: this.generateId(),
                            method: 'connect',
                            params: {
                                minProtocol: PROTOCOL_VERSION,
                                maxProtocol: PROTOCOL_VERSION,
                                role,
                                scopes,
                                client: {
                                    id: clientId,
                                    version: '1.0.0',
                                    platform,
                                    mode: clientMode
                                },
                                device: {
                                    id: identity.deviceId,
                                    publicKey: this.getPublicKeyRawBase64Url(),
                                    signature,
                                    signedAt,
                                    nonce
                                },
                                auth: {
                                    token: this.token
                                }
                            }
                        };
                        this.ws?.send(JSON.stringify(connectReq));
                    }

                    if (msg.type === 'res' && msg.ok) {
                        console.log('Handshake complete! Connected.');
                        this.connected = true;
                        if (msg.payload?.auth?.deviceToken) {
                            this.deviceToken = msg.payload.auth.deviceToken;
                            console.log('Device Token issued:', this.deviceToken?.substring(0, 8) + '...');
                        }
                        clearTimeout(timeout);
                        resolve(this.ws!);
                    }

                    if (msg.type === 'res' && !msg.ok) {
                        console.error('Handshake failed:', JSON.stringify(msg.error, null, 2));
                        reject(new Error(msg.error?.message || 'Handshake failed'));
                    }
                } catch (e) {
                    console.error('Parse error:', e);
                }
            });

            this.ws.on('error', (err) => {
                console.error('WebSocket error:', err);
                reject(err);
            });

            this.ws.on('close', () => {
                console.log('OpenClaw Gateway connection closed');
                this.connected = false;
            });
        });
    }

    async pair(agentId: string = 'main'): Promise<string> {
        await this.connect();

        // If we already have a device token from hello-ok, we are already "paired"
        if (this.deviceToken) {
            return this.deviceToken;
        }

        return new Promise((resolve, reject) => {
            const pairRequest = {
                type: 'req',
                id: this.generateId(),
                method: 'node.pair.request',
                params: {
                    agentId,
                    clientName: 'Mission Control'
                }
            };

            console.log('Sending pair request...');
            this.ws!.send(JSON.stringify(pairRequest));

            const pairTimeout = setTimeout(() => {
                reject(new Error('Pairing timed out waiting for response from agent'));
            }, 30000);

            const pairingHandler = (data: any) => {
                try {
                    const msg = JSON.parse(data.toString());

                    if (msg.type === 'res' && msg.id === pairRequest.id) {
                        if (!msg.ok) {
                            reject(new Error(msg.error?.message || 'Pairing request failed'));
                        }
                    }

                    if (msg.type === 'event' && msg.event === 'paired' && msg.payload?.agentId === agentId) {
                        this.ws!.off('message', pairingHandler);
                        clearTimeout(pairTimeout);
                        resolve(msg.payload.deviceToken || 'paired');
                    }
                } catch (e) { }
            };

            this.ws!.on('message', pairingHandler);
        });
    }

    async chat(agentId: string, input: string, onToken: (token: string) => void): Promise<void> {
        await this.connect();

        return new Promise((resolve, reject) => {
            const chatId = this.generateId();
            const chatRequest = {
                type: 'req',
                id: chatId,
                method: 'agent',
                params: {
                    agentId,
                    message: input,
                    idempotencyKey: crypto.randomUUID()
                }
            };

            console.log(`Sending chat request: ${input}`);
            this.ws!.send(JSON.stringify(chatRequest));

            const messageHandler = (data: any) => {
                try {
                    const msg = JSON.parse(data.toString());

                    // Handle final response
                    if (msg.type === 'res' && msg.id === chatId) {
                        this.ws!.off('message', messageHandler);
                        if (msg.ok) {
                            resolve();
                        } else {
                            reject(new Error(msg.error?.message || 'Chat request failed'));
                        }
                    }

                    // Handle streaming events
                    if (msg.type === 'event' && msg.event === 'agent' && msg.payload?.delta?.content) {
                        onToken(msg.payload.delta.content);
                    }
                } catch (e) { }
            };

            this.ws!.on('message', messageHandler);
        });
    }
}
