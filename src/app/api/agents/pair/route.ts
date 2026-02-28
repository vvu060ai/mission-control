/**
 * POST /api/agents/pair
 *
 * Pairs with an OpenClaw gateway and registers it in the GatewayHub
 * so it gets a persistent connection immediately after pairing.
 *
 * Body: { url, token, agentId? }
 * Response: { success, deviceToken, message } | { success: false, error }
 */
import { NextResponse } from 'next/server';
import { OpenClawGateway } from '@/lib/gateway';
import { gatewayHub } from '@/lib/gateway-hub';

export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const { url, token, agentId = 'main' } = body;

        if (!url || !token) {
            return NextResponse.json({ success: false, error: 'Missing url or token' }, { status: 400 });
        }

        // Pair via the existing stateless gateway client
        const gateway = new OpenClawGateway(url, token);
        const deviceToken = await gateway.pair(agentId);

        // Register in GatewayHub — this opens the persistent WS connection
        // that will be used for all future RPC calls and event streaming.
        gatewayHub.register(url, token).catch((err) => {
            console.error('[pair] GatewayHub register failed (non-fatal):', err.message);
        });

        return NextResponse.json({
            success: true,
            deviceToken,
            message: `Successfully paired with OpenClaw agent "${agentId}"`,
        });
    } catch (error: unknown) {
        console.error('Pairing failed:', error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown pairing error',
        }, { status: 500 });
    }
}
