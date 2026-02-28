/**
 * GET /api/agents
 * Retrieves the list of agent personas configured on the local gateway.
 *
 * POST /api/agents
 * Creates a new agent persona on the local gateway.
 * Body: { id, name, model }
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

export async function GET(req: NextRequest) {
    try {
        const config = readOpenClawConfig();
        const agentsList = (config.agents as any)?.list || [];

        // If list is empty, OpenClaw implicitly uses "main"
        if (agentsList.length === 0) {
            agentsList.push({
                id: 'main',
                name: 'Main Agent',
                model: (config.agents as any)?.defaults?.model?.primary
            });
        }

        return NextResponse.json({ agents: agentsList });
    } catch (err: unknown) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Failed to fetch agents' },
            { status: 500 }
        );
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { id, name, model } = body;

        if (!id || !name || !model) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        const config = readOpenClawConfig() as any;

        if (!config.agents) config.agents = {};
        if (!config.agents.list) {
            config.agents.list = [{
                id: 'main',
                name: 'Main Agent',
                model: config.agents?.defaults?.model?.primary
            }];
        }

        // Check if agent already exists
        const existingIndex = config.agents.list.findIndex((a: any) => a.id === id);
        if (existingIndex >= 0) {
            return NextResponse.json({ error: `Agent ID '${id}' already exists` }, { status: 400 });
        }

        // Must prefix openrouter/
        const modelRef = model.startsWith('openrouter/') ? model : `openrouter/${model}`;

        config.agents.list.push({
            id,
            name,
            model: modelRef
        });

        // Add to allowlist
        if (!config.agents.defaults) config.agents.defaults = {};
        if (!config.agents.defaults.models) config.agents.defaults.models = {};
        if (!config.agents.defaults.models[modelRef]) {
            config.agents.defaults.models[modelRef] = {};
        }

        writeOpenClawConfig(config);

        return NextResponse.json({ success: true, agents: config.agents.list });
    } catch (err: unknown) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Failed to create agent' },
            { status: 500 }
        );
    }
}
