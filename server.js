import cookieParser from 'cookie-parser'
import cors from 'cors'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import dotenv from 'dotenv'
import express from 'express'
import { createServer } from 'node:http'
import { createClient } from '@supabase/supabase-js'
import { Server } from 'socket.io'

import { runDeployment } from './building/runner.js'
import { addDeploymentEvent, getEventsForDeployment } from './building/events.js'
import { serveDeploymentFile, getSafeDeploymentFilePath } from './building/storage.js'

dotenv.config()

const app = express()
const server = createServer(app)
const port = Number(process.env.PORT ?? 8080)
const backendUrl = trimTrailingSlash(process.env.BACKEND_URL ?? `http://localhost:${port}`)
const frontendUrl = trimTrailingSlash(process.env.FRONTEND_URL ?? 'http://localhost:3000')
const allowedFrontendOrigins = new Set(
  [
    frontendUrl,
    'https://osstack.netlify.app',
    'https://osstack.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
    ...(process.env.ALLOWED_FRONTEND_ORIGINS ?? '')
      .split(',')
      .map((origin) => trimTrailingSlash(origin.trim()))
      .filter(Boolean),
  ].filter(Boolean),
)
const cookieSecure = process.env.NODE_ENV === 'production'
const authCookieOptions = {
  httpOnly: true,
  secure: cookieSecure,
  sameSite: cookieSecure ? 'none' : 'lax',
  path: '/',
}
const sessionDays = 20
const sessionMaxAge = sessionDays * 24 * 60 * 60 * 1000
const jwtSecret = process.env.JWT_SECRET ?? 'osstack-local-dev-secret-change-before-production'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabaseAuth =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false,
        },
      })
    : null

const supabaseAdmin =
  supabaseUrl && supabaseServiceRoleKey
    ? createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false,
        },
      })
    : null

const githubTokensByUserId = new Map()
const githubRepositoryRefreshByUserId = new Map()
const githubRepositoryRefreshCooldownMs = 60 * 1000
const deploymentBucket = process.env.SUPABASE_DEPLOYMENT_BUCKET ?? 'deployments'
const deploymentBuildRoot = null
const deploymentRootDomain = trimTrailingSlash(process.env.DEPLOYMENT_ROOT_DOMAIN ?? '')
const deploymentBucketFileSizeLimit = 250 * 1024 * 1024
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (!origin || isAllowedOrigin(origin)) {
        callback(null, true)
      } else {
        callback(null, false)
      }
    },
    credentials: true,
  },
})

app.use(express.json({ limit: '100mb' }))
app.use(cookieParser())
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || isAllowedOrigin(origin)) {
        callback(null, true)
      } else {
        callback(null, false)
      }
    },
    credentials: true,
  }),
)

io.on('connection', (socket) => {
  socket.on('deployment:join', async (payload) => {
    try {
      const deploymentId = asString(payload?.deploymentId)
      const authToken = asString(socket.handshake.auth?.token)
      const session = authToken ? verifyJwt(authToken) : getSessionFromCookieHeader(socket.handshake.headers.cookie)

      if (!deploymentId || !session) {
        socket.emit('deployment:error', { error: 'Unauthorized' })
        return
      }

      const user = await getProfileById(session.sub)

      if (!user) {
        socket.emit('deployment:error', { error: 'Unauthorized' })
        return
      }

      const deployment = await getDeploymentByIdForUser(deploymentId, user.id)

      if (!deployment) {
        socket.emit('deployment:error', { error: 'Deployment not found.' })
        return
      }

      socket.join(`deployment:${deploymentId}`)
      const admin = requireSupabaseAdmin()
      socket.emit('deployment:events', await getEventsForDeployment(admin, deploymentId))
    } catch (error) {
      socket.emit('deployment:error', { error: error instanceof Error ? error.message : 'Socket error.' })
    }
  })
})

app.get('/health', (_request, response) => {
  response.json({
    ok: true,
    service: 'osstack-backend',
    supabase: Boolean(supabaseAuth),
    database: Boolean(supabaseAdmin),
  })
})

app.post('/auth/register', (_request, response) => {
  response.status(400).json({
    ok: false,
    error: 'Use Google or GitHub login. Supabase auth creates the real user profile automatically.',
  })
})

app.post('/auth/session', async (request, response, next) => {
  try {
    const accessToken = asString(request.body?.accessToken)
    const providerToken = asString(request.body?.providerToken)

    if (!accessToken) {
      response.status(400).json({ ok: false, error: 'Access token is required.' })
      return
    }

    if (!supabaseAuth) {
      throw new Error('Supabase auth is not configured.')
    }

    const { data, error } = await supabaseAuth.auth.getUser(accessToken)

    if (error || !data.user) {
      response.status(401).json({ ok: false, error: 'Invalid Supabase session.' })
      return
    }

    const user = await ensureUser(fromSupabaseUser(data.user))

    if (providerToken && user.provider === 'github') {
      githubTokensByUserId.set(user.id, providerToken)
    }

    const sessionToken = setSessionCookie(response, user.id)
    response.json({ ok: true, user: toPublicUser(user), sessionToken, dashboard: await getDashboardForUser(user.id) })
  } catch (error) {
    next(error)
  }
})

app.get('/auth/google', (request, response, next) => {
  startOAuth('google', request, response).catch(next)
})

app.get('/auth/github', (request, response, next) => {
  startOAuth('github', request, response).catch(next)
})

