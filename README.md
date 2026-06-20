# Neary

Real-time transit tracking app for Cluj-Napoca. Shows live vehicle positions, arrival estimates, and route information using the Tranzy API. Built as a mobile-first PWA with React + TypeScript.

## Quick Start

```bash
npm install
npm run dev        # http://localhost:5175
```

Requires a [Tranzy API key](https://tranzy.ai) — entered on first launch.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Development server (port 5175) |
| `npm run build` | Production build → `dist/` |
| `npm test` | Run tests (191 tests, 29 files) |
| `npm run build:ios` | Build + sync to iOS project |
| `npm run open:ios` | Open Xcode workspace |

## Stack

- **React 19** + TypeScript + Vite
- **Material-UI 7** for components
- **Zustand** for state management
- **Leaflet** for maps
- **Axios** for API calls
- **Capacitor** for iOS native packaging

## Project Structure

```
src/
├── components/    # React components (features/, layout/, theme/)
├── services/      # API services and business logic
├── stores/        # Zustand state stores
├── hooks/         # Custom React hooks
├── utils/         # Pure utilities and helpers
├── types/         # TypeScript type definitions
└── context/       # App-level context and initialization
```

## API

All transit data comes from the Tranzy API. In development and production (web), requests to `/api/tranzy/*` are proxied to `https://api.tranzy.ai/*`. On iOS native, an axios interceptor rewrites the paths directly — see [`src/services/apiInterceptor.ts`](src/services/apiInterceptor.ts).

Configuration: [`src/utils/core/constants.ts`](src/utils/core/constants.ts)

## Documentation

See [`docs/`](docs/) for detailed guides:

- [Getting Started](docs/getting-started.md) — setup and first run
- [Developer Guide](docs/developer-guide.md) — architecture, build, deploy, iOS
- [API Services](docs/api-services.md) — service layer reference
- [Troubleshooting](docs/troubleshooting/) — common issues and fixes

## Deployment

- **Web**: Netlify (auto-deploys from `main`). Config: [`netlify.toml`](netlify.toml)
- **iOS**: Capacitor + Xcode. See [Developer Guide — iOS Build](docs/developer-guide.md#ios-build-capacitor)
