/**
 * POST /api/gateway/rpc
 *
 * Generic RPC dispatcher — routes a method call to the right GatewayConnection.
 * Registers the gateway (and starts its persistent WS) if not already registered.
 *
 * Body: {
 *   gatewayUrl: string,   // e.g. "ws://127.0.0.1:18789"
 *   token: string,        // gateway auth token
 *   method: string,       // e.g. "config.get", "config.patch"
 *   params?: object       // method-specific params
 * }
 *
 * Response: { ok: true, payload: unknown } | { ok: false, error: string }
 *
 * Example methods:
 *   config.get    → {}                         → returns full config + hash
 *   config.patch  → { raw, baseHash }          → patches config, may restart
 *   config.apply  → { raw, baseHash }          → replaces full config
 */
import { NextRequest, NextResponse } from 'next/server';
import { gatewayHub } from '@/lib/gateway-hub';

export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({}));
        const { gatewayUrl, token, method, params = {} } = body as {
            gatewayUrl?: string;
            token?: string;
            method?: string;
            params?: Record<string, unknown>;
        };

        if (!gatewayUrl) return NextResponse.json({ ok: false, error: 'Missing gatewayUrl' }, { status: 400 });
        if (!method) return NextResponse.json({ ok: false, error: 'Missing method' }, { status: 400 });
        if (!token) return NextResponse.json({ ok: false, error: 'Missing token' }, { status: 400 });

        // Ensure this gateway is registered in the hub (idempotent)
        await gatewayHub.register(gatewayUrl, token);

        // Wait for the connection if it's still handshaking (up to 10s)
        const conn = gatewayHub.getConnection(gatewayUrl)!;
        if (conn.getStatus() !== 'connected') {
            await waitForConnected(conn, 10_000);
        }

        const payload = await gatewayHub.call(gatewayUrl, method, params);
        return NextResponse.json({ ok: true, payload });

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('[/api/gateway/rpc]', message);
        return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
}

function waitForConnected(conn: import('@/lib/gateway-connection').GatewayConnection, timeoutMs: number): Promise<void> {
    if (conn.getStatus() === 'connected') return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            conn.off('status', onStatus);
            reject(new Error('Gateway connection timed out'));
        }, timeoutMs);

        const onStatus = (s: string) => {
            if (s === 'connected') {
                clearTimeout(timer);
                conn.off('status', onStatus);
                resolve();
            } else if (s === 'error' || s === 'closed') {
                clearTimeout(timer);
                conn.off('status', onStatus);
                reject(new Error(`Gateway connection failed: ${s}`));
            }
        };

        conn.on('status', onStatus);
    });
}