app.get('/auth/callback', async (request, response, next) => {
  try {
    const code = getSingleQueryValue(request.query.code)
    const error = getSingleQueryValue(request.query.error)
    const redirectFrontendUrl = getRedirectFrontendUrl(request)

    if (error) {
      response.redirect(`${redirectFrontendUrl}/authentication?auth=error&reason=${encodeURIComponent(error)}`)
      return
    }

    if (!code) {
      response.redirect(`${redirectFrontendUrl}/authentication?auth=error&reason=missing_code`)
      return
    }

    if (!supabaseAuth) {
      throw new Error('Supabase OAuth is not configured.')
    }

    const { data, error: exchangeError } = await supabaseAuth.auth.exchangeCodeForSession(code)

    if (exchangeError || !data.session) {
      throw exchangeError ?? new Error('Supabase did not return a session.')
    }

    const user = await ensureUser(fromSupabaseUser(data.session.user))

    if (data.session.provider_token && user.provider === 'github') {
      githubTokensByUserId.set(user.id, data.session.provider_token)
    }

    const sessionToken = setSessionCookie(response, user.id)
    response.clearCookie('osstack_frontend_origin', authCookieOptions)
    response.redirect(`${redirectFrontendUrl}/authentication?auth=success#osstack_token=${encodeURIComponent(sessionToken)}`)
  } catch (error) {
    next(error)
  }
})

app.get('/auth/me', requireSession, async (request, response, next) => {
  try {
    response.json({ authenticated: true, user: toPublicUser(request.user) })
  } catch (error) {
    next(error)
  }
})

app.post('/auth/logout', (_request, response) => {
  clearAuthCookies(response)
  response.json({ ok: true })
})

app.get('/api/dashboard', requireSession, async (request, response, next) => {
  try {
    response.json(await getDashboardForUser(request.user.id))
  } catch (error) {
    next(error)
  }
})

app.get('/api/projects', requireSession, async (request, response, next) => {
  try {
    const projects = await getProjectsForUser(request.user.id)
    response.json({ projects })
  } catch (error) {
    next(error)
  }
})

