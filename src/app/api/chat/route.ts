/**
 * POST /api/chat
 *
 * Proxies chat messages to the OpenClaw gateway's OpenAI-compatible endpoint.
 * ALL chat MUST go through OpenClaw so the agent has:
 *   - Its full workspace context (AGENTS.md, SOUL.md, USER.md)
 *   - Session history and memory
 *   - Tool access (file system, browser, exec, code, etc.)
 *   - Ability to trigger real actions
 *
 * OpenClaw then routes to the configured model (e.g. openrouter/google/gemini-2.0-flash-001)
 * using its own API keys. Mission Control does NOT talk to any LLM directly for chat.
 *
 * Body: {
 *   gatewayUrl: string   — "ws://127.0.0.1:18789"
 *   token: string        — gateway auth token
 *   agentId?: string     — defaults to "main"
 *   messages: Message[]  — full conversation history
 * }
 */
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
    try {
        const { gatewayUrl, token, agentId, messages } = await req.json();

        if (!gatewayUrl) {
            return new Response(JSON.stringify({ error: 'Missing gatewayUrl' }), { status: 400 });
        }
        if (!messages?.length) {
            return new Response(JSON.stringify({ error: 'No messages provided' }), { status: 400 });
        }

        // Convert ws:// → http:// for the HTTP endpoint
        const httpBase = gatewayUrl
            .replace(/^ws:\/\//i, 'http://')
            .replace(/^wss:\/\//i, 'https://')
            .replace(/\/$/, '');

        // Send to OpenClaw's OpenAI-compatible endpoint.
        // OpenClaw picks the model from agents.defaults.model.primary (set via /api/models).
        // It authenticates with OpenRouter itself using the key in openclaw.json env section.
        const upstreamRes = await fetch(`${httpBase}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
                model: agentId || 'main',   // OpenClaw agent ID, not a model name
                messages,                   // Full conversation history
                stream: true,
            }),
        });

        if (!upstreamRes.ok) {
            const errText = await upstreamRes.text();
            console.error('[/api/chat] Gateway error:', upstreamRes.status, errText);

            let errMsg = `Gateway returned ${upstreamRes.status}`;
            try {
                const errJson = JSON.parse(errText);
                errMsg = errJson.error?.message || errJson.message || errMsg;
            } catch { /* not JSON */ }

            return new Response(JSON.stringify({ error: errMsg }), { status: upstreamRes.status });
        }

        // Pipe the SSE stream straight through to the browser
        return new Response(upstreamRes.body, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            },
        });

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('[/api/chat] Error:', message);
        return new Response(JSON.stringify({ error: message }), { status: 500 });
    }
}
console.log("TESTING");
