import { defineConfig } from '@playwright/test';

// E2E local: levanta backend (uvicorn con DB e2e propia, seedeada al startup)
// y frontend (vite dev con proxy /api → :8000).
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: '.venv\\Scripts\\python.exe -m uvicorn app.main:app --port 8000',
      cwd: '../backend',
      url: 'http://localhost:8000/api/products',
      reuseExistingServer: true,
      timeout: 60_000,
      env: {
        DATABASE_URL: 'sqlite:///./data/tengu-e2e.db',
        SEED_ON_STARTUP: 'true',
      },
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
