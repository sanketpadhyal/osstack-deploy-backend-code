import cookieParser from 'cookie-parser'
import cors from 'cors'
import dotenv from 'dotenv'
import express, { type NextFunction, type Request, type Response } from 'express'
import { createClient, type User } from '@supabase/supabase-js'

dotenv.config()

const requiredEnv = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'] as const

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
}

const app = express()
const port = Number(process.env.PORT ?? 8080)
const backendUrl = trimTrailingSlash(process.env.BACKEND_URL ?? `http://localhost:${port}`)
const frontendUrl = trimTrailingSlash(process.env.FRONTEND_URL ?? 'http://localhost:3000')
const allowedFrontendOrigins = new Set(
  [
    frontendUrl,
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
  sameSite: cookieSecure ? ('none' as const) : ('lax' as const),
  path: '/',
}

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
  auth: {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false,
  },
})

app.use(express.json())
app.use(cookieParser())
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || isAllowedOrigin(origin)) {
        callback(null, true)
        return
      }

      callback(new Error(`CORS blocked origin: ${origin}`))
    },
    credentials: true,
  }),
)

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'osstack-auth' })
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

    const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)

    if (exchangeError || !data.session) {
      throw exchangeError ?? new Error('Supabase did not return a session.')
    }

    setAuthCookies(response, data.session.access_token, data.session.refresh_token)
    response.clearCookie('osstack_frontend_origin', { path: '/' })

    response.redirect(`${redirectFrontendUrl}/authentication?auth=success`)
  } catch (error) {
    next(error)
  }
})

app.get('/auth/me', async (request, response, next) => {
  try {
    const accessToken = getAccessToken(request)

    if (!accessToken) {
      response.status(401).json({ authenticated: false })
      return
    }

    const user = await getVerifiedUser(accessToken)

    response.json({
      authenticated: true,
      user: toOsstackUser(user),
    })
  } catch (error) {
    clearAuthCookies(response)
    next(error)
  }
})

app.post('/auth/logout', (_request, response) => {
  clearAuthCookies(response)
  response.json({ ok: true })
})

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : 'Unknown auth error'

  response.status(500).json({
    ok: false,
    error: message,
  })
})

app.listen(port, () => {
  console.log(`oSStack auth backend running on ${backendUrl}`)
})

async function startOAuth(provider: 'google' | 'github', request: Request, response: Response) {
  const requestOrigin = getRequestFrontendOrigin(request)

  if (requestOrigin) {
    response.cookie('osstack_frontend_origin', requestOrigin, {
      ...authCookieOptions,
      maxAge: 10 * 60 * 1000,
    })
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
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

async function getVerifiedUser(accessToken: string) {
  const { data, error } = await supabase.auth.getUser(accessToken)

  if (error || !data.user) {
    throw error ?? new Error('Unable to verify Supabase user.')
  }

  return data.user
}

function toOsstackUser(user: User) {
  const metadata = user.user_metadata ?? {}
  const identities = user.identities ?? []
  const provider = identities[0]?.provider ?? user.app_metadata.provider ?? 'unknown'
  const name =
    asString(metadata.full_name) ??
    asString(metadata.name) ??
    asString(metadata.user_name) ??
    user.email?.split('@')[0] ??
    'oSStack user'
  const profilePhoto =
    asString(metadata.avatar_url) ??
    asString(metadata.picture) ??
    asString(metadata.profile_photo) ??
    null

  return {
    id: user.id,
    name,
    email: user.email ?? null,
    gmail: provider === 'google' ? user.email ?? null : null,
    profilePhoto,
    provider,
    passkey: false,
    frequentquestions: false,
    emailVerified: Boolean(user.email_confirmed_at),
    createdAt: user.created_at,
    lastSignInAt: user.last_sign_in_at,
  }
}

function setAuthCookies(response: Response, accessToken: string, refreshToken: string) {
  response.cookie('osstack_access_token', accessToken, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'lax',
    maxAge: 60 * 60 * 1000,
    path: '/',
  })

  response.cookie('osstack_refresh_token', refreshToken, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  })
}

function clearAuthCookies(response: Response) {
  response.clearCookie('osstack_access_token', { path: '/' })
  response.clearCookie('osstack_refresh_token', { path: '/' })
  response.clearCookie('osstack_frontend_origin', authCookieOptions)
}

function getAccessToken(request: Request) {
  const authorizationHeader = request.headers.authorization

  if (authorizationHeader?.startsWith('Bearer ')) {
    return authorizationHeader.slice('Bearer '.length).trim()
  }

  return typeof request.cookies.osstack_access_token === 'string' ? request.cookies.osstack_access_token : null
}

function getSingleQueryValue(value: Request['query'][string]) {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : null
  }

  return typeof value === 'string' ? value : null
}

function isAllowedOrigin(origin: string) {
  if (allowedFrontendOrigins.has(trimTrailingSlash(origin))) {
    return true
  }

  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(origin)) {
    return true
  }

  return /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)
}

function getRedirectFrontendUrl(request: Request) {
  const originCookie = typeof request.cookies.osstack_frontend_origin === 'string' ? request.cookies.osstack_frontend_origin : null

  return originCookie && isAllowedOrigin(originCookie) ? originCookie : frontendUrl
}

function getRequestFrontendOrigin(request: Request) {
  const origin = request.get('origin')

  if (origin && isAllowedOrigin(origin)) {
    return origin
  }

  const referer = request.get('referer')

  if (!referer) {
    return null
  }

  try {
    const refererOrigin = new URL(referer).origin
    return isAllowedOrigin(refererOrigin) ? refererOrigin : null
  } catch {
    return null
  }
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
