import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { api } from '../lib/api';

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 45_000;

export default function KhipuReturn() {
  const [params] = useSearchParams();
  const orderIdRaw = params.get('order_id');
  const orderId = orderIdRaw ? Number(orderIdRaw) : null;
  const token = params.get('token');
  const navigate = useNavigate();
  const [message, setMessage] = useState('Verificando tu pago con Khipu…');
  const [stillPending, setStillPending] = useState(false);

  useEffect(() => {
    if (!orderId || !token) return;

    let cancelled = false;
    const start = Date.now();
    // /thanks exige el token de acceso de la orden — siempre propagarlo.
    const thanksUrl = (status: string) =>
      `/thanks/${orderId}?status=${status}&token=${encodeURIComponent(token)}`;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await api.verifyKhipu(orderId, token);
        if (cancelled) return;

        if (res.order_status === 'paid') {
          navigate(thanksUrl('paid'), { replace: true });
          return;
        }
        if (res.order_status === 'failed' || res.order_status === 'canceled') {
          navigate(thanksUrl(res.order_status), { replace: true });
          return;
        }

        if (Date.now() - start > POLL_TIMEOUT_MS) {
          setMessage(
            'Tu transferencia está en proceso. Te confirmaremos por email cuando se complete.',
          );
          setStillPending(true);
          return;
        }

        setTimeout(poll, POLL_INTERVAL_MS);
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setMessage('No pudimos verificar el pago. Si pagaste, te contactaremos por email.');
          setStillPending(true);
        }
      }
    };

    poll();
    return () => {
      cancelled = true;
    };
  }, [orderId, token, navigate]);

  if (!orderId || !token) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-24 text-center">
        <p className="text-tengu-coral">Falta order_id o token</p>
        <Link to="/" className="mt-4 inline-block text-tengu-ink hover:underline">
          ← Volver al inicio
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-6 py-24 text-center">
      {!stillPending && (
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-tengu-dark/10 border-t-tengu-ink" />
      )}
      <p className="mt-6 font-display text-xl">{message}</p>
      {stillPending && (
        <div className="mt-6 space-y-3">
          <Link
            to={`/thanks/${orderId}?token=${encodeURIComponent(token ?? '')}`}
            className="inline-block rounded-md bg-tengu-mustard px-6 py-3 text-sm font-semibold uppercase tracking-wider text-tengu-dark"
          >
            Ver pedido #{orderId}
          </Link>
          <p className="text-xs text-tengu-dark/50">Pedido #{orderId}</p>
        </div>
      )}
    </div>
  );
}
