import type { CustomerProfile } from '../store/auth';
import type {
  CoffeeSubscription,
  HeroSlide,
  KhipuInit,
  MercadoPagoInit,
  Order,
  OrderPayload,
  Post,
  Product,
  Review,
  ReviewSubmit,
  ReviewSummary,
  ShippingMode,
  ShippingQuote,
  SiteSettings,
  SubscriptionCreateResponse,
  SubscriptionPayload,
  WebpayInit,
} from '../types';

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

// Mapeo Pydantic field name → label en español. Cubre los campos más
// comunes; lo que no esté queda con el nombre técnico.
const FIELD_LABELS_ES: Record<string, string> = {
  customer_email: 'email',
  customer_name: 'nombre',
  customer_phone: 'teléfono',
  customer_rut: 'RUT',
  shipping_address: 'dirección',
  shipping_comuna: 'comuna',
  shipping_region: 'región',
  shipping_notes: 'notas de despacho',
  size_g: 'formato',
  quantity: 'cantidad',
  price_clp: 'precio',
  stock_qty: 'stock',
  weight_g: 'peso',
  slug: 'identificador (slug)',
  name: 'nombre',
  category: 'categoría',
  rating: 'puntuación',
  body: 'comentario',
  title: 'título',
};

type PydanticError = {
  type: string;
  loc: (string | number)[];
  msg: string;
  ctx?: Record<string, unknown>;
};

/** Convierte el `detail` de un response error (string, array Pydantic o dict)
 * en un string legible en español. Exportado para uso desde admin-api.ts. */
export function formatApiError(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return formatPydanticError(detail as PydanticError[]);
  return JSON.stringify(detail);
}

function formatPydanticError(detail: PydanticError[]): string {
  const lines = detail.map((e) => {
    // loc empieza con 'body' o 'query'; el último segmento string es el campo
    const fieldName = [...e.loc].reverse().find((s) => typeof s === 'string' && s !== 'body' && s !== 'query');
    const label = (typeof fieldName === 'string' && FIELD_LABELS_ES[fieldName]) || fieldName || 'campo';
    // Traducimos los tipos de error más comunes; el resto cae al msg crudo.
    switch (e.type) {
      case 'string_pattern_mismatch':
        return `El ${label} tiene un formato inválido.`;
      case 'string_too_short':
        return `El ${label} es demasiado corto.`;
      case 'string_too_long':
        return `El ${label} es demasiado largo.`;
      case 'value_error':
        // Aprovecha el mensaje del validator (ej. RUT módulo 11)
        return `El ${label} no es válido: ${e.msg.replace(/^Value error,\s*/i, '')}`;
      case 'greater_than':
      case 'greater_than_equal':
        return `El ${label} debe ser mayor.`;
      case 'less_than':
      case 'less_than_equal':
        return `El ${label} excede el máximo permitido.`;
      case 'missing':
        return `Falta el campo ${label}.`;
      case 'literal_error':
        return `Valor inválido para ${label}.`;
      case 'enum':
        return `Valor inválido para ${label}.`;
      default:
        return `${label}: ${e.msg}`;
    }
  });
  return lines.join(' ');
}

async function request<T>(path: string, init?: RequestInit, jwt?: string | null): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  if (init?.headers) Object.assign(headers, init.headers as Record<string, string>);
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) {
        if (typeof body.detail === 'string') {
          detail = body.detail;
        } else if (Array.isArray(body.detail)) {
          detail = formatPydanticError(body.detail as PydanticError[]);
        } else {
          detail = JSON.stringify(body.detail);
        }
      }
    } catch { /* keep default */ }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export type SubscribeResponse = { status: 'subscribed' | 'already_subscribed'; message: string };