app.get('/api/github/repositories', requireSession, async (request, response, next) => {
  try {
    const githubToken = githubTokensByUserId.get(request.user.id)

    if (!githubToken) {
      response.json({ connected: false, repositories: [] })
      return
    }

    const lastRefreshAt = githubRepositoryRefreshByUserId.get(request.user.id) ?? 0
    const retryAfterMs = githubRepositoryRefreshCooldownMs - (Date.now() - lastRefreshAt)

    if (retryAfterMs > 0) {
      response
        .status(429)
        .set('Retry-After', String(Math.ceil(retryAfterMs / 1000)))
        .json({ connected: true, repositories: [], retryAfterSeconds: Math.ceil(retryAfterMs / 1000) })
      return
    }

    const githubResponse = await fetch('https://api.github.com/user/repos?visibility=public&sort=updated&per_page=50', {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'oSStack',
      },
    })

    if (!githubResponse.ok) {
      response.status(githubResponse.status).json({ connected: false, repositories: [] })
      return
    }

    const repositories = await githubResponse.json()
    githubRepositoryRefreshByUserId.set(request.user.id, Date.now())

    response.json({
      connected: true,
      repositories: repositories.map((repository) => ({
        id: repository.id,
        name: repository.name,
        fullName: repository.full_name,
        private: repository.private,
        htmlUrl: repository.html_url,
        defaultBranch: repository.default_branch,
        updatedAt: repository.updated_at,
      })),
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/projects/check-slug/:slug', requireSession, async (request, response, next) => {
  try {
    const slug = slugify(request.params.slug)

    if (!slug) {
      response.status(400).json({ available: false, error: 'Project slug is required.' })
      return
    }

    const admin = requireSupabaseAdmin()
    const { data, error } = await admin.from('osstack_projects').select('id').eq('slug', slug).maybeSingle()

    if (error) {
      throw error
    }

    response.json({ available: !data, slug })
  } catch (error) {
    next(error)
  }
})

app.get('/api/deployments', requireSession, async (request, response, next) => {
  try {
    response.json({ deployments: await getDeploymentSummariesForUser(request.user.id) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/deployments/:deploymentId', requireSession, async (request, response, next) => {
  try {
    const deployment = await getDeploymentByIdForUser(request.params.deploymentId, request.user.id)

    if (!deployment) {
      response.status(404).json({ ok: false, error: 'Deployment not found.' })
      return
    }

    const project = await getProjectRowByIdForUser(deployment.project_id, request.user.id)
    const events = await getEventsForDeployment(requireSupabaseAdmin(), deployment.id)

    response.json({
      deployment: toDeploymentDetail(deployment, project, events),
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/deployments', requireSession, async (request, response, next) => {
  try {
    const repositoryFullName = asString(request.body?.repositoryFullName)
    const repositoryUrl = asString(request.body?.repositoryUrl)
    const projectName = asString(request.body?.projectName)
    const branch = asString(request.body?.branch) ?? 'main'
    const requestedSlug = slugify(asString(request.body?.slug) ?? projectName ?? '')
    const repositoryLabel = repositoryFullName ?? getRepositoryLabelFromUrl(repositoryUrl)
    const environment = sanitizeEnvironmentVariables(request.body?.environment)

    if (repositoryFullName && !/^[\w.-]+\/[\w.-]+$/.test(repositoryFullName)) {
      response.status(400).json({ ok: false, error: 'Select a valid GitHub repository.' })
      return
    }

    if (!repositoryFullName && !isSafeGitRepositoryUrl(repositoryUrl)) {
      response.status(400).json({ ok: false, error: 'Enter a valid public HTTPS git repository URL.' })
      return
    }

    if (!projectName || !requestedSlug) {
      response.status(400).json({ ok: false, error: 'Project name is required.' })
      return
    }

    const { projects, usage, quotas } = await getUserUsageAndQuotas(request.user.id)

    if (usage.buildMinutes >= quotas.buildMinutes) {
      response.status(403).json({
        ok: false,
        error: `Build minutes limit reached (${quotas.buildMinutes}m/${quotas.buildMinutes}m). Upgrade your plan to run more builds.`,
      })
      return
    }

    const existingProject = projects.find((p) => p.slug === requestedSlug)

    if (!existingProject && projects.length >= quotas.maxProjects) {
      response.status(403).json({
        ok: false,
        error: `Live websites limit reached (${quotas.maxProjects}/${quotas.maxProjects}). Upgrade your plan to deploy more websites.`,
      })
      return
    }

    const admin = requireSupabaseAdmin()
    const { data: existingProjectRow, error: existingError } = await admin
      .from('osstack_projects')
      .select('id')
      .eq('slug', requestedSlug)
      .maybeSingle()

    if (existingError) {
      throw existingError
    }

    if (existingProjectRow) {
      response.status(409).json({ ok: false, error: 'Project name already exists. Choose another name.', slug: requestedSlug })
      return
    }

    const now = new Date().toISOString()
    const { data: projectRow, error: projectError } = await admin
      .from('osstack_projects')
      .insert({
        user_id: request.user.id,
        name: projectName,
        slug: requestedSlug,
        repo: repositoryLabel,
        branch,
        status: 'building',
        live_url: null,
        storage_bytes: 0,
        bandwidth_bytes: 0,
        build_minutes: 0,
        created_at: now,
        updated_at: now,
      })
      .select('*')
      .single()

    if (projectError) {
      throw projectError
    }

    const { data: deploymentRow, error: deploymentError } = await admin
      .from('osstack_deployments')
      .insert({
        user_id: request.user.id,
        project_id: projectRow.id,
        project_name: projectRow.name,
        status: 'QUEUED',
        detail: `Queued ${repositoryLabel} on ${branch}`,
        created_at: now,
      })
      .select('*')
      .single()

    if (deploymentError) {
      throw deploymentError
    }

    const deploymentOptions = {
      deploymentId: deploymentRow.id,
      projectId: projectRow.id,
      userId: request.user.id,
      projectName,
      slug: requestedSlug,
      repositoryFullName,
      repositoryUrl,
      repositoryLabel,
      branch,
      environment,
    }

    const deploymentDeps = {
      io,
      supabaseAdmin: requireSupabaseAdmin(),
      deploymentBucket,
      githubToken: githubTokensByUserId.get(request.user.id) ?? null,
      getDeploymentPublicUrl,
    }

    queueMicrotask(() => {
      runDeployment(deploymentDeps, deploymentOptions).catch((error) => {
        const message = error instanceof Error ? error.message : 'Deployment failed.'
        addDeploymentEvent(deploymentDeps, deploymentRow.id, request.user.id, projectRow.id, 'FAILED', message, { log: message }).catch(() => {})
      })
    })

    response.status(202).json({
      ok: true,
      deploymentId: deploymentRow.id,
      projectId: projectRow.id,
      status: 'QUEUED',
      buildUrl: `/dashboard/builds/${deploymentRow.id}`,
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/deployments/folder', requireSession, async (request, response, next) => {
  try {
    const projectName = asString(request.body?.projectName)
    const requestedSlug = slugify(asString(request.body?.slug) ?? projectName ?? '')
    const environment = sanitizeEnvironmentVariables(request.body?.environment)
    const files = Array.isArray(request.body?.files) ? request.body.files : []

    if (!projectName || !requestedSlug) {
      response.status(400).json({ ok: false, error: 'Project name is required.' })
      return
    }

    if (!files.length) {
      response.status(400).json({ ok: false, error: 'Select or drop a folder containing project files.' })
      return
    }

    const { projects, usage, quotas } = await getUserUsageAndQuotas(request.user.id)

    if (usage.buildMinutes >= quotas.buildMinutes) {
      response.status(403).json({
        ok: false,
        error: `Build minutes limit reached (${quotas.buildMinutes}m/${quotas.buildMinutes}m). Upgrade your plan to run more builds.`,
      })
      return
    }

    const existingProject = projects.find((p) => p.slug === requestedSlug)

    if (!existingProject && projects.length >= quotas.maxProjects) {
      response.status(403).json({
        ok: false,
        error: `Live websites limit reached (${quotas.maxProjects}/${quotas.maxProjects}). Upgrade your plan to deploy more websites.`,
      })
      return
    }

    const incomingStorage = files.reduce((acc, f) => acc + (f.content ? Buffer.from(f.content, 'base64').byteLength : 0), 0)
    if (usage.storageBytes + incomingStorage > quotas.storageBytes) {
      response.status(403).json({
        ok: false,
        error: `Storage limit exceeded (${formatBytes(quotas.storageBytes)} max). Upgrade your plan to store more files.`,
      })
      return
    }

    const admin = requireSupabaseAdmin()
    const { data: existingProjectRow, error: existingError } = await admin
      .from('osstack_projects')
      .select('id')
      .eq('slug', requestedSlug)
      .maybeSingle()

    if (existingError) throw existingError
    if (existingProjectRow) {
      response.status(409).json({ ok: false, error: 'Project name already exists. Choose another name.', slug: requestedSlug })
      return
    }

    const now = new Date().toISOString()
    const { data: projectRow, error: projectError } = await admin
      .from('osstack_projects')
      .insert({
        user_id: request.user.id,
        name: projectName,
        slug: requestedSlug,
        repo: 'Folder Upload',
        branch: 'main',
        status: 'building',
        live_url: null,
        storage_bytes: 0,
        bandwidth_bytes: 0,
        build_minutes: 0,
        created_at: now,
        updated_at: now,
      })
      .select('*')
      .single()

    if (projectError) throw projectError

    const { data: deploymentRow, error: deploymentError } = await admin
      .from('osstack_deployments')
      .insert({
        user_id: request.user.id,
        project_id: projectRow.id,
        project_name: projectRow.name,
        status: 'QUEUED',
        detail: 'Folder deployment created',
        created_at: now,
      })
      .select('*')
      .single()

    if (deploymentError) throw deploymentError

    const buildDir = path.join(os.tmpdir(), 'osstack-builds', String(deploymentRow.id))
    const sourceDir = path.join(buildDir, 'source')
    await fs.mkdir(sourceDir, { recursive: true })

    const samplePaths = files
      .map((f) => (f.path ? path.normalize(f.path).replace(/\\/g, '/').replace(/^(\.\.[\/\\])+/, '') : ''))
      .filter(Boolean)

    const firstSegment = samplePaths[0]?.includes('/') ? samplePaths[0].split('/')[0] : null
    const hasCommonRoot =
      firstSegment &&
      samplePaths.length > 0 &&
      samplePaths.every((p) => p.startsWith(`${firstSegment}/`))

    for (const file of files) {
      if (!file.path || typeof file.content !== 'string') continue
      let relPath = path.normalize(file.path).replace(/\\/g, '/').replace(/^(\.\.[\/\\])+/, '')
      if (hasCommonRoot) {
        relPath = relPath.slice(firstSegment.length + 1)
      }
      if (!relPath) continue

      const targetPath = path.join(sourceDir, relPath)
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      const buffer = Buffer.from(file.content, 'base64')
      await fs.writeFile(targetPath, buffer)
    }

    const deploymentOptions = {
      deploymentId: deploymentRow.id,
      projectId: projectRow.id,
      userId: request.user.id,
      projectName,
      slug: requestedSlug,
      repositoryFullName: null,
      repositoryUrl: null,
      repositoryLabel: 'Folder Upload',
      branch: 'main',
      environment,
      isFolderUpload: true,
    }

    const deploymentDeps = {
      io,
      supabaseAdmin: requireSupabaseAdmin(),
      deploymentBucket,
      githubToken: null,
      getDeploymentPublicUrl,
    }

    queueMicrotask(() => {
      runDeployment(deploymentDeps, deploymentOptions).catch((error) => {
        const message = error instanceof Error ? error.message : 'Deployment failed.'
        addDeploymentEvent(deploymentDeps, deploymentRow.id, request.user.id, projectRow.id, 'FAILED', message, { log: message }).catch(() => {})
      })
    })

    response.status(202).json({
      ok: true,
      deploymentId: deploymentRow.id,
      projectId: projectRow.id,
      status: 'QUEUED',
      buildUrl: `/dashboard/builds/${deploymentRow.id}`,
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/projects', requireSession, async (request, response, next) => {
  try {
    const name = asString(request.body?.name)

    if (!name) {
      response.status(400).json({ ok: false, error: 'Project name is required.' })
      return
    }

    const { projects, usage, quotas } = await getUserUsageAndQuotas(request.user.id)

    if (usage.buildMinutes >= quotas.buildMinutes) {
      response.status(403).json({
        ok: false,
        error: `Build minutes limit reached (${quotas.buildMinutes}m/${quotas.buildMinutes}m). Upgrade your plan to run more builds.`,
      })
      return
    }

    if (projects.length >= quotas.maxProjects) {
      response.status(403).json({
        ok: false,
        error: `Live websites limit reached (${quotas.maxProjects}/${quotas.maxProjects}). Upgrade your plan to deploy more websites.`,
      })
      return
    }

    const admin = requireSupabaseAdmin()
    const now = new Date().toISOString()
    const projectPayload = {
      user_id: request.user.id,
      name,
      slug: slugify(name),
      repo: asString(request.body?.repo),
      branch: asString(request.body?.branch) ?? 'main',
      status: 'queued',
      live_url: null,
      storage_bytes: 0,
      bandwidth_bytes: 0,
      build_minutes: 0,
      created_at: now,
      updated_at: now,
    }

    const { data: projectRow, error: projectError } = await admin
      .from('osstack_projects')
      .insert(projectPayload)
      .select('*')
      .single()

    if (projectError) {
      throw projectError
    }

    const { error: deploymentError } = await admin.from('osstack_deployments').insert({
      user_id: request.user.id,
      project_id: projectRow.id,
      project_name: projectRow.name,
      status: 'Queued',
      detail: 'Deployment created and waiting for build worker',
      created_at: now,
    })

    if (deploymentError) {
      throw deploymentError
    }

    response.status(201).json({
      ok: true,
      project: toDashboardProject(projectRow),
      dashboard: await getDashboardForUser(request.user.id),
    })
  } catch (error) {
    next(error)
  }
})

app.use(async (request, response, next) => {
  try {
    let slug = getDeploymentSlugFromHost(request.get('host'))

    if (!slug && !request.path.startsWith('/api/') && !request.path.startsWith('/auth/') && !request.path.startsWith('/health') && !request.path.startsWith('/apps/')) {
      const referer = request.get('referer') || request.get('referrer')
      if (referer) {
        const match = referer.match(/\/apps\/([^/?#]+)/)
        if (match) {
          slug = match[1]
        }
      }
    }

    if (!slug) { next(); return }

    const requestedFile = getSafeDeploymentFilePath(request.path === '/' ? 'index.html' : request.path.slice(1))
    if (!requestedFile) { response.status(404).send('File not found.'); return }

    await serveDeploymentFile(requireSupabaseAdmin(), deploymentBucket, slug, requestedFile, response, { assetBase: `/apps/${slug}/` })
  } catch (error) {
    next(error)
  }
})

app.get(/^\/apps\/([^/]+)(?:\/(.*))?$/, async (request, response, next) => {
  try {
    const slug = request.params[0]
    const requestedFile = getSafeDeploymentFilePath(
      request.params[1] && !request.params[1].endsWith('/') ? request.params[1] : 'index.html',
    )

    if (!requestedFile) { response.status(404).send('File not found.'); return }

    if (requestedFile === 'index.html') {
      const localhostUrl = getLocalhostDeploymentUrl(request, slug)
      if (localhostUrl) { response.redirect(302, localhostUrl); return }
    }

    await serveDeploymentFile(requireSupabaseAdmin(), deploymentBucket, slug, requestedFile, response)
  } catch (error) {
    next(error)
  }
})


function getDeploymentSlugFromHost(hostHeader) {
  const hostname = asString(hostHeader)?.split(':')[0].toLowerCase()

  if (!hostname) {
    return null
  }

  if (hostname !== 'localhost' && hostname.endsWith('.localhost')) {
    const slug = hostname.slice(0, -'.localhost'.length)
    return slugify(slug) || null
  }

  const rootHostname = getDeploymentRootHostname()

  if (rootHostname && hostname !== rootHostname && hostname.endsWith(`.${rootHostname}`)) {
    const slug = hostname.slice(0, -(rootHostname.length + 1))
    return slugify(slug) || null
  }

  return null
}

function getLocalhostDeploymentUrl(request, slug) {
  const hostHeader = asString(request.get('host'))
  const hostname = hostHeader?.split(':')[0].toLowerCase()

  if (hostname !== 'localhost') {
    return null
  }

  const portPart = hostHeader.includes(':') ? `:${hostHeader.split(':').at(-1)}` : ''

  return `${request.protocol}://${slug}.localhost${portPart}/`
}

function getDeploymentPublicUrl(slug) {
  if (deploymentRootDomain) {
    try {
      const url = new URL(deploymentRootDomain)
      url.hostname = `${slug}.${url.hostname}`
      url.pathname = '/'
      url.search = ''
      url.hash = ''
      return url.toString().replace(/\/$/, '')
    } catch {
      return `${backendUrl}/apps/${slug}`
    }
  }

  try {
    const url = new URL(backendUrl)

    if (url.hostname === 'localhost') {
      url.hostname = `${slug}.localhost`
      url.pathname = '/'
      url.search = ''
      url.hash = ''
      return url.toString().replace(/\/$/, '')
    }
  } catch {
    return `${backendUrl}/apps/${slug}`
  }

  return `${backendUrl}/apps/${slug}`
}

function getDeploymentRootHostname() {
  if (!deploymentRootDomain) {
    return null
  }

  try {
    return new URL(deploymentRootDomain).hostname.toLowerCase()
  } catch {
    return null
  }
}

app.use((error, _request, response, _next) => {
  const message = error instanceof Error ? error.message : 'Unknown backend error'
  const status = message === 'Unauthorized' ? 401 : 500

  response.status(status).json({
    ok: false,
    error: message,
  })
})

server.listen(port, () => {
  console.log(`oSStack backend running on ${backendUrl}`)
})

async function startOAuth(provider, request, response) {
  if (!supabaseAuth) {
    throw new Error('Supabase OAuth is not configured.')
  }

  const requestOrigin = getRequestFrontendOrigin(request)

  if (requestOrigin) {
    response.cookie('osstack_frontend_origin', requestOrigin, {
      ...authCookieOptions,
      maxAge: 10 * 60 * 1000,
    })
  }

  const { data, error } = await supabaseAuth.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `${backendUrl}/auth/callback`,
      skipBrowserRedirect: true,
      queryParams:
        provider === 'google'
          ? {
              access_type: 'offline',
              prompt: 'consent',
            }
          : undefined,
    },
  })

  if (error || !data.url) {
    throw error ?? new Error(`Unable to start ${provider} login.`)
  }

  response.redirect(data.url)
}

async function requireSession(request, response, next) {
  try {
    const session = getSession(request)

    if (!session) {
      response.status(401).json({ authenticated: false, error: 'Unauthorized' })
      return
    }

    const user = await getProfileById(session.sub)

    if (!user) {
      clearAuthCookies(response)
      response.status(401).json({ authenticated: false, error: 'Unauthorized' })
      return
    }

    request.user = user
    next()
  } catch (error) {
    clearAuthCookies(response)
    next(error)
  }
}

async function getDashboardForUser(userId) {
  const user = await getProfileById(userId)

  if (!user) {
    throw new Error('Unauthorized')
  }

  const projects = await getProjectsForUser(userId)
  const deployments = await getDeploymentsForUser(userId)
  const liveProjects = projects.filter((project) => project.status === 'live')
  const storageBytes = projects.reduce((total, project) => total + Number(project.storageBytes ?? 0), 0)
  const bandwidthBytes = projects.reduce((total, project) => total + Number(project.bandwidthBytes ?? 0), 0)
  const buildMinutes = projects.reduce((total, project) => total + Number(project.buildMinutes ?? 0), 0)

  return {
    user: toPublicUser(user),
    usageRows: [
      {
        label: 'Live websites',
        value: `${liveProjects.length} / ${user.quotas.maxProjects}`,
        active: true,
        progress: getProgressDegrees(liveProjects.length, user.quotas.maxProjects),
      },
      {
        label: 'Storage used',
        value: `${formatBytes(storageBytes)} / ${formatBytes(user.quotas.storageBytes)}`,
        progress: getProgressDegrees(storageBytes, user.quotas.storageBytes),
      },
      {
        label: 'Build minutes',
        value: `${buildMinutes}m / ${user.quotas.buildMinutes}m`,
        progress: getProgressDegrees(buildMinutes, user.quotas.buildMinutes),
      },
      {
        label: 'Bandwidth used',
        value: `${formatBytes(bandwidthBytes)} / ${formatBytes(user.quotas.bandwidthBytes)}`,
        progress: getProgressDegrees(bandwidthBytes, user.quotas.bandwidthBytes),
      },
    ],
    projects,
    deploymentLogs: deployments,
    previews: [],
  }
}

async function getUserUsageAndQuotas(userId) {
  const user = await getProfileById(userId)

  if (!user) {
    throw new Error('Unauthorized')
  }

  const projects = await getProjectsForUser(userId)
  const liveProjects = projects.filter((project) => project.status === 'live')
  const storageBytes = projects.reduce((total, project) => total + Number(project.storageBytes ?? 0), 0)
  const bandwidthBytes = projects.reduce((total, project) => total + Number(project.bandwidthBytes ?? 0), 0)
  const buildMinutes = projects.reduce((total, project) => total + Number(project.buildMinutes ?? 0), 0)

  return {
    user,
    projects,
    usage: {
      liveProjectsCount: liveProjects.length,
      storageBytes,
      bandwidthBytes,
      buildMinutes,
    },
    quotas: user.quotas,
  }
}

async function ensureUser(userInput) {
  const admin = requireSupabaseAdmin()
  const now = new Date().toISOString()
  const profilePayload = {
    id: userInput.id,
    name: userInput.name ?? 'oSStack user',
    email: userInput.email ?? null,
    gmail: userInput.provider === 'google' ? userInput.email ?? null : null,
    profile_photo: userInput.profilePhoto ?? null,
    provider: userInput.provider ?? 'unknown',
    passkey: false,
    frequentquestions: false,
    email_verified: Boolean(userInput.emailVerified),
    last_sign_in_at: now,
  }

  const { data, error } = await admin
    .from('osstack_profiles')
    .upsert(profilePayload, { onConflict: 'id' })
    .select('*')
    .single()

  if (error) {
    throw error
  }

  return fromProfileRow(data)
}

async function getProfileById(userId) {
  const admin = requireSupabaseAdmin()
  const { data, error } = await admin.from('osstack_profiles').select('*').eq('id', userId).maybeSingle()

  if (error) {
    throw error
  }

  return data ? fromProfileRow(data) : null
}

async function getProjectsForUser(userId) {
  const admin = requireSupabaseAdmin()
  const { data, error } = await admin
    .from('osstack_projects')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })

  if (error) {
    throw error
  }

  return (data ?? []).map(toDashboardProject)
}

async function getDeploymentsForUser(userId) {
  const admin = requireSupabaseAdmin()
  const { data, error } = await admin
    .from('osstack_deployments')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) {
    throw error
  }

  return (data ?? []).map(toDashboardDeployment)
}

async function getDeploymentSummariesForUser(userId) {
  const admin = requireSupabaseAdmin()
  const { data, error } = await admin
    .from('osstack_deployments')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(25)

  if (error) {
    throw error
  }

  const deployments = data ?? []
  const projectIds = [...new Set(deployments.map((row) => row.project_id).filter(Boolean))]
  const projectsById = new Map()

  if (projectIds.length) {
    const { data: projectRows, error: projectsError } = await admin
      .from('osstack_projects')
      .select('id, slug, repo, branch, live_url')
      .in('id', projectIds)
      .eq('user_id', userId)

    if (projectsError) {
      throw projectsError
    }

    for (const project of projectRows ?? []) {
      projectsById.set(project.id, project)
    }
  }

  return deployments.map((row) => {
    const project = projectsById.get(row.project_id)

    return {
      id: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      status: row.status,
      detail: row.detail,
      slug: project?.slug ?? null,
      repo: project?.repo ?? null,
      branch: project?.branch ?? null,
      liveUrl: getPublicLiveUrl(project?.live_url, project?.slug),
      createdAt: row.created_at,
      time: formatRelativeTime(row.created_at),
    }
  })
}

async function getDeploymentByIdForUser(deploymentId, userId) {
  const admin = requireSupabaseAdmin()
  const { data, error } = await admin
    .from('osstack_deployments')
    .select('*')
    .eq('id', deploymentId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data
}

async function getProjectRowByIdForUser(projectId, userId) {
  if (!projectId) {
    return null
  }

  const admin = requireSupabaseAdmin()
  const { data, error } = await admin
    .from('osstack_projects')
    .select('*')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data
}



function toDeploymentDetail(deployment, project, events) {
  const publicEvents = events.map((event) => ({
    ...event,
    liveUrl: getPublicLiveUrl(event.liveUrl, project?.slug),
  }))

  return {
    id: deployment.id,
    projectId: deployment.project_id,
    projectName: deployment.project_name,
    status: deployment.status,
    detail: deployment.detail,
    createdAt: deployment.created_at,
    project: project
      ? {
          id: project.id,
          name: project.name,
          slug: project.slug,
          repo: project.repo,
          branch: project.branch,
          status: project.status,
          liveUrl: getPublicLiveUrl(project.live_url, project.slug),
          storageBytes: Number(project.storage_bytes ?? 0),
          buildMinutes: Number(project.build_minutes ?? 0),
        }
      : null,
    events: publicEvents,
  }
}



function fromSupabaseUser(user) {
  const metadata = user.user_metadata ?? {}
  const identities = user.identities ?? []
  const provider = identities[0]?.provider ?? user.app_metadata?.provider ?? 'unknown'
  const name =
    asString(metadata.full_name) ??
    asString(metadata.name) ??
    asString(metadata.user_name) ??
    user.email?.split('@')[0] ??
    'oSStack user'

  return {
    id: user.id,
    name,
    email: user.email ?? null,
    provider,
    profilePhoto: asString(metadata.avatar_url) ?? asString(metadata.picture) ?? asString(metadata.profile_photo),
    emailVerified: Boolean(user.email_confirmed_at),
  }
}

function fromProfileRow(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    gmail: row.gmail,
    profilePhoto: row.profile_photo,
    provider: row.provider,
    passkey: row.passkey,
    frequentquestions: row.frequentquestions,
    emailVerified: row.email_verified,
    quotas: {
      maxProjects: row.max_projects,
      storageBytes: Number(row.storage_bytes),
      buildMinutes: row.build_minutes,
      bandwidthBytes: Number(row.bandwidth_bytes),
    },
    createdAt: row.created_at,
    lastSignInAt: row.last_sign_in_at,
  }
}

function toPublicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    gmail: user.gmail,
    profilePhoto: user.profilePhoto,
    provider: user.provider,
    passkey: user.passkey,
    frequentquestions: user.frequentquestions,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
    lastSignInAt: user.lastSignInAt,
  }
}

function toDashboardProject(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    repo: row.repo,
    branch: row.branch,
    status: row.status,
    liveUrl: getPublicLiveUrl(row.live_url, row.slug),
    storageBytes: Number(row.storage_bytes ?? 0),
    bandwidthBytes: Number(row.bandwidth_bytes ?? 0),
    buildMinutes: Number(row.build_minutes ?? 0),
    updatedAt: row.updated_at,
  }
}

function getPublicLiveUrl(liveUrl, slug) {
  if (!liveUrl) {
    return null
  }

  try {
    const url = new URL(liveUrl)

    if (url.hostname.endsWith('.localhost')) {
      const localhostSlug = url.hostname.slice(0, -'.localhost'.length)
      const resolvedSlug = slug ?? slugify(localhostSlug)

      return resolvedSlug ? getDeploymentPublicUrl(resolvedSlug) : liveUrl
    }
  } catch {
    return slug ? getDeploymentPublicUrl(slug) : liveUrl
  }

  return liveUrl
}

function toDashboardDeployment(row) {
  return {
    id: row.id,
    name: row.project_name,
    status: row.status,
    detail: row.detail,
    time: formatRelativeTime(row.created_at),
  }
}

function requireSupabaseAdmin() {
  if (!supabaseAdmin) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY. Add it to osstack backend/.env so the backend can use the Supabase tables.')
  }

  return supabaseAdmin
}

function setSessionCookie(response, userId) {
  const sessionToken = signJwt({ sub: userId })

  response.cookie('osstack_session', sessionToken, {
    ...authCookieOptions,
    maxAge: sessionMaxAge,
  })

  return sessionToken
}

function clearAuthCookies(response) {
  response.clearCookie('osstack_session', authCookieOptions)
  response.clearCookie('osstack_access_token', { path: '/' })
  response.clearCookie('osstack_refresh_token', { path: '/' })
  response.clearCookie('osstack_frontend_origin', authCookieOptions)
}

function signJwt(payload) {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const body = { ...payload, iat: now, exp: now + sessionDays * 24 * 60 * 60 }
  const unsignedToken = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(body))}`
  const signature = crypto.createHmac('sha256', jwtSecret).update(unsignedToken).digest('base64url')

  return `${unsignedToken}.${signature}`
}

function verifyJwt(token) {
  const [encodedHeader, encodedBody, signature] = token.split('.')

  if (!encodedHeader || !encodedBody || !signature) {
    return null
  }

  const unsignedToken = `${encodedHeader}.${encodedBody}`
  const expectedSignature = crypto.createHmac('sha256', jwtSecret).update(unsignedToken).digest('base64url')

  if (signature.length !== expectedSignature.length) {
    return null
  }

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return null
  }

  const payload = JSON.parse(Buffer.from(encodedBody, 'base64url').toString('utf8'))

  if (!payload.sub || Number(payload.exp) < Math.floor(Date.now() / 1000)) {
    return null
  }

  return payload
}

function getSession(request) {
  const authorizationHeader = request.headers.authorization
  const bearerToken = authorizationHeader?.startsWith('Bearer ') ? authorizationHeader.slice('Bearer '.length).trim() : null
  const cookieToken = typeof request.cookies.osstack_session === 'string' ? request.cookies.osstack_session : null
  const token = bearerToken ?? cookieToken

  return token ? verifyJwt(token) : null
}

function getSessionFromCookieHeader(cookieHeader) {
  if (typeof cookieHeader !== 'string') {
    return null
  }

  const cookies = Object.fromEntries(
    cookieHeader.split(';').map((cookieValue) => {
      const [name, ...valueParts] = cookieValue.trim().split('=')
      return [name, decodeURIComponent(valueParts.join('='))]
    }),
  )

  return cookies.osstack_session ? verifyJwt(cookies.osstack_session) : null
}

function getDeploymentRoom(deploymentId) {
  return `deployment:${deploymentId}`
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url')
}

function getRequestFrontendOrigin(request) {
  const origin = request.get('origin') ?? request.get('referer')

  if (!origin) {
    return null
  }

  try {
    const parsedUrl = new URL(origin)
    return `${parsedUrl.protocol}//${parsedUrl.host}`
  } catch {
    return null
  }
}

function getRedirectFrontendUrl(request) {
  const originCookie = typeof request.cookies.osstack_frontend_origin === 'string' ? request.cookies.osstack_frontend_origin : null
  const requestOrigin = getRequestFrontendOrigin(request)

  if (originCookie && isAllowedOrigin(originCookie)) return trimTrailingSlash(originCookie)
  if (requestOrigin && isAllowedOrigin(requestOrigin)) return trimTrailingSlash(requestOrigin)

  return frontendUrl
}

function isAllowedOrigin(origin) {
  if (!origin) return false
  const cleanOrigin = trimTrailingSlash(origin).toLowerCase()
  return /^https?:\/\/[a-z0-9_.-]+(:\d+)?$/i.test(cleanOrigin)
}

function getSingleQueryValue(value) {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : null
  }

  return typeof value === 'string' ? value : null
}

function asString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}

function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function formatBytes(value) {
  if (!value) {
    return '0 MB'
  }

  if (value >= 1024 * 1024 * 1024) {
    return `${stripTrailingZero(value / 1024 / 1024 / 1024)} GB`
  }

  return `${stripTrailingZero(value / 1024 / 1024)} MB`
}





function getProgressDegrees(value, maxValue) {
  if (!value || !maxValue) {
    return 0
  }

  return Math.min(360, Math.max(0, Math.round((Number(value) / Number(maxValue)) * 360)))
}

function stripTrailingZero(value) {
  return Number(value.toFixed(2)).toString()
}

function formatRelativeTime(value) {
  const timestamp = new Date(value).getTime()
  const diffMs = Date.now() - timestamp
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000))

  if (diffMinutes < 1) {
    return 'just now'
  }

  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`
  }

  const diffHours = Math.floor(diffMinutes / 60)

  if (diffHours < 24) {
    return `${diffHours}h ago`
  }

  return `${Math.floor(diffHours / 24)}d ago`
}

function getRepositoryLabelFromUrl(value) {
  if (!value) {
    return null
  }

  try {
    const url = new URL(value)
    const cleanPath = url.pathname.replace(/\.git$/, '').replace(/^\/+|\/+$/g, '')

    return cleanPath || url.hostname
  } catch {
    return value
  }
}

function sanitizeEnvironmentVariables(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const environment = {}

  for (const [key, rawValue] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key) || rawValue == null) {
      continue
    }

    const stringValue = String(rawValue)

    if (stringValue.length > 4000) {
      continue
    }

    environment[key] = stringValue
  }

  return environment
}

function isSafeGitRepositoryUrl(value) {
  if (!value || value.length > 260) {
    return false
  }

  try {
    const url = new URL(value)

    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
      return false
    }

    return /\.git$/.test(url.pathname) || url.hostname === 'github.com'
  } catch {
    return false
  }
}

async function cleanStaleDeployments() {
  try {
    const admin = getSupabaseAdmin()
    if (!admin) return

    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()

    const { data: staleDeployments } = await admin
      .from('osstack_deployments')
      .select('id, project_id, user_id')
      .in('status', ['QUEUED', 'CLONING', 'INSTALLING', 'BUILDING', 'UPLOADING'])
      .lt('created_at', tenMinutesAgo)

    if (!staleDeployments || !staleDeployments.length) return

    for (const dep of staleDeployments) {
      const message = 'Deployment timed out after 10 minutes.'

      await admin
        .from('osstack_deployments')
        .update({ status: 'FAILED', detail: message })
        .eq('id', dep.id)

      await admin
        .from('osstack_projects')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', dep.project_id)

      addDeploymentEvent(
        { io, supabaseAdmin: admin, getDeploymentPublicUrl, deploymentBucket },
        dep.id,
        dep.user_id,
        dep.project_id,
        'FAILED',
        message,
        { log: message },
      ).catch(() => {})
    }
  } catch {}
}

setInterval(cleanStaleDeployments, 15 * 1000).unref?.()
cleanStaleDeployments()
