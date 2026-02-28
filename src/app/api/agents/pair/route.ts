import { NextResponse } from 'next/server';
import { OpenClawGateway } from '@/lib/gateway';

export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const { url, token, agentId = 'main' } = body;

        const gateway = new OpenClawGateway(url, token);
        const deviceToken = await gateway.pair(agentId);

        return NextResponse.json({
            success: true,
            deviceToken,
            message: 'Successfully paired with OpenClaw agent "main"'
        });
    } catch (error: any) {
        console.error('Pairing failed:', error);
        return NextResponse.json({
            success: false,
            error: error.message || 'Unknown pairing error'
        }, { status: 500 });
    }
}
