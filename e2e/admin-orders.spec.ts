import { expect, test, type Page } from '@playwright/test';

/** Panel /admin/orders: anotaciones internas y transiciones de estado.
 *  Cubre los reportes de Fabián: "no me deja guardar la nota" (ahora botón con
 *  confirmación) y marcar pagado a mano, más el guard de enviado-sin-pago. */

const ADMIN_EMAIL = 'g.rojaschacon@gmail.com';
const ADMIN_PASSWORD = 'tengu123'; // default solo-dev del backend e2e

const createPendingOrder = async (page: Page): Promise<string> => {
  await page.goto('/cafe/caldas-manzanares');
  await page.getByRole('button', { name: 'Agregar al carrito' }).click();
  await page.goto('/checkout');
  await page.getByLabel(/Nombre completo/).fill('Cliente Admin E2E');
  await page.getByLabel(/Email/).first().fill('admin-e2e@test.cl');
  await page.getByLabel(/Teléfono móvil/).fill('+56 9 5001 3366');
  await page.getByLabel(/RUT/).fill('11.111.111-1');
  await page.getByText('Retiro en Rancagua').click();
  await page.getByRole('button', { name: /BanchilePagos/ }).click();
  await expect(page).toHaveURL(/\/thanks\/\d+\?/, { timeout: 20_000 });
  const orderId = page.url().match(/\/thanks\/(\d+)/)?.[1];
  expect(orderId).toBeTruthy();
  // Olvidar la orden pending para que el próximo test/parte cree otra limpia.
  await page.evaluate(() => sessionStorage.removeItem('tengu-pending-order-v1'));
  return orderId!;
};

const loginAdmin = async (page: Page) => {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Contraseña').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/admin/, { timeout: 15_000 });
};

test('anotaciones y estados: nota se guarda con confirmación, enviado sin pago se bloquea, pagado a mano funciona', async ({ page }) => {
  const orderId = await createPendingOrder(page);
  await loginAdmin(page);

  await page.goto('/admin/orders');
  // Los botones de estado del detalle comparten texto con los tabs de filtro
  // de arriba ("Pagado"/"Enviado") — scope a la tabla.
  const table = page.getByRole('table');
  const row = page.locator(`tr:has(td.font-mono:text-is("${orderId}"))`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole('button', { name: 'Detalle' }).click();

  // 1) Enviado sin pago → el backend rechaza (409) y el admin ve el error.
  const dialogPromise = page.waitForEvent('dialog');
  await table.getByRole('button', { name: 'Enviado', exact: true }).click();
  const dialog = await dialogPromise;
  expect(dialog.message()).toMatch(/pagada/);
  await dialog.accept();

  // 2) Guardar anotación interna → confirmación visible.
  await table.locator('textarea').fill('Cliente pagó por transferencia, comprobante recibido por WhatsApp');
  await table.getByRole('button', { name: 'Guardar nota' }).click();
  await expect(table.getByText('Guardada ✓')).toBeVisible({ timeout: 10_000 });

  // 3) Marcar pagado a mano (caso transferencia confirmada).
  await table.getByRole('button', { name: 'Pagado', exact: true }).click();
  await expect(row.getByText('Pagado', { exact: true })).toBeVisible({ timeout: 10_000 });

  // 4) Ahora sí puede pasar a Enviado.
  await table.getByRole('button', { name: 'Enviado', exact: true }).click();
  await expect(row.getByText('Enviado', { exact: true })).toBeVisible({ timeout: 10_000 });

  // 5) La nota sobrevivió a los cambios de estado (recarga incluida).
  await page.reload();
  const rowAfter = page.locator(`tr:has(td.font-mono:text-is("${orderId}"))`);
  await rowAfter.getByRole('button', { name: 'Detalle' }).click();
  await expect(page.getByRole('table').locator('textarea')).toHaveValue(/comprobante recibido/);
});
