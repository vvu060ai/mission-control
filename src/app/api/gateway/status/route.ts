/**
 * GET /api/gateway/status
 *
 * Returns the connection status of all registered gateways.
 * Fast — reads in-memory state, no I/O.
 *
 * Response: { gateways: GatewayStatus[] }
 */
import { NextResponse } from 'next/server';
import { gatewayHub } from '@/lib/gateway-hub';

export async function GET() {
    return NextResponse.json({ gateways: gatewayHub.getStatus() });
}
