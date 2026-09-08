# Loonto / NL Payslip

Konsumencka aplikacja do czytelnego sprawdzania holenderskich pasków wypłaty.

## Uruchomienie

Wymagane: Node.js 20+ oraz opcjonalnie Docker Desktop dla trwałego zapisu.

Na Windows bez Dockera uruchom dwuklikiem `INSTALL_WINDOWS.cmd`. Skrypt włączy
WSL 2, poda polecenie do wykonania po restarcie, zainstaluje Docker Desktop i
uruchomi PostgreSQL oraz Redis dla projektu.

```powershell
npm install
Copy-Item apps/backend-node/.env.example apps/backend-node/.env
docker compose up -d
npm run dev:api
npm run dev
```

Frontend: `http://127.0.0.1:5173`

API health-check: `http://127.0.0.1:3001/api/health`

Bez `DATABASE_URL` aplikacja działa w trybie demonstracyjnym. Endpoint zdrowia
zwraca wtedy `database: "not_configured"`, a odpowiedzi analiz mają
`persisted: false`.

## Weryfikacja

```powershell
npm run typecheck
npm run build
```

Nigdy nie zapisuj prawdziwych kluczy w `.env.example` ani w repozytorium.
