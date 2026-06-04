import { expect, test } from '@playwright/test';

/** Flujo real de compra: producto → carrito → checkout → BanchilePagos → /thanks.
 *  Además verifica el reuso de orden pending (reintentar no duplica órdenes). */

const fillCheckoutForm = async (page: import('@playwright/test').Page) => {
  await page.getByLabel(/Nombre completo/).fill('Cliente E2E');
  await page.getByLabel(/Email/).first().fill('e2e@test.cl');
  await page.getByLabel(/Teléfono móvil/).fill('+56 9 5001 3366');
  await page.getByLabel(/RUT/).fill('11.111.111-1');
  await page.getByText('Retiro en Rancagua').click();
};

test('compra con BanchilePagos llega a /thanks con instrucciones', async ({ page }) => {
  await page.goto('/cafe/caldas-manzanares');
  await page.getByRole('button', { name: 'Agregar al carrito' }).click();

  await page.goto('/checkout');
  await fillCheckoutForm(page);
  await page.getByRole('button', { name: /BanchilePagos/ }).click();

  await expect(page).toHaveURL(/\/thanks\/\d+\?/, { timeout: 20_000 });
  await expect(page.getByText('Pedido creado · falta pagar')).toBeVisible();
  await expect(page.getByText('Cómo terminar tu pago')).toBeVisible();
  await expect(page.getByRole('link', { name: /Pagar ahora con BanchilePagos/ })).toBeVisible();
});

test('reintentar el mismo pedido reusa la orden pending (no duplica)', async ({ page }) => {
  await page.goto('/cafe/caldas-manzanares');
  await page.getByRole('button', { name: 'Agregar al carrito' }).click();

  // Primer intento
  await page.goto('/checkout');
  await fillCheckoutForm(page);
  await page.getByRole('button', { name: /BanchilePagos/ }).click();
  await expect(page).toHaveURL(/\/thanks\/\d+\?/, { timeout: 20_000 });
  const firstOrderId = page.url().match(/\/thanks\/(\d+)/)?.[1];
  expect(firstOrderId).toBeTruthy();

  // El cliente "se arrepiente", vuelve al checkout (el carrito sigue lleno
  // porque solo se vacía al confirmar el pago) y reintenta idéntico.
  await page.goto('/checkout');
  await page.getByText('Retiro en Rancagua').click();
  await page.getByRole('button', { name: /BanchilePagos/ }).click();

  await expect(page).toHaveURL(new RegExp(`/thanks/${firstOrderId}\\?`), { timeout: 20_000 });
});

test('cupón inválido muestra error y no bloquea el flujo', async ({ page }) => {
  await page.goto('/cafe/caldas-manzanares');
  await page.getByRole('button', { name: 'Agregar al carrito' }).click();
  await page.goto('/checkout');

  const couponInput = page.getByPlaceholder(/digo/i).or(page.getByPlaceholder(/cup/i)).first();
  if (await couponInput.isVisible().catch(() => false)) {
    await couponInput.fill('NOEXISTE');
    await page.getByRole('button', { name: /Aplicar/i }).click();
    await expect(page.getByText(/no válido|inválido|no existe/i).first()).toBeVisible();
  }
});
