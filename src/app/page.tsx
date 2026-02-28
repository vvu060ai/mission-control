"use client";

import { useState, useEffect, useCallback } from "react";
import { Server, Activity, Shield, Trash2, Plug, Cpu, Globe, MessageSquare } from "lucide-react";
import Chat from "@/components/Chat";

interface Connection {
  url: string;
  token: string;
  deviceToken: string;
  agentId: string;
  port: string;
  status: 'connected' | 'error';
}

export default function Home() {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gatewayUrl, setGatewayUrl] = useState("ws://127.0.0.1:18789");
  const [gatewayToken, setGatewayToken] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeTab, setActiveTab] = useState<'gateways' | 'chat'>('gateways');
  // Map of url -> true/false/null (null = checking)
  const [onlineStatus, setOnlineStatus] = useState<Record<string, boolean | null>>({});

  const checkHealth = useCallback(async (conns: Connection[]) => {
    if (conns.length === 0) return;
    // Mark all as checking
    setOnlineStatus(prev => {
      const next = { ...prev };
      conns.forEach(c => { next[c.url] = null; });
      return next;
    });
    await Promise.all(conns.map(async (conn) => {
      try {
        const res = await fetch('/api/agents/health', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: conn.url, token: conn.token }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        setOnlineStatus(prev => ({ ...prev, [conn.url]: data.online === true }));
      } catch {
        setOnlineStatus(prev => ({ ...prev, [conn.url]: false }));
      }
    }));
  }, []);

  // Load connections from localStorage on mount, then health-check them
  useEffect(() => {
    const saved = localStorage.getItem("mission_control_connections");
    if (saved) {
      try {
        const parsed: Connection[] = JSON.parse(saved);
        setConnections(parsed);
        checkHealth(parsed);
      } catch (e) {
        console.error("Failed to load connections from local storage", e);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-check health every 30 seconds
  useEffect(() => {
    if (connections.length === 0) return;
    const interval = setInterval(() => checkHealth(connections), 30_000);
    return () => clearInterval(interval);
  }, [connections, checkHealth]);

  // Persist connections to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem("mission_control_connections", JSON.stringify(connections));
  }, [connections]);

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const response = await fetch("/api/agents/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: gatewayUrl, token: gatewayToken })
      });
      const data = await response.json();

      if (data.success) {
        const port = new URL(gatewayUrl.replace('ws://', 'http://').replace('wss://', 'https://')).port || '18789';
        const newConn: Connection = {
          url: gatewayUrl,
          token: gatewayToken,
          deviceToken: data.deviceToken,
          agentId: 'main',
          port: port,
          status: 'connected'
        };
        // Upsert: update if URL already exists, add if new
        setConnections(prev => {
          const exists = prev.some(c => c.url === gatewayUrl);
          return exists
            ? prev.map(c => c.url === gatewayUrl ? newConn : c)
            : [...prev, newConn];
        });
        setOnlineStatus(prev => ({ ...prev, [gatewayUrl]: true }));
        setGatewayToken("");
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError("Failed to reach API route. Ensure the Gateway is running.");
    } finally {
      setConnecting(false);
    }
  };

  const removeConnection = (url: string) => {
    setConnections(connections.filter(c => c.url !== url));
    setOnlineStatus(prev => { const n = { ...prev }; delete n[url]; return n; });
  };

  const onlineConnections = connections.filter(c => onlineStatus[c.url] === true);
  const offlineConnections = connections.filter(c => onlineStatus[c.url] === false);

  return (
    <div className="flex flex-col items-center min-h-screen bg-[#0a0a0c] text-slate-200">
      {/* Dynamic Background Effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none opacity-20">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[35%] h-[35%] bg-orange-600 rounded-full blur-[120px]" />
      </div>

      <main className="max-w-6xl w-full p-8 space-y-12 relative z-10">
        {/* Header Section */}
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div className="space-y-1">
            <h1 className="text-5xl font-extrabold tracking-tighter text-white bg-clip-text text-transparent bg-gradient-to-r from-orange-400 to-orange-600">
              MISSION CONTROL
            </h1>
            <p className="text-slate-400 font-medium">Multi-Agent Gateway Command Center</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex bg-slate-900/80 p-1 rounded-xl border border-slate-800">
              <button
                onClick={() => setActiveTab('gateways')}
                className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'gateways' ? 'bg-orange-600 text-white shadow-lg shadow-orange-950/20' : 'text-slate-400 hover:text-white'}`}
              >
                Gateways
              </button>
              <button
                onClick={() => setActiveTab('chat')}
                className={`px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all ${activeTab === 'chat' ? 'bg-orange-600 text-white shadow-lg shadow-orange-950/20' : 'text-slate-400 hover:text-white'}`}
              >
                <MessageSquare size={14} />
                Agent Chat
              </button>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">Global Status</span>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full animate-pulse ${onlineConnections.length > 0 ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : connections.length > 0 ? 'bg-yellow-500' : 'bg-orange-500'}`} />
                <span className="text-sm font-semibold">{onlineConnections.length > 0 ? 'Active Deployment' : connections.length > 0 ? 'Checking...' : 'Ready to Launch'}</span>
              </div>
            </div>
          </div>
        </header>

        {activeTab === 'gateways' ? (
          <>
            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="p-6 rounded-2xl bg-slate-900/50 border border-slate-800 backdrop-blur-md group hover:border-orange-500/50 transition-all">
                <div className="flex justify-between items-start mb-4">
                  <div className="p-2 rounded-lg bg-orange-500/10 text-orange-500">
                    <Cpu size={20} />
                  </div>
                  <span className="text-[10px] font-bold text-slate-500 uppercase">Load Balanced</span>
                </div>
                <h2 className="text-sm font-medium text-slate-400 mb-1">Active Gateways</h2>
                <p className="text-4xl font-black text-white">{onlineConnections.length}<span className="text-lg text-slate-500 font-medium">/{connections.length}</span></p>
              </div>

              <div className="p-6 rounded-2xl bg-slate-900/50 border border-slate-800 backdrop-blur-md group hover:border-blue-500/50 transition-all">
                <div className="flex justify-between items-start mb-4">
                  <div className="p-2 rounded-lg bg-blue-500/10 text-blue-500">
                    <Globe size={20} />
                  </div>
                  <span className="text-[10px] font-bold text-slate-500 uppercase">Live Connections</span>
                </div>
                <h2 className="text-sm font-medium text-slate-400 mb-1">Total Agents</h2>
                <p className="text-4xl font-black text-white">{onlineConnections.length}<span className="text-lg text-slate-500 font-medium"> online</span></p>
              </div>

              <div className="p-6 rounded-2xl bg-slate-900/50 border border-slate-800 backdrop-blur-md group hover:border-emerald-500/50 transition-all">
                <div className="flex justify-between items-start mb-4">
                  <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500">
                    <Shield size={20} />
                  </div>
                  <span className="text-[10px] font-bold text-slate-500 uppercase">Security</span>
                </div>
                <h2 className="text-sm font-medium text-slate-400 mb-1">Authenticated</h2>
                <p className="text-4xl font-black text-white">{onlineConnections.length > 0 ? 'Verified' : offlineConnections.length > 0 ? 'Offline' : 'Pending'}</p>
              </div>
            </div>

            {/* Add Connection Section */}
            <section className="p-8 rounded-3xl bg-slate-900/40 border border-slate-800 backdrop-blur-xl shadow-2xl">
              <div className="flex items-center gap-3 mb-8">
                <div className="p-2 rounded-xl bg-orange-600 shadow-lg shadow-orange-600/20">
                  <Plug className="text-white" size={24} />
                </div>
                <h2 className="text-2xl font-bold text-white tracking-tight">Deploy New Instance</h2>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-end">
                <div className="lg:col-span-5 space-y-2">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1">Gateway WebSocket URL</label>
                  <input
                    type="text"
                    value={gatewayUrl}
                    onChange={(e) => setGatewayUrl(e.target.value)}
                    className="w-full px-5 py-3.5 bg-black/40 border border-slate-700/50 rounded-2xl focus:ring-2 focus:ring-orange-500 grid-focus:border-orange-500 outline-none transition-all text-white placeholder:text-slate-600"
                    placeholder="ws://127.0.0.1:18789"
                  />
                </div>
                <div className="lg:col-span-4 space-y-2">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1">Master Access Token</label>
                  <input
                    type="password"
                    value={gatewayToken}
                    onChange={(e) => setGatewayToken(e.target.value)}
                    className="w-full px-5 py-3.5 bg-black/40 border border-slate-700/50 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none transition-all text-white placeholder:text-slate-600"
                    placeholder="Enter auth credential..."
                  />
                </div>
                <div className="lg:col-span-3">
                  <button
                    onClick={handleConnect}
                    disabled={connecting}
                    className="w-full py-4 bg-gradient-to-br from-orange-500 to-orange-700 hover:from-orange-400 hover:to-orange-600 text-white rounded-2xl font-bold text-sm uppercase tracking-widest shadow-xl shadow-orange-950/20 transition-all transform active:scale-[0.98] disabled:opacity-50 disabled:grayscale"
                  >
                    {connecting ? 'Establishing Link...' : 'Initiate Connect'}
                  </button>
                </div>
              </div>

              {error && (
                <div className="mt-6 p-4 bg-red-500/10 border border-red-500/30 rounded-2xl flex items-center gap-3 text-red-400 text-sm font-medium">
                  <Activity size={16} className="animate-pulse" />
                  <span>Link Failure: {error}</span>
                </div>
              )}
            </section>

            {/* Active Connections List */}
            <section className="space-y-6">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold flex items-center gap-3">
                  <Server className="text-blue-500" size={20} />
                  Active System Nodes
                </h3>
                <span className="text-xs font-bold text-slate-500 uppercase bg-slate-800/50 px-3 py-1 rounded-full border border-slate-700">
                  {onlineConnections.length}/{connections.length} Online
                </span>
              </div>

              {connections.length === 0 ? (
                <div className="p-16 border-2 border-dashed border-slate-800 rounded-3xl flex flex-col items-center justify-center text-slate-500 space-y-4">
                  <Plug size={48} className="opacity-20 translate-y-2" />
                  <p className="font-medium">No system nodes currently deployed.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                  {connections.map((conn) => (
                    <div
                      key={conn.url}
                      className={`p-6 rounded-3xl border transition-all group overflow-hidden relative ${onlineStatus[conn.url] === false
                        ? 'bg-slate-900/30 border-slate-800/50 opacity-60'
                        : 'bg-slate-900/60 border-slate-800 hover:border-blue-500/40'
                        }`}
                    >
                      <div className="absolute top-0 right-0 p-8 opacity-[0.03] pointer-events-none group-hover:opacity-[0.07] transition-opacity">
                        <Server size={120} />
                      </div>

                      <div className="flex justify-between items-start relative z-10 mb-6">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${onlineStatus[conn.url] === null || !(conn.url in onlineStatus)
                              ? 'bg-yellow-500 animate-pulse'
                              : onlineStatus[conn.url]
                                ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)] animate-pulse'
                                : 'bg-red-500'
                              }`} />
                            <h4 className="text-lg font-bold text-white uppercase tracking-tight">Agent {conn.agentId}</h4>
                            <span className={`text-[9px] font-black px-2 py-0.5 rounded-full uppercase tracking-widest ${onlineStatus[conn.url] === null || !(conn.url in onlineStatus)
                              ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                              : onlineStatus[conn.url]
                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                : 'bg-red-500/20 text-red-400 border border-red-500/30'
                              }`}>
                              {onlineStatus[conn.url] === null || !(conn.url in onlineStatus) ? 'Checking' : onlineStatus[conn.url] ? 'Online' : 'Offline'}
                            </span>
                          </div>
                          <code className="text-[10px] text-blue-400 font-mono tracking-widest uppercase">NODE_ID: {conn.url}</code>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => checkHealth([conn])}
                            title="Re-check Connection"
                            className="p-2 text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10 rounded-xl transition-all"
                          >
                            <Activity size={18} />
                          </button>
                          <button
                            onClick={() => removeConnection(conn.url)}
                            className="p-2 text-slate-500 hover:text-red-500 hover:bg-red-500/10 rounded-xl transition-all"
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4 relative z-10">
                        <div className="p-4 rounded-2xl bg-black/30 border border-slate-800/50">
                          <span className="text-[10px] font-bold text-slate-500 uppercase block mb-1">Port</span>
                          <span className="text-lg font-mono font-bold text-slate-200">{conn.port}</span>
                        </div>
                        <div className="p-4 rounded-2xl bg-black/30 border border-slate-800/50">
                          <span className="text-[10px] font-bold text-slate-500 uppercase block mb-1">Client Mode</span>
                          <span className="text-sm font-bold text-slate-300">Backend Control</span>
                        </div>
                        <div className="col-span-2 p-4 rounded-2xl bg-black/30 border border-slate-800/50">
                          <span className="text-[10px] font-bold text-slate-500 uppercase block mb-1">Device Identity Token</span>
                          <div className="flex items-center gap-2">
                            <Shield size={12} className="text-emerald-500" />
                            <span className="text-[11px] font-mono text-slate-400">{conn.deviceToken}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : (
          <Chat connections={connections} />
        )}
      </main>
    </div>
  );
}
