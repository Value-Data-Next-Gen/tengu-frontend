import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { ecommerceEvents } from '../lib/analytics';
import { api, formatCLP, formatSize } from '../lib/api';
import { grindLabel } from '../lib/grind';
import { useCart } from '../store/cart';
import type { Order } from '../types';
import { PENDING_ORDER_KEY } from './Checkout';

const STATUS_COPY = {
  paid: {
    title: '¡Gracias por tu compra!',
    body: 'Tu pago fue confirmado. Te enviamos un email con los detalles.',
    color: 'text-tengu-ink',
  },
  pending: {
    title: 'Estamos procesando tu pedido',
    body: 'Confirmaremos por email cuando esté listo.',
    color: 'text-tengu-mustard',
  },
  failed: {
    title: 'Tu pago no se pudo procesar',
    body: 'No se realizó cargo. Puedes intentar de nuevo o usar otro medio.',
    color: 'text-tengu-coral',
  },
  canceled: {
    title: 'Cancelaste el pago',
    body: 'No se realizó cargo. Tu carrito sigue intacto si quieres volver.',
    color: 'text-tengu-coral',
  },
  pending_transfer: {
    title: 'Pedido creado · falta pagar',
    body: 'Termina tu compra en BanchilePagos. Cuando recibamos el comprobante despachamos.',
    color: 'text-tengu-mustard',
  },
};

const BANCHILE_URL = 'https://micrositios.banchilepagos.cl/roastery_2565';
const WHATSAPP_URL = 'https://wa.me/56950013366';

