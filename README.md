<p align="center">
  <img src="readmelogoo.png" alt="oSStack logo" width="96" />
</p>

<h1 align="center">oSStack Backend Engine</h1>

<p align="center">
  The core backend engine, build orchestrator, and real-time Socket.IO deployment server for the oSStack web deployment platform.
</p>

<p align="center">
  <a href="https://osstack.netlify.app">Live Website</a>
  |
  <a href="https://osstack.netlify.app/dashboard">Dashboard</a>
  |
  <a href="https://github.com/sanketpadhyal/osstack">Frontend Repository</a>
</p>

## Overview

This repository powers the backend infrastructure for **oSStack**. It handles:

1. **Authentication & Sessions**: Supabase OAuth integration (Google & GitHub) with secure HttpOnly cookies and JWT verification.
2. **Build Orchestration (`runner.js`)**: Isolated local execution engine for `npm`, `pnpm`, and `yarn` builds with 10-minute timeout safety guards.
3. **Smart Framework Detector (`detector.js`)**: Automatic detection of static HTML sites vs framework projects (React, Vite, Vue, Angular, Svelte, Docusaurus, Astro).
4. **Auto-Recovery**: On-demand auto-installation of missing CLI tools (`vite`, `tsc`, `vue-cli-service`) and missing npm packages.
5. **Real-Time Streaming (`events.js`)**: WebSocket log terminal streaming via Socket.IO.
6. **Supabase Storage Engine (`storage.js`)**: Direct asset uploads and SPA subpath routing virtualization shim.

> [!WARNING]
> **Critical Cloud Deployment & Hardware Sizing Requirements**
> When hosting this backend on cloud providers (such as Google Cloud Run, AWS, Railway, Render):
> - **Instance-based Allocation (Always On)**: You MUST select **Instance-based** billing/CPU allocation (always allocated) instead of Request-based serverless execution. Full CPU lifecycle and active connections are required for background build processes (`npm install`, compilation) and persistent Socket.IO WebSockets.
> - **Resource Sizing**: Allocate **at least 2 GiB Memory (RAM)** and dedicated vCPU.
> 
> *Failure to use Instance-based allocation or allocating less than 2 GiB RAM will cause your deployments to freeze, time out, or crash due to Out-Of-Memory (OOM) errors during build compilation.*

## Environment Variables Setup

Create a `.env` file in the root directory based on `.env.example`:

```env
PORT=8080
BACKEND_URL=http://localhost:8080
FRONTEND_URL=http://localhost:3000

SUPABASE_URL=https://your-supabase-project.supabase.co
SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
SUPABASE_DEPLOYMENT_BUCKET=deployments

GITHUB_CLIENT_ID=your-github-oauth-client-id
GITHUB_CLIENT_SECRET=your-github-oauth-client-secret
```

## Quick Start

```bash
# Install dependencies
npm install

# Run backend in development mode
npm run dev
```

For full database schema setup and frontend instructions, visit the main [oSStack Frontend Repository](https://github.com/sanketpadhyal/osstack).
