import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { ecommerceEvents } from '../lib/analytics';
import { api, formatCLP, formatSize } from '../lib/api';
import { validateRut } from '../lib/rut';
import { useRevalidationTick } from '../lib/useRevalidateOnFocus';
import { useAuth } from '../store/auth';
import { selectCartSubtotal, useCart } from '../store/cart';
import type { CouponPreview, ShippingMethod, ShippingMode, ShippingQuote, SiteSettings } from '../types';

const PREFILL_KEY = 'tengu-checkout-prefill-v1';
// Orden pending ya creada en este flujo de checkout. Si el cliente vuelve
// atrás desde la pasarela y reintenta con el mismo carrito/datos/método,
// reusamos esa orden en vez de crear otra (cada createOrder reserva stock).
export const PENDING_ORDER_KEY = 'tengu-pending-order-v1';

type PrefillForm = {
  customer_email: string;
  customer_name: string;
  customer_phone: string;
  customer_rut: string;
  shipping_address: string;
  shipping_comuna: string;
  shipping_region: string;
  shipping_notes: string;
};

const EMPTY_FORM: PrefillForm = {
  customer_email: '',
  customer_name: '',
  customer_phone: '',
  customer_rut: '',
  shipping_address: '',
  shipping_comuna: '',
  shipping_region: 'Región Metropolitana',
  shipping_notes: '',
};

function loadLocalPrefill(): PrefillForm {
  try {
    const raw = localStorage.getItem(PREFILL_KEY);
    if (!raw) return EMPTY_FORM;
    return { ...EMPTY_FORM, ...(JSON.parse(raw) as Partial<PrefillForm>) };
  } catch {
    return EMPTY_FORM;
  }
}

type ShippingOption = {
  key: string;
  method: ShippingMethod;
  mode: ShippingMode | null;
  label: string;
  help: string;
};

// 'rm' lo usamos como "delivery" (legacy del enum). El backend acepta rm/regiones/pickup;
// el método real lo distingue shipping_mode + region.
const SHIPPING_OPTIONS: ShippingOption[] = [
  {
    key: 'delivery-home',
    method: 'rm',
    mode: 'domicilio',
    label: 'Despacho a domicilio',
    help: 'Blue Express a tu puerta. 2-5 días hábiles.',
  },
  {
    key: 'delivery-point',
    method: 'rm',
    mode: 'punto',
    label: 'Punto Blue Express',
    help: 'Retira en Estación Copec / Punto Blue. Más económico.',
  },
  {
    key: 'pickup',
    method: 'pickup',
    mode: null,
    label: 'Retiro en Rancagua',
    help: 'Coordinamos por WhatsApp. Gratis.',
  },
];

type RegionTree = { name: string; comunas: string[] };