export const api = {
  listProducts: () => request<Product[]>('/products'),
  getProduct: (slug: string) => request<Product>(`/products/${slug}`),
  listPosts: () => request<Post[]>('/posts'),
  getPost: (slug: string) => request<Post>(`/posts/${slug}`),
  subscribe: (email: string) =>
    request<SubscribeResponse>('/newsletter', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  createOrder: (payload: OrderPayload) =>
    request<Order>('/orders', { method: 'POST', body: JSON.stringify(payload) }),
  validateCoupon: (payload: {
    code: string;
    subtotal_clp: number;
    items: { product_slug: string; category?: string; subtotal_clp: number }[];
  }) =>
    request<import('../types').CouponPreview>('/checkout/validate-coupon', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  registerCartEvent: (payload: {
    customer_email: string;
    customer_name?: string;
    customer_phone?: string;
    items: { product_slug: string; product_name: string; size_g: number; unit_price_clp: number; quantity: number; grind?: string }[];
    subtotal_clp: number;
  }) =>
    request<void>('/cart-events', { method: 'POST', body: JSON.stringify(payload) }),
  getOrder: (orderId: number, token: string) =>
    request<Order>(`/orders/${orderId}?token=${encodeURIComponent(token)}`),
  initWebpay: (orderId: number) =>
    request<WebpayInit>('/checkout/webpay/init', {
      method: 'POST',
      body: JSON.stringify({ order_id: orderId }),
    }),
  initKhipu: (orderId: number) =>
    request<KhipuInit>('/checkout/khipu/init', {
      method: 'POST',
      body: JSON.stringify({ order_id: orderId }),
    }),
  initMercadoPago: (orderId: number) =>
    request<MercadoPagoInit>('/checkout/mercadopago/init', {
      method: 'POST',
      body: JSON.stringify({ order_id: orderId }),
    }),
  verifyMercadoPago: (orderId: number, token: string) =>
    request<{ order_status: string; mp_status: string | null }>(
      `/checkout/mercadopago/verify/${orderId}?token=${encodeURIComponent(token)}`,
      { method: 'POST' },
    ),
  verifyKhipu: (orderId: number, token: string) =>
    request<{ order_status: string; khipu_status: string }>(
      `/checkout/khipu/verify/${orderId}?token=${encodeURIComponent(token)}`,
      { method: 'POST' },
    ),
  createSubscription: (payload: SubscriptionPayload) =>
    request<SubscriptionCreateResponse>('/subscriptions', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getSubscription: (id: number) => request<CoffeeSubscription>(`/subscriptions/${id}`),
  listReviews: (productSlug: string) => request<Review[]>(`/reviews/${productSlug}`),
  reviewSummary: (productSlug: string) => request<ReviewSummary>(`/reviews/${productSlug}/summary`),
  submitReview: (payload: ReviewSubmit) =>
    request<Review>('/reviews', { method: 'POST', body: JSON.stringify(payload) }),

  // --- Auth de cliente (magic link) ---
  requestMagicLink: (email: string) =>
    request<void>('/auth/request-link', { method: 'POST', body: JSON.stringify({ email }) }),
  verifyMagicLink: (token: string) =>
    request<{ jwt: string; email: string }>(`/auth/verify?token=${encodeURIComponent(token)}`),
  googleLogin: (idToken: string) =>
    request<{ jwt: string; email: string }>('/auth/google', {
      method: 'POST',
      body: JSON.stringify({ id_token: idToken }),
    }),
  getMe: (jwt: string) => request<CustomerProfile>('/auth/me', undefined, jwt),
  patchMe: (jwt: string, patch: Partial<CustomerProfile>) =>
    request<CustomerProfile>('/auth/me', { method: 'PATCH', body: JSON.stringify(patch) }, jwt),
  listMyOrders: (jwt: string) => request<Order[]>('/auth/me/orders', undefined, jwt),

  // --- Site settings (configurables desde /admin) ---
  getSiteSettings: () => request<SiteSettings>('/site/settings'),

  // --- Slides del carrusel del home (configurables desde /admin) ---
  getHeroSlides: () => request<HeroSlide[]>('/site/hero-slides'),

  // --- Regiones + comunas (catálogo para selects de checkout) ---
  listRegions: () => request<Array<{ name: string; comunas: string[] }>>('/site/regions'),

  // --- Cotización de envío ---
  quoteShipping: (payload: {
    region: string;
    comuna?: string | null;
    weight_g: number;
    mode: ShippingMode;
    subtotal_clp: number;
  }) =>
    request<ShippingQuote>('/shipping/quote', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};

export function formatCLP(value: number): string {
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatSize(sizeG: number): string {
  return sizeG >= 1000 ? `${sizeG / 1000} kg` : `${sizeG} g`;
}

/** CLP por kilo dado precio total y gramos de la variante. */
export function pricePerKg(priceClp: number, sizeG: number): number {
  return Math.round((priceClp / sizeG) * 1000);
}
