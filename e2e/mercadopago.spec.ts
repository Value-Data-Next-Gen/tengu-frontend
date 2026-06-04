import { expect, test, type Page } from '@playwright/test';

/** Flujo Mercado Pago del cliente. El portal real de MP no se puede pagar en
 *  E2E, así que se cubren los dos lados que SÍ son nuestros:
 *  - init falla (MP caído / sin configurar): error claro y el reintento NO
 *    duplica la orden (reusa la pending).
 *  - retorno exitoso desde MP (simulado con route-mock): /thanks confirma,
 *    vacía el carrito y limpia la orden pending guardada. */

const addToCartAndGotoCheckout = async (page: Page) => {
  await page.goto('/cafe/caldas-manzanares');
  await page.getByRole('button', { name: 'Agregar al carrito' }).click();
  await page.goto('/checkout');
  await page.getByLabel(/Nombre completo/).fill('Cliente MP E2E');
  await page.getByLabel(/Email/).first().fill('mp-e2e@test.cl');
  await page.getByLabel(/Teléfono móvil/).fill('+56 9 5001 3366');
  await page.getByLabel(/RUT/).fill('11.111.111-1');
  await page.getByText('Retiro en Rancagua').click();
};

test('MP caído: muestra error y el reintento reusa la orden (no duplica)', async ({ page }) => {
  let ordersCreated = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/orders')) ordersCreated += 1;
  });
  // Mock: MP caído/sin configurar. Nunca pegarle al MP real desde E2E (el
  // .env local puede tener credenciales y crearía preferences de verdad).
  await page.route('**/api/checkout/mercadopago/init', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'Mercado Pago no está configurado' }),
    }),
  );
  await addToCartAndGotoCheckout(page);

  await page.getByRole('button', { name: /Mercado Pago/ }).click();
  await expect(page.getByText(/no está configurado/).first()).toBeVisible({ timeout: 15_000 });

  // Reintento: misma orden, sin POST /api/orders adicional.
  await page.getByRole('button', { name: /Mercado Pago/ }).click();
  await expect(page.getByText(/no está configurado/).first()).toBeVisible({ timeout: 15_000 });
  expect(ordersCreated).toBe(1);
});

test('retorno exitoso desde MP: /thanks confirma, vacía carrito y limpia orden pending', async ({ page, baseURL }) => {
  let orderId = 0;
  let token = '';

  // Captura id/token de la orden real creada.
  await page.route('**/api/orders', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    orderId = body.id;
    token = body.access_token;
    await route.fulfill({ response });
  });
  // Simula que MP acepta el init y "el cliente paga": init_point apunta de
  // vuelta a /thanks como lo haría el back_url success de MP.
  await page.route('**/api/checkout/mercadopago/init', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        preference_id: 'pref-e2e',
        init_point: `${baseURL}/thanks/${orderId}?status=paid&token=${token}`,
      }),
    });
  });
  // Simula que el webhook ya confirmó: la orden se lee como paid.
  await page.route('**/api/orders/*?token=*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, status: 'paid' }) });
  });

  await addToCartAndGotoCheckout(page);
  await page.getByRole('button', { name: /Mercado Pago/ }).click();

  await expect(page).toHaveURL(/\/thanks\/\d+\?status=paid/, { timeout: 20_000 });
  await expect(page.getByText('¡Gracias por tu compra!')).toBeVisible();

  // Carrito vacío y orden pending olvidada: un próximo checkout parte de cero.
  const pendingKey = await page.evaluate(() => sessionStorage.getItem('tengu-pending-order-v1'));
  expect(pendingKey).toBeNull();
  await page.goto('/carrito');
  await expect(page.getByText('Tu carrito está vacío')).toBeVisible();
});