export default function Thanks() {
  const { orderId } = useParams<{ orderId: string }>();
  const [params] = useSearchParams();
  const queryStatus = params.get('status');
  const token = params.get('token');
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const clearCart = useCart((s) => s.clear);

  useEffect(() => {
    if (!orderId || !token) {
      setError('Falta el token de acceso a la orden.');
      setLoading(false);
      return;
    }

    let cancelled = false;
    const start = Date.now();
    const POLL_INTERVAL_MS = 3000;
    const POLL_TIMEOUT_MS = 45_000;

    const fetchOrder = async () => {
      try {
        let o = await api.getOrder(Number(orderId), token);
        // Si el cliente vuelve de MP/Khipu antes que llegue el webhook al
        // backend, la orden queda pending. Verificamos contra el gateway para
        // forzar la actualización y seguimos sondeando hasta 45s (el webhook
        // puede tardar unos segundos). Si sigue pending, copy "procesando".
        if (o.status === 'pending') {
          if (o.payment_method === 'mercadopago') {
            await api.verifyMercadoPago(Number(orderId), token).catch(() => undefined);
            o = await api.getOrder(Number(orderId), token);
          } else if (o.payment_method === 'khipu') {
            await api.verifyKhipu(Number(orderId), token).catch(() => undefined);
            o = await api.getOrder(Number(orderId), token);
          }
        }
        if (cancelled) return;
        setOrder(o);
        if (o.status === 'paid') {
          clearCart();
          try {
            sessionStorage.removeItem(PENDING_ORDER_KEY);
          } catch {
            /* ignore */
          }
          ecommerceEvents.purchase(
            o.id,
            o.items.map((i) => ({
              item_id: i.product_slug,
              item_name: i.product_name,
              item_variant: `${i.size_g}g`,
              price: i.unit_price_clp,
              quantity: i.quantity,
            })),
            o.total_clp,
          );
        } else if (
          o.status === 'pending' &&
          (o.payment_method === 'mercadopago' || o.payment_method === 'khipu') &&
          Date.now() - start < POLL_TIMEOUT_MS
        ) {
          setTimeout(fetchOrder, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchOrder();
    return () => {
      cancelled = true;
    };
  }, [orderId, token, clearCart]);

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-24 text-center">
        <p className="text-tengu-dark/60">Cargando tu pedido…</p>
      </div>
    );
  }
  if (error || !order) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-24 text-center">
        <h1 className="font-display text-3xl text-tengu-coral">No encontramos esa orden</h1>
        <p className="mt-3 text-tengu-dark/60">{error}</p>
        <Link to="/tienda" className="mt-6 inline-block text-tengu-ink hover:underline">← Volver a la tienda</Link>
      </div>
    );
  }

  // `order.payment_method` es la fuente de verdad (server-side). El query
  // param solo se honra si el server lo confirma.
  const isBankTransfer = order.payment_method === 'bank_transfer';

  // Status mostrado al usuario: SIEMPRE deriva de `order.status` (lo que el
  // backend dice). El queryStatus puede agregar contexto (canceled/failed
  // venidos de Webpay return) pero nunca puede "promover" una orden pending
  // a paid — ese flip lo decide el backend tras validar el pago.
  let effectiveStatus: keyof typeof STATUS_COPY;
  if (order.status === 'paid') {
    effectiveStatus = 'paid';
  } else if (order.status === 'failed' || queryStatus === 'failed') {
    effectiveStatus = 'failed';
  } else if (queryStatus === 'canceled') {
    effectiveStatus = 'canceled';
  } else if (isBankTransfer && order.status === 'pending') {
    effectiveStatus = 'pending_transfer';
  } else {
    effectiveStatus = 'pending';
  }
  const copy = STATUS_COPY[effectiveStatus];

  return (
    <section className="mx-auto max-w-3xl px-6 py-16">
      <p className="text-xs uppercase tracking-[0.3em] text-tengu-dark/50">Pedido #{order.id}</p>
      <h1 className={`mt-3 font-display text-4xl ${copy.color}`}>{copy.title}</h1>
      <p className="mt-2 text-tengu-dark/70">{copy.body}</p>

      {order.status === 'paid' && order.webpay_authorization_code && (
        <p className="mt-3 text-xs text-tengu-dark/50">
          Código de autorización Webpay: <code className="font-mono">{order.webpay_authorization_code}</code>
        </p>
      )}

      {effectiveStatus === 'pending_transfer' && (
        <div className="mt-8 rounded-xl border-2 border-tengu-ink/20 bg-white p-6 shadow-sm">
          <h2 className="font-display text-xl text-tengu-ink">Cómo terminar tu pago</h2>
          <ol className="mt-4 space-y-3 text-sm">
            <li className="flex gap-3">
              <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-tengu-ink text-xs font-bold text-white">1</span>
              <div>
                Abre <strong>BanchilePagos</strong> y paga el total{' '}
                <strong className="font-display text-tengu-ink">{formatCLP(order.total_clp)}</strong>.
                Indica como referencia tu pedido <code className="font-mono">#{order.id}</code>.
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-tengu-ink text-xs font-bold text-white">2</span>
              <div>Mándanos el comprobante por WhatsApp para confirmar.</div>
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-tengu-ink text-xs font-bold text-white">3</span>
              <div>Despachamos en 1-2 días hábiles tras confirmar el pago.</div>
            </li>
          </ol>

          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href={BANCHILE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 rounded-md bg-tengu-ink px-5 py-3 text-center text-sm font-semibold uppercase tracking-wider text-white transition hover:bg-tengu-mustard hover:text-tengu-dark"
            >
              Pagar ahora con BanchilePagos →
            </a>
            <a
              href={`${WHATSAPP_URL}?text=${encodeURIComponent(`Hola, adjunto comprobante del pedido #${order.id} (${formatCLP(order.total_clp)})`)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-tengu-ink px-5 py-3 text-center text-sm font-semibold uppercase tracking-wider text-tengu-ink transition hover:bg-tengu-ink hover:text-white"
            >
              Enviar comprobante
            </a>
          </div>
        </div>
      )}

      <div className="mt-10 rounded-xl bg-white p-6 shadow-sm">
        <h2 className="font-display text-lg">Resumen</h2>
        <ul className="mt-4 divide-y divide-tengu-dark/10">
          {order.items.map((item) => (
            <li key={item.id} className="flex justify-between py-3 text-sm">
              <span className="flex-1">
                {item.product_name}
                <span className="ml-2 text-xs text-tengu-dark/60">
                  {formatSize(item.size_g)} · {item.quantity}x · {grindLabel(item.grind)}
                </span>
              </span>
              <span className="font-semibold">{formatCLP(item.subtotal_clp)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-4 space-y-2 border-t border-tengu-dark/10 pt-4 text-sm">
          <div className="flex justify-between">
            <dt>Subtotal</dt>
            <dd>{formatCLP(order.subtotal_clp)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Envío</dt>
            <dd>{order.shipping_cost_clp === 0 ? 'Gratis' : formatCLP(order.shipping_cost_clp)}</dd>
          </div>
          <div className="flex justify-between border-t border-tengu-dark/10 pt-2 font-semibold">
            <dt>Total</dt>
            <dd className="font-display text-tengu-ink">{formatCLP(order.total_clp)}</dd>
          </div>
        </dl>
      </div>

      <div className="mt-6 grid gap-4 rounded-xl bg-white p-6 shadow-sm sm:grid-cols-2 sm:text-sm">
        <div>
          <p className="text-xs uppercase tracking-wider text-tengu-dark/60">Cliente</p>
          <p className="mt-1">{order.customer_name}</p>
          <p className="text-tengu-dark/70">{order.customer_email}</p>
          <p className="text-tengu-dark/70">{order.customer_phone}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wider text-tengu-dark/60">Despacho</p>
          {order.shipping_method === 'pickup' ? (
            <p className="mt-1">Retiro en local — coordinaremos por WhatsApp</p>
          ) : (
            <>
              <p className="mt-1">{order.shipping_address}</p>
              <p className="text-tengu-dark/70">{order.shipping_comuna}, {order.shipping_region}</p>
            </>
          )}
        </div>
      </div>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          to="/tienda"
          className="rounded-md bg-tengu-ink px-6 py-3 text-sm font-semibold uppercase tracking-wider text-white transition hover:bg-tengu-mustard hover:text-tengu-dark"
        >
          Seguir comprando
        </Link>
        {(effectiveStatus === 'failed' || effectiveStatus === 'canceled') && (
          <Link
            to="/carrito"
            className="rounded-md border border-tengu-dark/20 px-6 py-3 text-sm font-semibold uppercase tracking-wider text-tengu-dark transition hover:border-tengu-ink"
          >
            Volver al carrito
          </Link>
        )}
      </div>
    </section>
  );
}