export default function Checkout() {
  const items = useCart((s) => s.items);
  const subtotal = useCart(selectCartSubtotal);
  const navigate = useNavigate();
  const jwt = useAuth((s) => s.jwt);
  const customer = useAuth((s) => s.customer);

  const [optionKey, setOptionKey] = useState<string>('delivery-home');
  const [form, setForm] = useState<PrefillForm>(() => loadLocalPrefill());
  const [siteSettings, setSiteSettings] = useState<SiteSettings | null>(null);
  const [regions, setRegions] = useState<RegionTree[]>([]);
  const [quote, setQuote] = useState<ShippingQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [submitting, setSubmitting] = useState<null | 'webpay' | 'khipu' | 'bank_transfer' | 'mercadopago'>(null);
  const [error, setError] = useState<string | null>(null);
  const [couponInput, setCouponInput] = useState('');
  const [coupon, setCoupon] = useState<CouponPreview | null>(null);
  const [couponLoading, setCouponLoading] = useState(false);
  const [webpay, setWebpay] = useState<{ url: string; token: string } | null>(null);

  const formRef = useRef<HTMLFormElement>(null);
  const inFlightRef = useRef<boolean>(false);
  const honeypotRef = useRef<HTMLInputElement>(null);

  const reconcile = useCart((s) => s.reconcile);
  const tick = useRevalidationTick();

  // Site settings (umbral envío gratis, etc.) + reconcilia carrito contra
  // precios/stock actuales. `tick` fuerza refetch al volver del admin o al
  // recuperar foco — crítico para que un cambio de precio en /admin no
  // pague el precio viejo si el usuario quedó en /checkout abierto.
  useEffect(() => {
    api.getSiteSettings().then(setSiteSettings).catch(() => undefined);
    api.listRegions().then(setRegions).catch(() => undefined);
    api.listProducts().then((fresh) => reconcile(fresh)).catch(() => undefined);
  }, [reconcile, tick]);

  // Carrito abandonado: cuando el cliente escribió email válido y hay items,
  // mandamos un beacon al backend (debounced) para que aparezca en /admin/carritos.
  // Si después completa la orden, el backend lo marca recovered solo.
  useEffect(() => {
    const email = form.customer_email.trim().toLowerCase();
    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailValid || items.length === 0) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      if (ctl.signal.aborted) return;
      api
        .registerCartEvent({
          customer_email: email,
          customer_name: form.customer_name.trim() || undefined,
          customer_phone: form.customer_phone.trim() || undefined,
          items: items.map((i) => ({
            product_slug: i.productSlug,
            product_name: i.productName,
            size_g: i.sizeG,
            unit_price_clp: i.unitPriceClp,
            quantity: i.quantity,
            grind: i.grind,
          })),
          subtotal_clp: subtotal,
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      ctl.abort();
      clearTimeout(t);
    };
  }, [form.customer_email, form.customer_name, form.customer_phone, items, subtotal]);

  // Comunas de la región seleccionada (relación padre-hijo).
  const comunasOfRegion = useMemo(() => {
    const r = regions.find((x) => x.name === form.shipping_region);
    return r?.comunas ?? [];
  }, [regions, form.shipping_region]);

  // Si la comuna actual no pertenece a la región seleccionada, la limpiamos
  // (típico cuando el usuario cambia de región o el prefill trae una comuna huérfana).
  useEffect(() => {
    if (!regions.length) return;
    if (form.shipping_comuna && !comunasOfRegion.includes(form.shipping_comuna)) {
      setForm((f) => ({ ...f, shipping_comuna: '' }));
    }
  }, [regions, comunasOfRegion, form.shipping_comuna]);

  // Prefill desde sesión
  useEffect(() => {
    if (!jwt) return;
    api
      .getMe(jwt)
      .then((me) => {
        setForm((f) => ({
          ...f,
          customer_email: me.email,
          customer_name: me.name ?? f.customer_name,
          customer_phone: me.phone ?? f.customer_phone,
          customer_rut: me.rut ?? f.customer_rut,
          shipping_address: me.shipping_address ?? f.shipping_address,
          shipping_comuna: me.shipping_comuna ?? f.shipping_comuna,
          shipping_region: me.shipping_region ?? f.shipping_region,
          shipping_notes: me.shipping_notes ?? f.shipping_notes,
        }));
      })
      .catch(() => undefined);
  }, [jwt]);

  // Prefill desde customer en store
  useEffect(() => {
    if (!customer) return;
    setForm((f) => ({
      customer_email: customer.email || f.customer_email,
      customer_name: customer.name || f.customer_name,
      customer_phone: customer.phone || f.customer_phone,
      customer_rut: customer.rut || f.customer_rut,
      shipping_address: customer.shipping_address || f.shipping_address,
      shipping_comuna: customer.shipping_comuna || f.shipping_comuna,
      shipping_region: customer.shipping_region || f.shipping_region,
      shipping_notes: customer.shipping_notes || f.shipping_notes,
    }));
  }, [customer]);

  const selectedOption = useMemo(
    () => SHIPPING_OPTIONS.find((o) => o.key === optionKey) ?? SHIPPING_OPTIONS[0],
    [optionKey],
  );

  const cartWeightG = useMemo(
    () => items.reduce((sum, i) => sum + i.sizeG * i.quantity, 0),
    [items],
  );

  // Cotiza shipping cada vez que cambian inputs relevantes (debounced).
  useEffect(() => {
    if (selectedOption.method === 'pickup') {
      setQuote({ cost_clp: 0, zone: '-', size_band: '-', is_free: true, reason: 'Retiro en local' });
      return;
    }
    if (!form.shipping_region || !form.shipping_comuna.trim() || cartWeightG === 0) {
      setQuote(null);
      return;
    }
    setQuoting(true);
    setQuoteError(null);
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api
        .quoteShipping({
          region: form.shipping_region,
          comuna: form.shipping_comuna.trim(),
          weight_g: cartWeightG,
          mode: selectedOption.mode ?? 'domicilio',
          subtotal_clp: subtotal,
        })
        .then((q) => {
          if (ctl.signal.aborted) return;
          setQuote(q);
          setQuoteError(null);
        })
        .catch((err) => {
          if (ctl.signal.aborted) return;
          setQuote(null);
          const msg = err instanceof Error ? err.message : '';
          setQuoteError(msg || 'No pudimos calcular el envío para esta comuna.');
        })
        .finally(() => !ctl.signal.aborted && setQuoting(false));
    }, 350);
    return () => {
      ctl.abort();
      clearTimeout(t);
    };
  }, [selectedOption, form.shipping_region, form.shipping_comuna, cartWeightG, subtotal]);

  const shippingCost = quote?.cost_clp ?? 0;
  const couponDiscount = coupon?.valid ? coupon.discount_clp : 0;
  const total = Math.max(0, subtotal - couponDiscount) + shippingCost;

  const applyCoupon = async () => {
    const code = couponInput.trim();
    if (!code) return;
    setCouponLoading(true);
    setError(null);
    try {
      const preview = await api.validateCoupon({
        code,
        subtotal_clp: subtotal,
        items: items.map((i) => ({
          product_slug: i.productSlug,
          subtotal_clp: i.unitPriceClp * i.quantity,
        })),
      });
      setCoupon(preview);
    } catch (err) {
      setCoupon({
        valid: false,
        code: code.toUpperCase(),
        discount_clp: 0,
        kind: null,
        value: null,
        message: err instanceof Error ? err.message : 'Error validando código',
        description: null,
      });
    } finally {
      setCouponLoading(false);
    }
  };

  const clearCoupon = () => {
    setCoupon(null);
    setCouponInput('');
  };

  // Re-valida si cambia el subtotal (el cupón puede pasar a no cumplir min_subtotal_clp)
  useEffect(() => {
    if (!coupon?.valid) return;
    const code = coupon.code;
    api
      .validateCoupon({
        code,
        subtotal_clp: subtotal,
        items: items.map((i) => ({
          product_slug: i.productSlug,
          subtotal_clp: i.unitPriceClp * i.quantity,
        })),
      })
      .then(setCoupon)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtotal]);
  const freeShippingThreshold = siteSettings?.free_shipping_threshold_clp ?? 0;
  const remainingForFreeShipping = freeShippingThreshold > 0 ? freeShippingThreshold - subtotal : 0;

  useEffect(() => {
    if (webpay && formRef.current) formRef.current.submit();
  }, [webpay]);

  if (items.length === 0 && !submitting && !webpay) {
    return <Navigate to="/carrito" replace />;
  }

  const update = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const validateForm = (): boolean => {
    if (!form.customer_email || !form.customer_name || !form.customer_phone || !form.customer_rut) {
      setError('Completa todos los datos de contacto.');
      return false;
    }
    if (!validateRut(form.customer_rut)) {
      setError('El RUT no es válido. Verifica el dígito verificador.');
      return false;
    }
    if (selectedOption.method !== 'pickup' && (!form.shipping_address?.trim() || !form.shipping_comuna?.trim())) {
      setError('Completa la dirección y comuna del despacho.');
      return false;
    }
    return true;
  };

  const handlePayment = async (method: 'webpay' | 'khipu' | 'bank_transfer' | 'mercadopago') => {
    // Guard contra doble-click: incluso si React no re-renderea el botón a
    // tiempo, el ref bloquea el segundo click sincrónico.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    if (!validateForm()) {
      inFlightRef.current = false;
      return;
    }
    setSubmitting(method);
    ecommerceEvents.beginCheckout(
      items.map((i) => ({
        item_id: i.productSlug,
        item_name: i.productName,
        item_variant: `${i.sizeG}g`,
        price: i.unitPriceClp,
        quantity: i.quantity,
      })),
      total,
    );
    try {
      try {
        localStorage.setItem(PREFILL_KEY, JSON.stringify({ ...form, shipping_notes: '' }));
      } catch {
        /* localStorage lleno o desactivado: ignorar */
      }

      const orderPayload = {
        customer_email: form.customer_email.trim(),
        customer_name: form.customer_name.trim(),
        customer_phone: form.customer_phone.trim(),
        customer_rut: form.customer_rut.trim(),
        shipping_method: selectedOption.method,
        shipping_mode: selectedOption.mode ?? undefined,
        shipping_address: selectedOption.method !== 'pickup' ? form.shipping_address.trim() : undefined,
        shipping_comuna: selectedOption.method !== 'pickup' ? form.shipping_comuna.trim() : undefined,
        shipping_region: selectedOption.method !== 'pickup' ? form.shipping_region : undefined,
        shipping_notes: form.shipping_notes.trim() || undefined,
        payment_method: method,
        // Honeypot: el input #website es invisible y los humanos nunca lo
        // tocan; si llega lleno, el backend rechaza con 422.
        website: honeypotRef.current?.value || undefined,
        coupon_code: coupon?.valid ? coupon.code : undefined,
        items: items.map((i) => ({
          product_slug: i.productSlug,
          size_g: i.sizeG,
          quantity: i.quantity,
          grind: i.grind,
        })),
      };

      // Reusar la orden pending previa si el pedido es idéntico (mismo
      // carrito, datos y método): evita órdenes duplicadas reservando stock
      // cuando el cliente vuelve atrás desde la pasarela y reintenta.
      const orderHash = JSON.stringify([
        orderPayload.items, orderPayload.coupon_code, orderPayload.payment_method,
        orderPayload.shipping_method, orderPayload.shipping_mode, orderPayload.shipping_address,
        orderPayload.shipping_comuna, orderPayload.shipping_region, orderPayload.customer_email,
      ]);
      let order: Awaited<ReturnType<typeof api.createOrder>> | null = null;
      try {
        const raw = sessionStorage.getItem(PENDING_ORDER_KEY);
        const stored = raw ? (JSON.parse(raw) as { id: number; token: string; hash: string }) : null;
        if (stored && stored.hash === orderHash && stored.token) {
          const existing = await api.getOrder(stored.id, stored.token);
          if (existing.status === 'pending') {
            order = { ...existing, access_token: stored.token };
          }
        }
      } catch {
        /* orden previa no recuperable: crear una nueva */
      }
      if (!order) {
        order = await api.createOrder(orderPayload);
        try {
          sessionStorage.setItem(
            PENDING_ORDER_KEY,
            JSON.stringify({ id: order.id, token: order.access_token, hash: orderHash }),
          );
        } catch {
          /* sessionStorage desactivado: seguir sin reuso */
        }
      }

      if (order.total_clp === 0) {
        // Cupón 100%: el backend ya la marcó pagada — no hay nada que cobrar
        // y las pasarelas rechazan montos 0.
        inFlightRef.current = false;
        navigate(`/thanks/${order.id}?status=paid&token=${order.access_token}`);
      } else if (method === 'webpay') {
        const init = await api.initWebpay(order.id);
        setWebpay({ url: init.url, token: init.token });
      } else if (method === 'khipu') {
        const init = await api.initKhipu(order.id);
        const target = init.simplified_transfer_url || init.payment_url;
        if (!target) throw new Error('Khipu no devolvió URL de pago');
        // Liberamos el guard ANTES del redirect. Si el browser cancela el
        // redirect (popup blocker, back button, red caída) y el componente
        // sigue montado, el usuario puede reintentar sin quedar bloqueado.
        inFlightRef.current = false;
        window.location.href = target;
      } else if (method === 'mercadopago') {
        const init = await api.initMercadoPago(order.id);
        if (!init.init_point) throw new Error('Mercado Pago no devolvió URL de pago');
        inFlightRef.current = false;
        window.location.href = init.init_point;
      } else {
        navigate(`/thanks/${order.id}?method=bank_transfer&token=${order.access_token}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(null);
      inFlightRef.current = false;
    }
  };

  if (webpay) {
    return (
      <div className="mx-auto max-w-md px-6 py-24 text-center">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-tengu-dark/10 border-t-tengu-ink" />
        <p className="mt-6 font-display text-xl">Te estamos llevando a Webpay…</p>
        <p className="mt-2 text-sm text-tengu-dark/60">
          Si no se redirige automáticamente, no cierres esta pestaña.
        </p>
        <form ref={formRef} method="POST" action={webpay.url} className="hidden">
          <input type="hidden" name="token_ws" value={webpay.token} />
        </form>
      </div>
    );
  }

  return (
    <section className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="font-display text-3xl">Checkout</h1>
      <p className="mt-1 text-sm text-tengu-dark/60">
        Aceptamos <strong>BanchilePagos</strong> y <strong>Mercado Pago</strong>. Webpay y Khipu llegan pronto.
      </p>

      {freeShippingThreshold > 0 && (
        <div
          className={`mt-3 rounded-md px-4 py-2 text-sm ${
            remainingForFreeShipping <= 0
              ? 'bg-tengu-ink text-white'
              : 'bg-tengu-mustard/20 text-tengu-dark'
          }`}
        >
          {remainingForFreeShipping <= 0
            ? `🎉 Envío gratis por superar ${formatCLP(freeShippingThreshold)}`
            : `Te faltan ${formatCLP(remainingForFreeShipping)} para envío gratis.`}
        </div>
      )}

      <div className="mt-8 grid gap-10 md:grid-cols-[1fr_360px]">
        <div className="space-y-8">
          <fieldset className="rounded-xl bg-white p-6 shadow-sm">
            <legend className="px-2 font-display text-lg">Datos de contacto</legend>
            <div className="mt-2 grid gap-4 sm:grid-cols-2">
              <FormField label="Nombre completo" required>
                <input
                  type="text"
                  required
                  value={form.customer_name}
                  onChange={update('customer_name')}
                  className={inputClass}
                />
              </FormField>
              {/* Honeypot anti-bot: invisible para humanos (sr-only + tabindex=-1
                  + autocomplete=off). Bots que llenan todos los inputs lo
                  completan y el backend rechaza con 422. */}
              <input
                ref={honeypotRef}
                type="text"
                name="website"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
                defaultValue=""
              />
              <FormField label="Email" required>
                <input
                  type="email"
                  required
                  value={form.customer_email}
                  onChange={update('customer_email')}
                  className={inputClass}
                />
                <p className="mt-1 text-[11px] leading-tight text-tengu-dark/50">
                  Si dejás la compra sin terminar, podríamos escribirte una vez para ayudarte a finalizarla. Nada más.
                </p>
              </FormField>
              <FormField label="Teléfono móvil" required>
                <input
                  type="tel"
                  required
                  inputMode="tel"
                  autoComplete="tel"
                  value={form.customer_phone}
                  onChange={update('customer_phone')}
                  placeholder="+56 9 1234 5678"
                  pattern="^(\+?56\s?)?9\s?\d{4}\s?\d{4}$"
                  title="Formato móvil chileno: +56 9 XXXX XXXX"
                  className={inputClass}
                />
              </FormField>
              <FormField label="RUT" required>
                <input
                  type="text"
                  required
                  value={form.customer_rut}
                  onChange={update('customer_rut')}
                  placeholder="11.111.111-1"
                  className={inputClass}
                />
              </FormField>
            </div>
          </fieldset>

          <fieldset className="rounded-xl bg-white p-6 shadow-sm">
            <legend className="px-2 font-display text-lg">Envío</legend>
            <div className="mt-2 space-y-2">
              {SHIPPING_OPTIONS.map((opt) => (
                <label
                  key={opt.key}
                  className={`flex cursor-pointer items-center justify-between rounded-md border p-4 transition ${
                    optionKey === opt.key
                      ? 'border-tengu-ink bg-tengu-ink/5'
                      : 'border-tengu-dark/15 hover:border-tengu-ink/40'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="radio"
                      name="shipping"
                      value={opt.key}
                      checked={optionKey === opt.key}
                      onChange={() => setOptionKey(opt.key)}
                      className="accent-tengu-ink"
                    />
                    <div>
                      <p className="text-sm font-semibold">{opt.label}</p>
                      <p className="text-xs text-tengu-dark/60">{opt.help}</p>
                    </div>
                  </div>
                  {opt.method === 'pickup' && (
                    <span className="text-sm font-semibold">Gratis</span>
                  )}
                </label>
              ))}
            </div>

            {selectedOption.method !== 'pickup' && (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <FormField label="Dirección" required>
                    <input
                      type="text"
                      required
                      value={form.shipping_address}
                      onChange={update('shipping_address')}
                      placeholder="Av. Providencia 1234, dpto 56"
                      className={inputClass}
                    />
                  </FormField>
                </div>
                <FormField label="Región" required>
                  <select
                    required
                    value={form.shipping_region}
                    onChange={update('shipping_region')}
                    className={inputClass}
                  >
                    {regions.length === 0 && (
                      <option value={form.shipping_region}>{form.shipping_region}</option>
                    )}
                    {regions.map((r) => (
                      <option key={r.name} value={r.name}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Comuna" required>
                  <select
                    required
                    value={form.shipping_comuna}
                    onChange={update('shipping_comuna')}
                    className={inputClass}
                    disabled={comunasOfRegion.length === 0}
                  >
                    <option value="">
                      {comunasOfRegion.length === 0 ? 'Selecciona una región primero' : 'Elige tu comuna'}
                    </option>
                    {comunasOfRegion.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </FormField>
                <div className="sm:col-span-2">
                  <FormField label="Notas para el despacho (opcional)">
                    <textarea
                      value={form.shipping_notes}
                      onChange={update('shipping_notes')}
                      placeholder="Ej: dejar en conserjería"
                      rows={2}
                      className={inputClass}
                    />
                  </FormField>
                </div>
              </div>
            )}

            {siteSettings && (
              <p className="mt-4 text-xs text-tengu-dark/60">
                Tostamos los {siteSettings.roast_day} · despachamos {siteSettings.ship_days}.
              </p>
            )}
          </fieldset>

          {error && (
            <div className="rounded-md border border-tengu-coral/30 bg-tengu-coral/10 p-4 text-sm text-tengu-coral">
              {error}
            </div>
          )}
        </div>

        <aside className="h-fit rounded-xl bg-white p-6 shadow-sm">
          <h2 className="font-display text-lg">Tu pedido</h2>
          <ul className="mt-4 space-y-3 text-sm">
            {items.map((item) => (
              <li key={item.key} className="flex justify-between gap-3">
                <span className="flex-1">
                  <span className="font-medium">{item.productName}</span>
                  <span className="block text-xs text-tengu-dark/60">
                    {formatSize(item.sizeG)} · {item.quantity}x
                  </span>
                </span>
                <span className="font-semibold">
                  {formatCLP(item.unitPriceClp * item.quantity)}
                </span>
              </li>
            ))}
          </ul>
          <dl className="mt-6 space-y-2 border-t border-tengu-dark/10 pt-4 text-sm">
            <div className="flex justify-between">
              <dt>Subtotal</dt>
              <dd>{formatCLP(subtotal)}</dd>
            </div>
            {coupon?.valid && couponDiscount > 0 && (
              <div className="flex justify-between text-tengu-ink">
                <dt>
                  Descuento <span className="text-xs text-tengu-dark/50">({coupon.code})</span>
                </dt>
                <dd className="font-semibold">− {formatCLP(couponDiscount)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt>Envío</dt>
              <dd>
                {selectedOption.method === 'pickup' ? (
                  'Gratis'
                ) : quoting ? (
                  <span className="text-tengu-dark/50">Cotizando…</span>
                ) : quoteError ? (
                  <span className="text-xs text-tengu-coral">No disponible</span>
                ) : quote ? (
                  quote.is_free ? (
                    <span className="font-semibold text-tengu-ink">Gratis 🎉</span>
                  ) : (
                    formatCLP(quote.cost_clp)
                  )
                ) : (
                  <span className="text-xs text-tengu-dark/50">Ingresa región y comuna</span>
                )}
              </dd>
            </div>
          </dl>
          {quoteError && selectedOption.method !== 'pickup' && (
            <p className="mt-3 rounded-md bg-tengu-coral/10 px-3 py-2 text-xs text-tengu-coral">
              {quoteError} Revisá la comuna o escribinos por WhatsApp para coordinar.
            </p>
          )}

          {/* Cupón de descuento */}
          <div className="mt-4 border-t border-tengu-dark/10 pt-4">
            <p className="text-xs uppercase tracking-wider text-tengu-dark/60">¿Tenés un código?</p>
            {coupon?.valid ? (
              <div className="mt-2 flex items-center justify-between rounded-md bg-tengu-ink/5 px-3 py-2">
                <div className="text-sm">
                  <span className="font-semibold text-tengu-ink">{coupon.code}</span>{' '}
                  <span className="text-xs text-tengu-dark/60">aplicado · −{formatCLP(coupon.discount_clp)}</span>
                </div>
                <button
                  onClick={clearCoupon}
                  className="text-xs uppercase tracking-wider text-tengu-dark/50 hover:text-tengu-coral"
                >
                  Quitar
                </button>
              </div>
            ) : (
              <div className="mt-2 flex gap-2">
                <input
                  type="text"
                  value={couponInput}
                  onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), applyCoupon())}
                  placeholder="BF2026"
                  maxLength={40}
                  className="flex-1 rounded-md border border-tengu-dark/15 px-3 py-2 text-sm uppercase tracking-wider"
                />
                <button
                  type="button"
                  onClick={applyCoupon}
                  disabled={couponLoading || !couponInput.trim()}
                  className="rounded-md bg-tengu-ink px-4 py-2 text-xs font-semibold uppercase tracking-wider text-tengu-cream transition hover:bg-tengu-dark disabled:opacity-50"
                >
                  {couponLoading ? '…' : 'Aplicar'}
                </button>
              </div>
            )}
            {coupon && !coupon.valid && coupon.message && (
              <p className="mt-2 text-xs text-tengu-coral">{coupon.message}</p>
            )}
          </div>

          <div className="mt-4 flex items-baseline justify-between border-t border-tengu-dark/10 pt-4">
            <span className="text-sm uppercase tracking-wider text-tengu-dark/60">Total</span>
            <span className="font-display text-2xl text-tengu-ink">{formatCLP(total)}</span>
          </div>
          <div className="mt-6 space-y-3">
            <button
              type="button"
              onClick={() => handlePayment('bank_transfer')}
              disabled={submitting !== null}
              className="w-full rounded-md bg-tengu-ink px-4 py-3 text-sm font-semibold uppercase tracking-wider text-white transition hover:bg-tengu-mustard hover:text-tengu-dark disabled:opacity-50 sm:text-base"
            >
              {submitting === 'bank_transfer' ? 'Creando tu pedido…' : 'BanchilePagos'}
            </button>

            <button
              type="button"
              onClick={() => handlePayment('mercadopago')}
              disabled={submitting !== null}
              className="w-full rounded-md bg-[#009ee3] px-4 py-3 text-sm font-semibold uppercase tracking-wider text-white transition hover:bg-[#007eb5] disabled:opacity-50 sm:text-base"
            >
              {submitting === 'mercadopago' ? 'Conectando…' : 'Mercado Pago'}
            </button>

            <div className="relative">
              <button
                type="button"
                disabled
                className="w-full cursor-not-allowed rounded-md border border-tengu-dark/15 bg-tengu-dark/5 px-4 py-3 pr-28 text-sm font-semibold uppercase tracking-wider text-tengu-dark/40 sm:text-base"
              >
                Tarjeta · Webpay
              </button>
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-tengu-mustard px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-tengu-dark">
                Próximamente
              </span>
            </div>

            <div className="relative">
              <button
                type="button"
                disabled
                className="w-full cursor-not-allowed rounded-md border border-tengu-dark/15 bg-tengu-dark/5 px-4 py-3 pr-28 text-sm font-semibold uppercase tracking-wider text-tengu-dark/40 sm:text-base"
              >
                Transferencia · Khipu
              </button>
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-tengu-mustard px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-tengu-dark">
                Próximamente
              </span>
            </div>
          </div>
          <p className="mt-3 text-center text-xs text-tengu-dark/50">
            🔒 Pago seguro vía BanchilePagos
          </p>
          <p className="mt-1 text-center text-xs text-tengu-dark/40">
            Al pagar te llevamos al portal del banco. El pedido queda confirmado cuando recibimos comprobante.
          </p>
        </aside>
      </div>
    </section>
  );
}

const inputClass =
  'w-full rounded-md border border-tengu-dark/15 bg-white px-3 py-2 text-sm focus:border-tengu-ink focus:outline-none';

function FormField({
  label,
  required = false,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wider text-tengu-dark/70">
        {label}
        {required && <span className="ml-0.5 text-tengu-coral">*</span>}
      </span>
      {children}
    </label>
  );
}
