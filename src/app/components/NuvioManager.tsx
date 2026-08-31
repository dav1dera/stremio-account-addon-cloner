"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { fetchAddons } from "../services/api";
import { useAccounts } from "../hooks/useAccounts";
import type { AddonData } from "../types/addon";

type NuvioProfile = {
  id: string;
  profile_index: number;
  name: string;
  uses_primary_addons?: boolean;
};

type NuvioAddon = {
  id?: string;
  profile_id?: number;
  url: string;
  name: string | null;
  enabled: boolean;
  sort_order: number;
};

type NuvioResponse = {
  success?: boolean;
  error?: string;
  auth?: { access_token?: string };
  profiles?: NuvioProfile[];
  addons?: NuvioAddon[];
};

async function nuvioRequest(payload: Record<string, unknown>): Promise<NuvioResponse> {
  const res = await fetch("/api/nuvio", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await res.json() as NuvioResponse;
  if (!res.ok || !result?.success) throw new Error(result?.error || "Nuvio request failed");
  return result;
}

export default function NuvioManager() {
  const { primaryAccount, setAlert } = useAccounts();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [profiles, setProfiles] = useState<NuvioProfile[]>([]);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [addons, setAddons] = useState<NuvioAddon[]>([]);
  const [newUrl, setNewUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const currentProfile = useMemo(
    () => profiles.find((p) => p.profile_index === profileId) || null,
    [profiles, profileId]
  );

  useEffect(() => {
    const saved = sessionStorage.getItem("nuvio_access_token");
    if (saved) setToken(saved);
  }, []);

  const loadProfiles = async (accessToken = token) => {
    if (!accessToken) return;
    const result = await nuvioRequest({ action: "profiles", token: accessToken });
    const nextProfiles = result.profiles || [];
    setProfiles(nextProfiles);
    if (nextProfiles.length) {
      const first = nextProfiles[0].profile_index;
      setProfileId((prev) => prev ?? first);
      return first;
    }
    setProfileId(null);
    return null;
  };

  const loadAddons = async (id = profileId, accessToken = token) => {
    if (id == null || !accessToken) return;
    const result = await nuvioRequest({ action: "addons", token: accessToken, profileId: id });
    setAddons((result.addons || []).map((a, i) => ({ ...a, sort_order: i })));
  };

  const handleLogin = async () => {
    setBusy(true);
    try {
      const result = await nuvioRequest({ action: "login", email, password });
      const accessToken = result.auth?.access_token;
      if (!accessToken) throw new Error("Nuvio did not return an access token");
      setToken(accessToken);
      sessionStorage.setItem("nuvio_access_token", accessToken);
      setPassword("");
      const first = await loadProfiles(accessToken);
      if (first != null) await loadAddons(first, accessToken);
      setAlert({ type: "success", message: "Nuvio account connected." });
    } catch (err) {
      setAlert({ type: "error", message: `Nuvio login failed: ${err instanceof Error ? err.message : "Unknown error"}` });
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    setBusy(true);
    try {
      if (!profiles.length) await loadProfiles();
      await loadAddons();
    } catch (err) {
      setAlert({ type: "error", message: `Nuvio refresh failed: ${err instanceof Error ? err.message : "Unknown error"}` });
    } finally {
      setBusy(false);
    }
  };

  const handleProfileChange = async (nextId: number) => {
    setProfileId(nextId);
    setBusy(true);
    try { await loadAddons(nextId); }
    catch (err) {
      setAlert({ type: "error", message: `Failed to load Nuvio addons: ${err instanceof Error ? err.message : "Unknown error"}` });
    } finally { setBusy(false); }
  };

  const handleAdd = () => {
    const url = newUrl.trim();
    if (!url) return;
    if (addons.some((a) => a.url === url)) {
      setAlert({ type: "error", message: "That addon is already in this Nuvio profile." });
      return;
    }
    setAddons((prev) => [...prev, { url, name: null, enabled: true, sort_order: prev.length }]);
    setNewUrl("");
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= addons.length) return;
    setAddons((prev) => {
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((a, i) => ({ ...a, sort_order: i }));
    });
  };

  const importFromStremio = async () => {
    setBusy(true);
    try {
      const stremioAddons: AddonData[] = await fetchAddons(primaryAccount);
      const existing = new Set(addons.map((a) => a.url));
      const imported: NuvioAddon[] = stremioAddons
        .filter((addon) => addon.transportUrl && !existing.has(addon.transportUrl))
        .map((addon, i) => ({
          url: addon.transportUrl,
          name: addon.manifest?.name || null,
          enabled: true,
          sort_order: addons.length + i,
        }));
      setAddons((prev) => [...prev, ...imported]);
      setAlert({ type: "success", message: `Imported ${imported.length} Stremio addon(s) into the Nuvio draft. Press Save to sync.` });
    } catch (err) {
      setAlert({ type: "error", message: `Stremio → Nuvio import failed: ${err instanceof Error ? err.message : "Unknown error"}` });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (profileId == null) return;
    setSaving(true);
    try {
      const result = await nuvioRequest({ action: "saveAddons", token, profileId, addons });
      setAddons((result.addons || []).map((a, i) => ({ ...a, sort_order: i })));
      setAlert({ type: "success", message: `Nuvio profile “${currentProfile?.name || profileId}” saved.` });
    } catch (err) {
      setAlert({ type: "error", message: `Failed to save Nuvio addons: ${err instanceof Error ? err.message : "Unknown error"}` });
    } finally {
      setSaving(false);
    }
  };

  const logout = () => {
    sessionStorage.removeItem("nuvio_access_token");
    setToken("");
    setProfiles([]);
    setProfileId(null);
    setAddons([]);
  };

  return (
    <section className="rounded-xl border border-purple-700/60 bg-gray-900/50 p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white">Nuvio Addon Manager</h2>
          <p className="text-sm text-gray-400">Manage Nuvio profiles and copy addons from your primary Stremio account.</p>
        </div>
        {token && <button onClick={logout} className="text-sm text-gray-400 hover:text-white">Disconnect</button>}
      </div>

      {!token ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Nuvio email" className="rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white" />
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Nuvio password" className="rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white" />
          <button onClick={handleLogin} disabled={busy} className="sm:col-span-2 rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-500 disabled:opacity-50">
            {busy ? "Connecting…" : "Connect Nuvio"}
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row">
            <select value={profileId ?? ""} onChange={(e) => handleProfileChange(Number(e.target.value))} className="flex-1 rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white">
              {profiles.map((p) => <option key={p.id} value={p.profile_index}>{p.name} (Profile {p.profile_index})</option>)}
            </select>
            <button onClick={handleRefresh} disabled={busy} className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-600 px-4 py-2 text-gray-200 hover:bg-gray-800 disabled:opacity-50">
              <RefreshCw size={16} className={busy ? "animate-spin" : ""} /> Refresh
            </button>
            <button onClick={importFromStremio} disabled={busy} className="rounded-lg border border-blue-600 px-4 py-2 text-blue-300 hover:bg-blue-950/40 disabled:opacity-50">Stremio → Nuvio</button>
          </div>

          <div className="flex gap-2">
            <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleAdd()} placeholder="https://addon.example/manifest.json" className="flex-1 rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white" />
            <button onClick={handleAdd} className="inline-flex items-center gap-2 rounded-lg bg-green-700 px-4 py-2 text-white hover:bg-green-600"><Plus size={16} /> Add</button>
          </div>

          <div className="space-y-2">
            {addons.map((addon, index) => (
              <div key={`${addon.url}-${index}`} className="flex items-center gap-2 rounded-lg bg-gray-800 p-3">
                <input type="checkbox" checked={addon.enabled} onChange={(e) => setAddons((prev) => prev.map((a, i) => i === index ? { ...a, enabled: e.target.checked } : a))} />
                <div className="min-w-0 flex-1">
                  <input value={addon.name || ""} onChange={(e) => setAddons((prev) => prev.map((a, i) => i === index ? { ...a, name: e.target.value || null } : a))} placeholder="Addon name" className="w-full bg-transparent text-sm font-medium text-white outline-none" />
                  <div className="truncate text-xs text-gray-400" title={addon.url}>{addon.url}</div>
                </div>
                <button onClick={() => move(index, -1)} disabled={index === 0} className="p-1 text-gray-400 hover:text-white disabled:opacity-20"><ArrowUp size={16} /></button>
                <button onClick={() => move(index, 1)} disabled={index === addons.length - 1} className="p-1 text-gray-400 hover:text-white disabled:opacity-20"><ArrowDown size={16} /></button>
                <button onClick={() => setAddons((prev) => prev.filter((_, i) => i !== index).map((a, i) => ({ ...a, sort_order: i })))} className="p-1 text-red-400 hover:text-red-300"><Trash2 size={16} /></button>
              </div>
            ))}
            {!addons.length && <div className="rounded-lg border border-dashed border-gray-700 p-4 text-center text-sm text-gray-500">No addons in this profile.</div>}
          </div>

          <button onClick={save} disabled={saving || profileId == null} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-500 disabled:opacity-50">
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {saving ? "Saving…" : "Save Nuvio Addons"}
          </button>
        </>
      )}
    </section>
  );
}
