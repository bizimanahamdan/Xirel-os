'use client';

/**
 * AI Command Center client (Phase 12) — mobile-first, low-JS, polling.
 *
 * Live updates use AUTHENTICATED POLLING (the mission allows Supabase
 * Realtime OR authenticated polling): simple fetches, staggered, paused
 * while the tab is hidden (low-memory Android friendliness — no
 * background timers, no websocket held open). When the user reconnects,
 * the next poll recovers the latest persisted state — nothing depends
 * on this page staying open.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

interface JobSummary {
  id: string;
  title: string;
  status: string;
  currentStep: string | null;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
}
interface ApprovalRow {
  id: string;
  summary: string;
  toolName: string | null;
  riskLevel: string | null;
  createdAt: string;
}
interface RunRow {
  id: string;
  status: string;
  taskId: string | null;
  projectId: string | null;
  startedAt: string | null;
}
interface ScheduleRow {
  id: string;
  name: string;
  cron: string;
  status: string;
  nextRunAt: string;
  lastRunAt: string | null;
  failureCount: number;
}
interface HealthData {
  executionPaused: boolean;
  queue: {
    depth: number;
    active: number;
    waitingApproval: number;
    failed: number;
    completed: number;
    oldestPendingSeconds: number | null;
    byStatus: Record<string, number>;
  };
  workers: { workerId: string; staleSeconds: number; activeJobs: number; version: string | null }[];
  providers: {
    providerId: string;
    configured: boolean;
    lastErrorClass: string | null;
    cooldownRemainingMs: number;
    lastLatencyMs: number | null;
  }[];
}

const STATUS_STYLES: Record<string, string> = {
  queued: 'bg-slate-700/60 text-slate-200',
  claimed: 'bg-blue-900/60 text-blue-200',
  planning: 'bg-blue-900/60 text-blue-200',
  running: 'bg-primary/20 text-primary',
  retrying: 'bg-yellow-900/50 text-yellow-200',
  verifying: 'bg-purple-900/50 text-purple-200',
  waiting_for_approval: 'bg-orange-900/50 text-orange-200',
  completed: 'bg-emerald-900/50 text-emerald-300',
  failed: 'bg-red-900/60 text-red-300',
  cancelled: 'bg-slate-800 text-slate-400',
  paused: 'bg-slate-800 text-slate-400',
};

function Pill({ status }: { status: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[status] ?? 'bg-slate-800 text-slate-300'}`}>
      {status.replaceAll('_', ' ')}
    </span>
  );
}

function Card({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export default function CommandClient({ workspaceId }: { workspaceId: string }) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [prompt, setPrompt] = useState('');
  const [runResult, setRunResult] = useState<{ text: string; runId?: string; status?: string } | null>(null);
  const [scheduleForm, setScheduleForm] = useState({ name: '', cron: '', instructions: '' });
  const [showSchedules, setShowSchedules] = useState(false);

  const workspaceRef = useRef(workspaceId);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchJson = useCallback(async (url: string) => {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${url.split('?')[0]} → ${res.status}`);
    return res.json();
  }, []);

  const refresh = useCallback(async () => {
    const ws = workspaceRef.current;
    try {
      const [jobsRes, approvalsRes, runsRes, schedulesRes] = await Promise.all([
        fetchJson(`/api/agent/jobs?workspaceId=${ws}&limit=10`),
        fetchJson(`/api/agent/approvals?workspaceId=${ws}&status=pending`),
        fetchJson('/api/agent/runs'),
        fetchJson(`/api/agent/schedules?workspaceId=${ws}`),
      ]);
      setJobs(jobsRes.jobs ?? []);
      setApprovals(approvalsRes.approvals ?? []);
      setRuns((runsRes.runs ?? []).slice(0, 8));
      setSchedules(schedulesRes.schedules ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'refresh failed');
    }
    try {
      setHealth(await fetchJson('/api/system/health'));
    } catch {
      /* health is non-critical; keep last snapshot */
    }
  }, [fetchJson]);

  // Poll loop: staggered, paused when the tab is hidden.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      if (!document.hidden) await refresh();
      timerRef.current = setTimeout(tick, 10_000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [refresh]);

  const askAgent = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: null, message: prompt.trim(), workspaceId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `agent request failed (${res.status})`);
        if (data.runId) setRunResult({ text: data.error ?? 'failed', runId: data.runId, status: data.status });
      } else {
        setRunResult({ text: data.text ?? '', runId: data.runId, status: data.status });
        if (data.verification?.verified) setNotice('Result verified against the registry.');
      }
      setPrompt('');
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'agent request failed');
    } finally {
      setBusy(false);
    }
  }, [prompt, busy, workspaceId, refresh]);

  const submitTask = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    setRunResult(null);
    try {
      const res = await fetch('/api/agent/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, description: prompt.trim() }),
      });
      const data = await res.json();
      if (!res.ok && res.status !== 202) {
        setError(data.error ?? `submission failed (${res.status})`);
      } else {
        setNotice(
          data.created
            ? `Durable task ${data.job.id.slice(0, 8)} queued — it runs in the background even if you close this page.`
            : `Identical task already queued (${data.job.id.slice(0, 8)}).`,
        );
        setPrompt('');
      }
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'submission failed');
    } finally {
      setBusy(false);
    }
  }, [prompt, busy, workspaceId, refresh]);

  const jobAction = useCallback(
    async (jobId: string, action: 'cancel' | 'pause' | 'resume') => {
      try {
        const res = await fetch(`/api/agent/jobs/${jobId}/actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        if (!res.ok) {
          const data = await res.json();
          setError(data.error ?? `action failed (${res.status})`);
        }
        void refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'action failed');
      }
    },
    [refresh],
  );

  const decideApproval = useCallback(
    async (approvalId: string, decision: 'approved' | 'rejected') => {
      try {
        const res = await fetch(`/api/agent/approvals/${approvalId}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision }),
        });
        if (!res.ok) {
          const data = await res.json();
          setError(data.error ?? `decision failed (${res.status})`);
        } else {
          setNotice(decision === 'approved' ? 'Approved — task resumes in the queue.' : 'Rejected — task cancelled.');
        }
        void refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'decision failed');
      }
    },
    [refresh],
  );

  const createSchedule = useCallback(async () => {
    if (!scheduleForm.name || !scheduleForm.cron || !scheduleForm.instructions) return;
    setBusy(true);
    try {
      const res = await fetch('/api/agent/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, ...scheduleForm }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? `schedule creation failed (${res.status})`);
      } else {
        setScheduleForm({ name: '', cron: '', instructions: '' });
        setNotice('Schedule created.');
      }
      void refresh();
    } finally {
      setBusy(false);
    }
  }, [workspaceId, scheduleForm, refresh]);

  const scheduleAction = useCallback(
    async (id: string, action: 'pause' | 'resume' | 'run_now') => {
      try {
        const res = await fetch(`/api/agent/schedules/${id}/actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        if (!res.ok) {
          const data = await res.json();
          setError(data.error ?? `schedule action failed (${res.status})`);
        }
        void refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'schedule action failed');
      }
    },
    [refresh],
  );

  const activeApprovals = approvals.length;
  const workerOk = (health?.workers ?? []).some((w) => w.staleSeconds < 60);

  return (
    <main className="min-h-screen bg-background px-4 py-6 text-slate-100 md:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight md:text-2xl">XIREL</h1>
            <p className="text-xs text-muted">AI Operating System · command center</p>
          </div>
          <nav className="flex items-center gap-3 text-xs text-muted">
            <Link className="hover:text-slate-100" href="/chat">Chat</Link>
            <Link className="hover:text-slate-100" href="/dashboard">Dashboard</Link>
            <Link className="hover:text-slate-100" href="/business">Business OS</Link>
          </nav>
        </header>

        {/* Manager status strip */}
        <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-lg border border-border bg-surface p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted">Queue</p>
            <p className="text-lg font-bold">{health?.queue.depth ?? '—'}</p>
          </div>
          <div className="rounded-lg border border-border bg-surface p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted">Active</p>
            <p className="text-lg font-bold">{health?.queue.active ?? '—'}</p>
          </div>
          <div className="rounded-lg border border-border bg-surface p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted">Worker</p>
            <p className={`text-lg font-bold ${workerOk ? 'text-emerald-400' : 'text-red-400'}`}>
              {health ? (workerOk ? 'online' : 'offline') : '—'}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-surface p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted">Paused</p>
            <p className={`text-lg font-bold ${health?.executionPaused ? 'text-orange-400' : ''}`}>
              {health ? (health.executionPaused ? 'yes' : 'no') : '—'}
            </p>
          </div>
        </div>

        {/* Composer */}
        <section className="mb-6 rounded-xl border border-border bg-surface p-4">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask Xirel — e.g. “Prepare three promotional clips for my selected project” or “Check the Soleil deployment”"
            rows={3}
            className="w-full resize-none rounded-lg border border-border bg-black/30 p-3 text-sm outline-none focus:border-primary"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={askAgent}
              disabled={busy || !prompt.trim()}
              className="rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground disabled:opacity-40"
            >
              {busy ? 'Working…' : 'Ask now'}
            </button>
            <button
              onClick={submitTask}
              disabled={busy || !prompt.trim()}
              className="rounded-lg border border-border px-4 py-2 text-xs font-bold text-slate-200 disabled:opacity-40"
            >
              Run as durable task
            </button>
            <span className="text-[10px] text-muted">durable tasks keep running after you close this page</span>
          </div>
          {runResult && (
            <div className="mt-3 rounded-lg border border-border bg-black/30 p-3 text-sm">
              <p className="whitespace-pre-wrap">{runResult.text || '(no text)'}</p>
              {runResult.runId && (
                <p className="mt-2 text-[10px] text-muted">
                  run {runResult.runId.slice(0, 8)} · {runResult.status}
                </p>
              )}
            </div>
          )}
        </section>

        {error && (
          <div className="mb-4 rounded-lg border border-red-900 bg-red-950/40 p-3 text-xs text-red-300">{error}</div>
        )}
        {notice && (
          <div className="mb-4 rounded-lg border border-emerald-900 bg-emerald-950/40 p-3 text-xs text-emerald-300">{notice}</div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Approvals first — they block work */}
          <Card title={`Approvals${activeApprovals ? ` (${activeApprovals})` : ''}`}>
            {approvals.length === 0 ? (
              <p className="text-xs text-muted">Nothing waiting for a decision.</p>
            ) : (
              <ul className="space-y-3">
                {approvals.map((a) => (
                  <li key={a.id} className="rounded-lg border border-border bg-black/20 p-3">
                    <p className="text-xs">{a.summary}</p>
                    <p className="mt-1 text-[10px] text-muted">
                      {a.toolName ? `tool: ${a.toolName} · ` : ''}{a.riskLevel ? `risk: ${a.riskLevel} · ` : ''}
                      {new Date(a.createdAt).toLocaleString()}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button onClick={() => decideApproval(a.id, 'approved')} className="rounded-md bg-emerald-800/80 px-3 py-1.5 text-[10px] font-bold">Approve</button>
                      <button onClick={() => decideApproval(a.id, 'rejected')} className="rounded-md bg-red-900/70 px-3 py-1.5 text-[10px] font-bold">Reject</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Active tasks */}
          <Card title="Active tasks">
            {jobs.length === 0 ? (
              <p className="text-xs text-muted">No durable tasks yet.</p>
            ) : (
              <ul className="space-y-2">
                {jobs.map((j) => (
                  <li key={j.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-black/20 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold">{j.title}</p>
                      <p className="text-[10px] text-muted">
                        {j.currentStep ?? '—'} · attempt {j.attemptCount}/{j.maxAttempts}
                        {j.lastError ? ` · ${j.lastError.slice(0, 80)}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Pill status={j.status} />
                      {['queued', 'retrying', 'paused'].includes(j.status) && (
                        <button onClick={() => jobAction(j.id, 'cancel')} className="text-[10px] text-red-300 hover:underline">cancel</button>
                      )}
                      {['queued', 'claimed', 'planning', 'running', 'verifying', 'retrying'].includes(j.status) && (
                        <button onClick={() => jobAction(j.id, 'pause')} className="text-[10px] text-slate-300 hover:underline">pause</button>
                      )}
                      {j.status === 'paused' && (
                        <button onClick={() => jobAction(j.id, 'resume')} className="text-[10px] text-emerald-300 hover:underline">resume</button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Execution timeline */}
          <Card title="Execution timeline">
            {runs.length === 0 ? (
              <p className="text-xs text-muted">No agent runs yet.</p>
            ) : (
              <ul className="space-y-2">
                {runs.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-black/20 p-2.5">
                    <span className="text-[10px] text-muted">run {r.id.slice(0, 8)}</span>
                    <Pill status={r.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Provider health */}
          <Card title="Provider health">
            <ul className="space-y-1.5">
              {(health?.providers ?? []).map((p) => (
                <li key={p.providerId} className="flex items-center justify-between rounded-lg border border-border bg-black/20 px-3 py-2 text-xs">
                  <span>{p.providerId}</span>
                  <span className="text-[10px] text-muted">
                    {!p.configured
                      ? 'not configured'
                      : p.cooldownRemainingMs > 0
                        ? `cooling ${Math.ceil(p.cooldownRemainingMs / 1000)}s (${p.lastErrorClass})`
                        : p.lastLatencyMs != null
                          ? `${p.lastLatencyMs}ms`
                          : 'ready'}
                  </span>
                </li>
              ))}
              {!health && <p className="text-xs text-muted">Loading…</p>}
            </ul>
          </Card>

          {/* Schedules */}
          <Card
            title="Scheduled work"
            action={
              <button onClick={() => setShowSchedules((v) => !v)} className="text-[10px] text-primary hover:underline">
                {showSchedules ? 'close' : 'new schedule'}
              </button>
            }
          >
            {showSchedules && (
              <div className="mb-3 grid gap-2 rounded-lg border border-border bg-black/20 p-3">
                <input value={scheduleForm.name} onChange={(e) => setScheduleForm((f) => ({ ...f, name: e.target.value }))} placeholder="Name (e.g. Daily monitoring)" className="rounded-md border border-border bg-black/30 px-2 py-1.5 text-xs" />
                <input value={scheduleForm.cron} onChange={(e) => setScheduleForm((f) => ({ ...f, cron: e.target.value }))} placeholder="Cron (UTC, e.g. 0 9 * * *)" className="rounded-md border border-border bg-black/30 px-2 py-1.5 text-xs" />
                <textarea value={scheduleForm.instructions} onChange={(e) => setScheduleForm((f) => ({ ...f, instructions: e.target.value }))} placeholder="What the agent should do on each fire" rows={2} className="rounded-md border border-border bg-black/30 px-2 py-1.5 text-xs" />
                <button onClick={createSchedule} disabled={busy} className="rounded-md bg-primary px-3 py-1.5 text-[10px] font-bold text-primary-foreground disabled:opacity-40">Create schedule</button>
              </div>
            )}
            {schedules.length === 0 ? (
              <p className="text-xs text-muted">No schedules.</p>
            ) : (
              <ul className="space-y-2">
                {schedules.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-black/20 p-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold">{s.name}</p>
                      <p className="text-[10px] text-muted">
                        {s.cron} · next {s.status === 'active' ? new Date(s.nextRunAt).toLocaleString() : '—'}
                        {s.failureCount > 0 ? ` · ${s.failureCount} failures` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Pill status={s.status === 'active' ? 'running' : 'paused'} />
                      <button onClick={() => scheduleAction(s.id, 'run_now')} className="text-[10px] text-primary hover:underline">run now</button>
                      {s.status === 'active' ? (
                        <button onClick={() => scheduleAction(s.id, 'pause')} className="text-[10px] text-slate-300 hover:underline">pause</button>
                      ) : (
                        <button onClick={() => scheduleAction(s.id, 'resume')} className="text-[10px] text-emerald-300 hover:underline">resume</button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Skills + artifacts (honest surfaces) */}
          <Card title="Skills & artifacts">
            <ul className="space-y-1.5 text-xs">
              <li className="flex items-center justify-between rounded-lg border border-border bg-black/20 px-3 py-2">
                <span>project_status_report</span>
                <span className="text-[10px] text-emerald-300">ready</span>
              </li>
              <li className="flex items-center justify-between rounded-lg border border-border bg-black/20 px-3 py-2">
                <span>clips_forge_video_production</span>
                <span className="text-[10px] text-orange-300">connector missing</span>
              </li>
              <li className="flex items-center justify-between rounded-lg border border-border bg-black/20 px-3 py-2">
                <span>Execution artifacts</span>
                <span className="text-[10px] text-muted">storage connector not configured</span>
              </li>
            </ul>
          </Card>
        </div>

        <footer className="mt-8 pb-6 text-center text-[10px] text-muted">
          Polling every 10s while visible · durable state lives in Supabase ·
          runs persist across restarts
        </footer>
      </div>
    </main>
  );
}
