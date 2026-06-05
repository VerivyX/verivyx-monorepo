'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Pencil, RefreshCw, Shield, Trash2, X } from 'lucide-react';
import { api, type AdminCreator } from '@/lib/api';

type EditState = {
  id: number;
  platformFee: string;
  paywallEnabled: boolean;
  confirmStep: boolean;
};

export default function CreatorsPage() {
  const [creators, setCreators] = useState<AdminCreator[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [del, setDel] = useState<AdminCreator | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { creators: data } = await api.adminCreators();
      setCreators(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function openEdit(c: AdminCreator) {
    setEdit({
      id: c.id,
      platformFee: String(c.platformFee ?? 0.001),
      paywallEnabled: c.paywallEnabled,
      confirmStep: false,
    });
    setSaveError(null);
  }

  function closeEdit() {
    setEdit(null);
    setSaveError(null);
  }

  async function handleDelete() {
    if (!del) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.adminDeleteCreator(del.id);
      const label = del.domain ?? del.email;
      setDel(null);
      showToast(`Deleted ${label}`);
      await load();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  function handleApplyClick() {
    if (!edit) return;
    const fee = Number(edit.platformFee);
    if (!Number.isFinite(fee) || fee < 0 || fee > 1) {
      setSaveError('Platform fee must be between 0 and 1');
      return;
    }
    setEdit({ ...edit, confirmStep: true });
  }

  async function confirmSave() {
    if (!edit) return;
    setSaving(true);
    setSaveError(null);
    try {
      const fee = Number(edit.platformFee);
      await api.adminUpdateCreator(edit.id, {
        platformFee: fee,
        paywallEnabled: edit.paywallEnabled,
      });
      closeEdit();
      showToast('Creator settings updated successfully');
      await load();
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Save failed');
      setEdit({ ...edit, confirmStep: false });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-ink-500)]">
        <div className="flex items-center gap-3 text-sm font-medium">
          <RefreshCw size={16} className="animate-spin" />
          Loading ecosystem…
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1200px]">
      {/* Header */}
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-3xl font-bold text-[var(--color-ink-900)] tracking-tight">
            Creator Ecosystem
          </h1>
          <p className="mt-1.5 text-sm text-[var(--color-ink-500)] font-medium">
            {creators.length} registered user{creators.length !== 1 ? 's' : ''} ·{' '}
            {creators.filter(c => c.role !== 'ADMIN').length} creator
            {creators.filter(c => c.role !== 'ADMIN').length !== 1 ? 's' : ''},{' '}
            {creators.filter(c => c.role === 'ADMIN').length} admin
            {creators.filter(c => c.role === 'ADMIN').length !== 1 ? 's' : ''}
          </p>
        </div>
        <button onClick={load} className="btn-ghost text-sm">
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>

      {/* Page-level error */}
      {error && (
        <div className="mb-8 flex items-start gap-2 rounded-xl bg-[var(--color-stellar-rose)]/10 border border-[var(--color-stellar-rose)]/20 px-4 py-3 text-sm text-[var(--color-stellar-rose)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="hover:opacity-70 transition-opacity">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Edit modal */}
      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-ink-900)]/60 backdrop-blur-sm">
          <div className="surface-card w-[420px] p-8">
            {/* Modal header */}
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-[var(--color-ink-900)] tracking-tight">
                {edit.confirmStep ? 'Confirm Changes' : 'Configure Creator'}
              </h2>
              <button
                onClick={closeEdit}
                className="flex items-center justify-center h-8 w-8 rounded-full bg-[var(--color-cream-100)] text-[var(--color-ink-500)] hover:bg-[var(--color-cream-200)] transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {edit.confirmStep ? (
              /* Confirmation step */
              <div>
                <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-4 mb-6">
                  <p className="text-sm font-semibold text-amber-800 mb-1">
                    Are you sure you want to apply these changes?
                  </p>
                  <ul className="text-sm text-amber-700 space-y-1 mt-2">
                    <li>
                      Platform fee:{' '}
                      <span className="font-mono font-bold">
                        {(Number(edit.platformFee) * 100).toFixed(2)}%
                      </span>
                    </li>
                    <li>
                      Paywall:{' '}
                      <span className="font-bold">
                        {edit.paywallEnabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </li>
                  </ul>
                </div>

                {saveError && (
                  <div className="flex items-center gap-2 rounded-xl bg-[var(--color-stellar-rose)]/10 border border-[var(--color-stellar-rose)]/20 px-4 py-3 mb-5 text-sm text-[var(--color-stellar-rose)]">
                    <AlertTriangle size={14} className="shrink-0" />
                    {saveError}
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={confirmSave}
                    disabled={saving}
                    className="btn-primary flex-1 text-sm disabled:opacity-60"
                  >
                    {saving ? (
                      <>
                        <RefreshCw size={14} className="animate-spin" /> Saving…
                      </>
                    ) : (
                      'Confirm & Apply'
                    )}
                  </button>
                  <button
                    onClick={() => setEdit({ ...edit, confirmStep: false })}
                    className="btn-ghost text-sm px-5"
                  >
                    Back
                  </button>
                </div>
              </div>
            ) : (
              /* Edit form step */
              <div>
                {/* Platform fee field */}
                <label className="block mb-5">
                  <span className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                    Platform Fee (0 – 1)
                  </span>
                  <div className="relative mt-2">
                    <input
                      type="number"
                      step="0.0001"
                      min="0"
                      max="1"
                      value={edit.platformFee}
                      onChange={(e) =>
                        setEdit({ ...edit, platformFee: e.target.value, confirmStep: false })
                      }
                      className="input-field font-mono pr-16"
                    />
                    <div className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-bold text-indigo-600 pointer-events-none">
                      {(Number(edit.platformFee) * 100).toFixed(2)}%
                    </div>
                  </div>
                </label>

                {/* Paywall toggle */}
                <label className="flex items-center gap-3 mb-6 p-4 rounded-xl bg-[var(--color-cream-50)] border border-[var(--color-cream-200)] cursor-pointer hover:bg-[var(--color-cream-100)] transition-colors">
                  <input
                    type="checkbox"
                    checked={edit.paywallEnabled}
                    onChange={(e) =>
                      setEdit({ ...edit, paywallEnabled: e.target.checked, confirmStep: false })
                    }
                    className="h-4 w-4 accent-indigo-600"
                  />
                  <span className="text-sm font-semibold text-[var(--color-ink-900)]">
                    Activate Paywall Protection
                  </span>
                </label>

                {saveError && (
                  <div className="flex items-center gap-2 rounded-xl bg-[var(--color-stellar-rose)]/10 border border-[var(--color-stellar-rose)]/20 px-4 py-3 mb-5 text-sm text-[var(--color-stellar-rose)]">
                    <AlertTriangle size={14} className="shrink-0" />
                    {saveError}
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={handleApplyClick}
                    className="btn-primary flex-1 text-sm"
                  >
                    Apply Changes
                  </button>
                  <button onClick={closeEdit} className="btn-ghost text-sm px-5">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Creator table */}
      <div className="surface-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b-2 border-[var(--color-cream-200)] text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                <th className="px-6 py-4">Domain / Email</th>
                <th className="px-4 py-4 text-right">Revenue Share</th>
                <th className="px-4 py-4 text-right">7d GMV</th>
                <th className="px-4 py-4 text-right">Bots</th>
                <th className="px-4 py-4 text-center">Status</th>
                <th className="px-6 py-4" />
              </tr>
            </thead>
            <tbody>
              {creators.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-16 text-center text-sm text-[var(--color-ink-500)] font-medium"
                  >
                    No creators found in the ecosystem.
                  </td>
                </tr>
              ) : (
                creators.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-[var(--color-cream-200)]/70 last:border-0 hover:bg-[var(--color-cream-50)] transition-colors"
                  >
                    <td className="px-6 py-5">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[var(--color-ink-900)]">{c.domain ?? '—'}</span>
                        {c.role === 'ADMIN' && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">
                            <Shield size={9} /> Admin
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[var(--color-ink-500)] mt-0.5">{c.email}</div>
                    </td>
                    <td className="px-4 py-5 text-right">
                      <div className="font-mono font-bold text-indigo-600">
                        {((c.platformFee ?? 0.001) * 100).toFixed(2)}%
                      </div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-300)] mt-0.5">
                        Platform Cut
                      </div>
                    </td>
                    <td className="px-4 py-5 text-right">
                      <div className="font-mono font-semibold text-emerald-600">
                        ${c.gmv7d.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-300)] mt-0.5">
                        {c.payments7d} Payments
                      </div>
                    </td>
                    <td className="px-4 py-5 text-right">
                      <div
                        className={`font-mono font-semibold ${
                          c.botsBlocked7d > 0 ? 'text-red-500' : 'text-[var(--color-ink-500)]'
                        }`}
                      >
                        {c.botsBlocked7d}
                      </div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-300)] mt-0.5">
                        Blocked
                      </div>
                    </td>
                    <td className="px-4 py-5 text-center">
                      {c.paywallEnabled ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
                          <CheckCircle2 size={12} />
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-medium text-red-600">
                          <X size={12} />
                          Disabled
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-5 text-right">
                      {c.role !== 'ADMIN' && (
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => openEdit(c)} className="btn-ghost text-sm">
                            <Pencil size={13} />
                            Configure
                          </button>
                          <button
                            onClick={() => { setDel(c); setDeleteError(null); }}
                            className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 transition hover:bg-red-50"
                            title="Delete creator"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Delete confirmation */}
      {del && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6" onClick={() => !deleting && setDel(null)}>
          <div className="w-full max-w-md surface-card p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-red-100 text-red-600">
                <Trash2 size={16} />
              </span>
              <h2 className="text-lg font-semibold">Delete creator</h2>
            </div>
            <p className="mt-4 text-sm text-[var(--color-ink-700)]">
              Permanently delete{' '}
              <span className="font-semibold">{del.domain ?? del.email}</span>
              {del.domain ? <span className="text-[var(--color-ink-500)]"> ({del.email})</span> : null}? This
              removes the account and all its events. This cannot be undone.
            </p>
            {deleteError && (
              <p className="mt-3 rounded-md bg-[var(--color-stellar-rose)]/10 px-3 py-2 text-sm text-[var(--color-stellar-rose)]">
                {deleteError}
              </p>
            )}
            <div className="mt-6 flex items-center justify-end gap-3">
              <button onClick={() => setDel(null)} disabled={deleting} className="btn-ghost text-sm">
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                {deleting ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-8 z-50 flex justify-center">
          <div className="pointer-events-auto rounded-full bg-[var(--color-ink-900)] px-5 py-3 text-sm font-medium text-[var(--color-stellar-yellow)] shadow-lg">
            {toast}
          </div>
        </div>
      )}
    </div>
  );
}
