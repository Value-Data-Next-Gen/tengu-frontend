import { Fragment, useEffect, useState } from 'react';

import { adminApi } from '../../lib/admin-api';
import { formatCLP } from '../../lib/api';
import { grindLabel } from '../../lib/grind';
import type { Order } from '../../types';

const STATUS_OPTIONS = ['pending', 'paid', 'shipped', 'delivered', 'failed', 'canceled'] as const;
type Status = (typeof STATUS_OPTIONS)[number];

const STATUS_COLOR: Record<Status, string> = {
  pending: 'bg-tengu-mustard/20 text-tengu-mustard',
  paid: 'bg-tengu-ink/15 text-tengu-ink',
  shipped: 'bg-blue-100 text-blue-700',
  delivered: 'bg-green-100 text-green-700',
  failed: 'bg-tengu-coral/15 text-tengu-coral',
  canceled: 'bg-tengu-dark/10 text-tengu-dark/60',
};

const STATUS_LABEL: Record<Status, string> = {
  pending: 'Pendiente',
  paid: 'Pagado',
  shipped: 'Enviado',
  delivered: 'Entregado',
  failed: 'Fallado',
  canceled: 'Cancelado',
};

export default function AdminOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [filter, setFilter] = useState<'all' | Status>('all');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (showSpinner: boolean) => {
      if (showSpinner) setLoading(true);
      adminApi
        .listOrders(filter === 'all' ? undefined : filter)
        .then((data) => {
          if (!cancelled) setOrders(data);
        })
        .finally(() => {
          if (showSpinner && !cancelled) setLoading(false);
        });
    };
    load(true);
    // Los pagos confirman vía webhook en background: refrescar sin spinner
    const interval = setInterval(() => load(false), 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [filter]);

  const updateOrder = async (
    id: number,
    payload: { status?: Status; tracking_code?: string; admin_notes?: string },
  ) => {
    const updated = await adminApi.updateOrder(id, payload);
    setOrders((prev) => prev.map((o) => (o.id === id ? updated : o)));
  };

  const exportCsv = async () => {
    try {
      const blob = await adminApi.downloadOrdersCsv(filter === 'all' ? undefined : filter);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pedidos-tengu${filter === 'all' ? '' : `-${filter}`}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`No se pudo exportar: ${err instanceof Error ? err.message : err}`);
    }
  };

  return (
    <div className="p-6 md:p-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl">Pedidos</h1>
          <p className="mt-1 text-sm text-tengu-dark/60">{orders.length} resultados</p>
        </div>
        <button
          onClick={exportCsv}
          disabled={orders.length === 0}
          className="rounded-md border border-tengu-ink px-4 py-2 text-xs font-semibold uppercase tracking-wider text-tengu-ink transition hover:bg-tengu-ink hover:text-white disabled:opacity-40"
        >
          ⬇ Exportar CSV
        </button>
      </header>

      <div className="mt-6 flex flex-wrap gap-2">
        {(['all', ...STATUS_OPTIONS] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-full px-4 py-1.5 text-xs uppercase tracking-wider transition ${
              filter === s ? 'bg-tengu-ink text-white' : 'bg-white hover:bg-tengu-ink/10'
            }`}
          >
            {s === 'all' ? 'Todos' : STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="mt-8 text-tengu-dark/60">Cargando…</p>
      ) : orders.length === 0 ? (
        <p className="mt-8 text-tengu-dark/60">Sin pedidos.</p>
      ) : (
        <div className="mt-6 overflow-hidden rounded-xl bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-tengu-cream/40 text-left text-xs uppercase tracking-wider text-tengu-dark/60">
              <tr>
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Total</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <Fragment key={o.id}>
                  <tr className="border-t border-tengu-dark/5">
                    <td className="px-4 py-3 font-mono">{o.id}</td>
                    <td className="px-4 py-3">
                      <p className="font-semibold">{o.customer_name}</p>
                      <p className="text-xs text-tengu-dark/60">{o.customer_email}</p>
                    </td>
                    <td className="px-4 py-3 font-semibold">{formatCLP(o.total_clp)}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs uppercase tracking-wider ${STATUS_COLOR[o.status as Status] ?? ''}`}>
                        {STATUS_LABEL[o.status as Status] ?? o.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-tengu-dark/60">
                      {new Date(o.created_at).toLocaleString('es-CL')}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setExpanded(expanded === o.id ? null : o.id)}
                        className="text-xs uppercase tracking-wider text-tengu-ink hover:underline"
                      >
                        {expanded === o.id ? 'Cerrar' : 'Detalle'}
                      </button>
                    </td>
                  </tr>
                  {expanded === o.id && (
                    <tr className="bg-tengu-cream/30">
                      <td colSpan={6} className="px-4 py-5">
                        <OrderDetail order={o} onUpdate={(payload) => updateOrder(o.id, payload)} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function OrderDetail({
  order,
  onUpdate,
}: {
  order: Order;
  onUpdate: (payload: { status?: Status; tracking_code?: string; admin_notes?: string }) => Promise<void>;
}) {
  const [tracking, setTracking] = useState(order.tracking_code ?? '');
  const [notes, setNotes] = useState(order.admin_notes ?? '');
  const [notesStatus, setNotesStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const saveNotes = async () => {
    setNotesStatus('saving');
    try {
      await onUpdate({ admin_notes: notes });
      setNotesStatus('saved');
    } catch (err) {
      setNotesStatus('error');
      alert(`No se pudo guardar la nota: ${err instanceof Error ? err.message : err}`);
    }
  };

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div>
        <p className="text-xs uppercase tracking-wider text-tengu-dark/60">Items</p>
        <ul className="mt-2 divide-y divide-tengu-dark/10 text-sm">
          {order.items.map((it) => (
            <li key={it.id} className="flex justify-between py-1.5">
              <span>
                {it.product_name} · {it.size_g >= 1000 ? `${it.size_g / 1000} kg` : `${it.size_g} g`} × {it.quantity}
                <span className="ml-2 rounded bg-tengu-mustard/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-tengu-dark">
                  {grindLabel(it.grind)}
                </span>
              </span>
              <span className="font-semibold">{formatCLP(it.subtotal_clp)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-4 space-y-1 text-sm">
          <div className="flex justify-between"><dt className="text-tengu-dark/60">Subtotal</dt><dd>{formatCLP(order.subtotal_clp)}</dd></div>
          <div className="flex justify-between"><dt className="text-tengu-dark/60">Envío ({order.shipping_method === 'pickup' ? 'retiro' : 'despacho'})</dt><dd>{formatCLP(order.shipping_cost_clp)}</dd></div>
          <div className="flex justify-between border-t border-tengu-dark/10 pt-1 font-semibold"><dt>Total</dt><dd className="text-tengu-ink">{formatCLP(order.total_clp)}</dd></div>
        </dl>
      </div>

      <div className="space-y-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-tengu-dark/60">Despacho</p>
          {order.shipping_method === 'pickup' ? (
            <p className="mt-1 text-sm">Retiro en local</p>
          ) : (
            <p className="mt-1 text-sm">
              {order.shipping_address}<br />
              {order.shipping_comuna}, {order.shipping_region}<br />
              <span className="text-tengu-dark/60">{order.customer_phone}</span>
            </p>
          )}
        </div>

        <div>
          <p className="text-xs uppercase tracking-wider text-tengu-dark/60">Cambiar estado</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {STATUS_OPTIONS.map((s) => (
              <button
                key={s}
                onClick={() => onUpdate({ status: s }).catch((err) => alert(`Error: ${err}`))}
                disabled={order.status === s}
                className={`rounded-md border px-3 py-1 text-xs uppercase tracking-wider transition ${
                  order.status === s
                    ? 'border-tengu-ink bg-tengu-ink text-white'
                    : 'border-tengu-dark/15 hover:border-tengu-ink'
                }`}
              >
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wider text-tengu-dark/60">Código de seguimiento</label>
          <div className="mt-1 flex gap-2">
            <input
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
              className="flex-1 rounded-md border border-tengu-dark/15 px-3 py-1.5 text-sm"
              placeholder="ej: CHX1234567"
            />
            <button
              onClick={() => onUpdate({ tracking_code: tracking }).catch((err) => alert(`Error: ${err}`))}
              className="rounded-md bg-tengu-ink px-3 py-1.5 text-xs uppercase tracking-wider text-white"
            >
              Guardar
            </button>
          </div>
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wider text-tengu-dark/60">Notas internas</label>
          <textarea
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
              setNotesStatus('idle');
            }}
            rows={2}
            className="mt-1 w-full rounded-md border border-tengu-dark/15 px-3 py-1.5 text-sm"
          />
          <div className="mt-1 flex items-center gap-3">
            <button
              onClick={saveNotes}
              disabled={notesStatus === 'saving' || notes === (order.admin_notes ?? '')}
              className="rounded-md bg-tengu-ink px-3 py-1.5 text-xs uppercase tracking-wider text-white disabled:opacity-40"
            >
              {notesStatus === 'saving' ? 'Guardando…' : 'Guardar nota'}
            </button>
            {notesStatus === 'saved' && <span className="text-xs text-green-700">Guardada ✓</span>}
            {notesStatus === 'error' && <span className="text-xs text-tengu-coral">Error al guardar</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
