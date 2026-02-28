/**
 * GET  /api/models  — List OpenRouter models + current primary model
 * POST /api/models  — Set the primary model in openclaw.json (writes via GatewayHub RPC or direct file)
 *
 * Model formats:
 *   OpenRouter model IDs:  "google/gemini-2.0-flash-001"  (from OpenRouter /models API)
 *   OpenClaw model refs:   "openrouter/google/gemini-2.0-flash-001"  (prefixed for openclaw.json)
 *
 * The UI and OpenRouter API use the bare OpenRouter ID.
 * openclaw.json always uses the "openrouter/<id>" prefixed form.
 */
import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');

function readOpenClawConfig(): Record<string, unknown> {
    try {
        return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function writeOpenClawConfig(config: Record<string, unknown>) {
    fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** Strips "openrouter/" prefix → raw OpenRouter model ID for display / OpenRouter API calls */
function toOpenRouterModelId(ref: string): string {
    return ref.startsWith('openrouter/') ? ref.slice('openrouter/'.length) : ref;
}

/** Adds "openrouter/" prefix → openclaw.json compatible ref */
function toOpenClawRef(modelId: string): string {
    return modelId.startsWith('openrouter/') ? modelId : `openrouter/${modelId}`;
}

// ── GET ────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
    const url = new URL(req.url);
    const agentId = url.searchParams.get('agentId') || 'main';
    const apiKey = process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
        return NextResponse.json({ error: 'OPENROUTER_API_KEY not configured in .env.local' }, { status: 500 });
    }

    try {
        const res = await fetch('https://openrouter.ai/api/v1/models', {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'HTTP-Referer': 'http://localhost:3000',
                'X-Title': 'Mission Control',
            },
        });

        if (!res.ok) {
            const errText = await res.text();
            return NextResponse.json({ error: `OpenRouter error: ${errText}` }, { status: res.status });
        }

        const data = await res.json();
        const config = readOpenClawConfig();

        let rawModel = '';

        if (agentId !== 'main' && (config.agents as any)?.list) {
            const agent = (config.agents as any).list.find((a: any) => a.id === agentId);
            if (agent && agent.model) {
                rawModel = agent.model;
            }
        }

        // Fallback to global default
        if (!rawModel) {
            const agents = config.agents as Record<string, unknown> | undefined;
            const defaults = agents?.defaults as Record<string, unknown> | undefined;
            const modelCfg = defaults?.model as Record<string, unknown> | undefined;
            rawModel = (modelCfg?.primary as string | undefined) ?? '';
        }

        const currentModel = toOpenRouterModelId(rawModel);

        return NextResponse.json({
            models: data.data ?? [],
            currentModel,
        });
    } catch (err: unknown) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to fetch models' }, { status: 500 });
    }
}

// ── POST ───────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const model = body.model as string;
        const agentId = body.agentId as string | undefined;

        if (!model || typeof model !== 'string') {
            return NextResponse.json({ error: 'Missing or invalid model field' }, { status: 400 });
        }

        const apiKey = process.env.OPENROUTER_API_KEY;
        const openClawRef = toOpenClawRef(model); // "openrouter/google/gemini-2.0-flash-001"
        const config = readOpenClawConfig() as Record<string, unknown>;

        // ── Ensure nested structure ──
        if (!config.agents) config.agents = {};
        const agents = config.agents as Record<string, unknown>;
        if (!agents.defaults) agents.defaults = {};
        const defaults = agents.defaults as Record<string, unknown>;
        if (!defaults.model) defaults.model = {};
        const modelCfg = defaults.model as Record<string, unknown>;
        if (!defaults.models) defaults.models = {};
        const allowlist = defaults.models as Record<string, unknown>;

        let previousRef: string | undefined;

        // ── Set per-agent OR primary model (with openrouter/ prefix) ──
        if (agentId && agentId !== 'main') {
            if (!agents.list) agents.list = [];
            const agentList = agents.list as any[];
            const agentEntry = agentList.find(a => a.id === agentId);
            if (agentEntry) {
                previousRef = agentEntry.model;
                agentEntry.model = openClawRef;
            } else {
                return NextResponse.json({ error: `Agent ${agentId} not found` }, { status: 404 });
            }
        } else {
            previousRef = modelCfg.primary as string | undefined;
            modelCfg.primary = openClawRef;
        }

        // ── Add to allowlist (openrouter/ prefixed) ──
        if (!allowlist[openClawRef]) {
            allowlist[openClawRef] = {};
        }

        // ── Ensure OPENROUTER_API_KEY is in the config env ──
        // This lets the OpenClaw agent call OpenRouter for tasks/tools,
        // separate from Mission Control's direct API calls.
        if (apiKey) {
            if (!config.env) config.env = {};
            const envCfg = config.env as Record<string, string>;
            if (!envCfg.OPENROUTER_API_KEY) {
                envCfg.OPENROUTER_API_KEY = apiKey;
            }
        }

        // ── Write config (no meta fields — openclaw rejects unknown keys) ──
        writeOpenClawConfig(config);

        return NextResponse.json({
            success: true,
            previousModel: previousRef ? toOpenRouterModelId(previousRef) : null,
            currentModel: model,        // bare ID for the UI
            openClawRef,                // prefixed ref written to openclaw.json
            message: `Model updated to ${openClawRef} in openclaw.json`,
            note: 'agents.* changes are hot-reloaded — no gateway restart needed.',
        });
    } catch (err: unknown) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to update model' }, { status: 500 });
    }
}
