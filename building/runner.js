import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

import { findDeployableApp, getInstallCommand, getBuildCommand, getOutputDirectory } from './detector.js'
import { addDeploymentEvent } from './events.js'
import { ensureDeploymentBucket, uploadDirectoryToStorage } from './storage.js'

const BUILD_ROOT = path.join(os.tmpdir(), 'osstack-builds')
const OVERALL_DEPLOYMENT_TIMEOUT_MS = getDurationFromEnv('OSSTACK_DEPLOYMENT_TIMEOUT_MS', 10 * 60 * 1000)
const INSTALL_TIMEOUT_MS = getDurationFromEnv('OSSTACK_INSTALL_TIMEOUT_MS', 5 * 60 * 1000)
const BUILD_TIMEOUT_MS = getDurationFromEnv('OSSTACK_BUILD_TIMEOUT_MS', 5 * 60 * 1000)
const COMMAND_TIMEOUT_MS = getDurationFromEnv('OSSTACK_COMMAND_TIMEOUT_MS', 4 * 60 * 1000)

export async function runDeployment(deps, options) {
  const { supabaseAdmin, deploymentBucket } = deps
  const startedAt = Date.now()
  const buildDir = path.join(BUILD_ROOT, String(options.deploymentId))
  const sourceDir = path.join(buildDir, 'source')

  if (!options.isFolderUpload) {
    await fs.rm(buildDir, { force: true, recursive: true })
    await fs.mkdir(buildDir, { recursive: true })
  } else {
    await fs.mkdir(sourceDir, { recursive: true })
  }

  let timeoutTimer = null

  const timeoutPromise = new Promise((_, reject) => {
    timeoutTimer = setTimeout(() => {
      reject(new Error('Deployment timed out after 10 minutes.'))
    }, OVERALL_DEPLOYMENT_TIMEOUT_MS)
  })

  try {
    await Promise.race([
      executeDeploymentSteps(deps, options, startedAt, buildDir, sourceDir, supabaseAdmin, deploymentBucket),
      timeoutPromise,
    ])
  } catch (error) {
    let message = error instanceof Error ? error.message : 'Deployment failed.'
    if (
      message.includes('timed out') ||
      message.includes('OSSTACK_COMMAND_TIMEOUT') ||
      message.includes('ETIMEDOUT')
    ) {
      message = 'Deployment timed out after 10 minutes.'
    }

    await supabaseAdmin
      .from('osstack_projects')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', options.projectId)
      .eq('user_id', options.userId)

    await supabaseAdmin
      .from('osstack_deployments')
      .update({ status: 'FAILED', detail: message })
      .eq('id', options.deploymentId)
      .eq('user_id', options.userId)

    await emit(deps, options, 'FAILED', message, { log: message })
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    await fs.rm(buildDir, { force: true, recursive: true }).catch(() => {})
  }
}

async function executeDeploymentSteps(deps, options, startedAt, buildDir, sourceDir, supabaseAdmin, deploymentBucket) {
  const { data: userProfile } = await supabaseAdmin.from('osstack_profiles').select('*').eq('id', options.userId).maybeSingle()
  const maxBuildMinutes = userProfile?.build_minutes ?? 100
  const maxStorageBytes = Number(userProfile?.storage_bytes ?? 1073741824)

  const { data: userProjects } = await supabaseAdmin.from('osstack_projects').select('*').eq('user_id', options.userId)
  const totalBuildMinutes = (userProjects ?? []).reduce((total, p) => total + Number(p.build_minutes ?? 0), 0)

  if (totalBuildMinutes >= maxBuildMinutes) {
    throw new Error(`Build minutes limit reached (${maxBuildMinutes}m/${maxBuildMinutes}m). Upgrade your plan to run more builds.`)
  }

  await ensureDeploymentBucket(supabaseAdmin, deploymentBucket)
  await emit(deps, options, 'QUEUED', 'Deployment created')
  await emit(deps, options, 'CLONING', `Cloning ${options.repositoryLabel ?? options.repositoryFullName}`)

  await cloneRepository(deps, options, buildDir, sourceDir)

  const appInfo = await findDeployableApp(sourceDir)
  const appDir = appInfo.directory

  const detectionMsg = appDir !== sourceDir
    ? `Detected ${appInfo.type === 'static' ? 'static HTML site' : 'frontend app'} in ${path.relative(sourceDir, appDir)}/`
    : appInfo.type === 'static'
      ? 'Detected static HTML site'
      : null

  if (detectionMsg) await emit(deps, options, 'CLONING', detectionMsg)

  let outputDir = appDir

  if (appInfo.type === 'package') {
    await emit(deps, options, 'INSTALLING', 'Installing dependencies')
    const installCmd = await getInstallCommand(appDir)
    await runInstallCommand(deps, options, appDir, installCmd)

    const buildCmd = await getBuildCommand(appDir, installCmd.packageManager)
    await emit(deps, options, 'BUILDING', `Running: ${buildCmd}`)
    await runBuildWithRetry(deps, options, appDir, buildCmd)

    outputDir = await getOutputDirectory(appDir)

    if (!outputDir) {
      throw new Error(
        'Build finished but no static output folder was found. ' +
        'Checked dist/, build/, out/, public/, and more. ' +
        'Make sure your build script writes output to one of those directories.',
      )
    }
  } else {
    await emit(deps, options, 'BUILDING', 'No build needed for static HTML')
  }

  await emit(deps, options, 'UPLOADING', `Uploading ${path.basename(outputDir)}/`)
  const storagePrefix = `deployments/${options.projectId}/${options.deploymentId}`
  const storageBytes = await uploadDirectoryToStorage(supabaseAdmin, deploymentBucket, outputDir, storagePrefix)

  const otherProjectsStorage = (userProjects ?? [])
    .filter((p) => p.id !== options.projectId)
    .reduce((total, p) => total + Number(p.storage_bytes ?? 0), 0)

  if (otherProjectsStorage + storageBytes > maxStorageBytes) {
    throw new Error(`Storage limit exceeded. Upgrade your plan to store more files.`)
  }

  const liveUrl = deps.getDeploymentPublicUrl(options.slug)
  const buildMinutes = Math.max(1, Math.ceil((Date.now() - startedAt) / 60000))
  const completedAt = new Date().toISOString()

  await supabaseAdmin
    .from('osstack_projects')
    .update({ status: 'live', live_url: liveUrl, storage_bytes: storageBytes, build_minutes: buildMinutes, updated_at: completedAt })
    .eq('id', options.projectId)
    .eq('user_id', options.userId)

  await supabaseAdmin
    .from('osstack_deployments')
    .update({ status: 'COMPLETED', detail: 'Deployment completed' })
    .eq('id', options.deploymentId)
    .eq('user_id', options.userId)

  await emit(deps, options, 'COMPLETED', 'Deployment completed', { liveUrl })
}

async function cloneRepository(deps, options, buildDir, sourceDir) {
  if (options.isFolderUpload) {
    await emit(deps, options, 'CLONING', 'Folder uploaded successfully. Analyzing project structure.')
    return
  }

  const githubRef = getGitHubRepositoryReference(options)
  const { githubToken } = deps
  const redactions = githubToken ? [githubToken, encodeURIComponent(githubToken)] : []

  if (githubRef) {
    await downloadGitHubArchive(deps, options, githubRef, buildDir, sourceDir, redactions)
    return
  }

  const cloneUrl = buildGitCloneUrl(options, githubToken)
  await runCommand(deps, options, 'git', ['clone', '--depth', '1', '--branch', options.branch, cloneUrl, sourceDir], {
    cwd: buildDir,
    stage: 'CLONING',
    redactions,
  })
}

async function downloadGitHubArchive(deps, options, repositoryFullName, buildDir, sourceDir, redactions) {
  const branch = options.branch || 'main'
  const archiveUrl = `https://api.github.com/repos/${repositoryFullName}/tarball/${encodeURIComponent(branch)}`
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'oSStack Deploy' }
  if (deps.githubToken) headers.Authorization = `Bearer ${deps.githubToken}`

  await emit(deps, options, 'CLONING', `Downloading ${repositoryFullName} archive`)

  const response = await fetch(archiveUrl, { headers, redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`GitHub archive download failed with status ${response.status}.`)
  }

  const archiveBuffer = Buffer.from(await response.arrayBuffer())
  await emit(deps, options, 'CLONING', 'Extracting repository archive')
  await extractTarGz(archiveBuffer, sourceDir)
}

async function runInstallCommand(deps, options, sourceDir, installCmd) {
  const baseOptions = {
    cwd: sourceDir,
    stage: 'INSTALLING',
    timeoutMs: INSTALL_TIMEOUT_MS,
    env: getPackageManagerEnvironment(),
  }

  try {
    await runCommand(deps, options, installCmd.command, installCmd.args, baseOptions)
    return
  } catch (error) {
    if (isTimeoutError(error)) throw error

    if (installCmd.packageManager !== 'npm') {
      await emit(
        deps,
        options,
        'INSTALLING',
        `${installCmd.packageManager} install failed or is missing on host. Falling back to npm install.`,
      )
      const npmFallback = { command: 'npm', args: ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'], packageManager: 'npm' }
      try {
        await runCommand(deps, options, npmFallback.command, npmFallback.args, baseOptions)
        return
      } catch (npmError) {
        if (isTimeoutError(npmError)) throw npmError
      }
    }

    const retry = getInstallRetryCommand(installCmd)
    if (retry) {
      await emit(deps, options, 'INSTALLING', `${installCmd.packageManager} install failed once. Retrying with compatibility flags.`)
      await runCommand(deps, options, retry.command, retry.args, baseOptions)
    } else {
      throw error
    }
  }
}

async function runBuildWithRetry(deps, options, sourceDir, buildCmd) {
  try {
    await runShellCommand(deps, options, buildCmd, {
      cwd: sourceDir,
      stage: 'BUILDING',
      timeoutMs: BUILD_TIMEOUT_MS,
      env: { ...getPackageManagerEnvironment(), CI: 'false' },
    })
  } catch (error) {
    const configError = getKnownConfigError(error)
    if (configError) throw new Error(configError)

    const missingCmd = extractMissingCommand(error)
    if (missingCmd) {
      const pkgToInstall = resolvePackageForMissingCommand(missingCmd)
      await emit(deps, options, 'INSTALLING', `Missing build tool: ${missingCmd}. Installing ${pkgToInstall} and retrying build.`)
      await runCommand(deps, options, 'npm', ['install', '--save-dev', '--legacy-peer-deps', pkgToInstall], {
        cwd: sourceDir,
        stage: 'INSTALLING',
        timeoutMs: INSTALL_TIMEOUT_MS,
        env: getPackageManagerEnvironment(),
      })
      await emit(deps, options, 'BUILDING', `Retrying: ${buildCmd}`)
      await runShellCommand(deps, options, buildCmd, {
        cwd: sourceDir,
        stage: 'BUILDING',
        timeoutMs: BUILD_TIMEOUT_MS,
        env: { ...getPackageManagerEnvironment(), CI: 'false' },
      })
      return
    }

    const missingPkg = extractMissingPackage(error)
    if (missingPkg) {
      await emit(deps, options, 'INSTALLING', `Missing dependency: ${missingPkg}. Installing and retrying.`)
      await runCommand(deps, options, 'npm', ['install', '--legacy-peer-deps', missingPkg], {
        cwd: sourceDir,
        stage: 'INSTALLING',
        timeoutMs: INSTALL_TIMEOUT_MS,
        env: getPackageManagerEnvironment(),
      })
      await emit(deps, options, 'BUILDING', `Retrying: ${buildCmd}`)
      await runShellCommand(deps, options, buildCmd, {
        cwd: sourceDir,
        stage: 'BUILDING',
        timeoutMs: BUILD_TIMEOUT_MS,
        env: { ...getPackageManagerEnvironment(), CI: 'false' },
      })
      return
    }

    if (isInstallationError(error)) {
      await emit(deps, options, 'INSTALLING', 'Re-running npm install after dependency error, then retrying build.')
      await runCommand(deps, options, 'npm', ['install', '--legacy-peer-deps'], {
        cwd: sourceDir,
        stage: 'INSTALLING',
        timeoutMs: INSTALL_TIMEOUT_MS,
        env: getPackageManagerEnvironment(),
      })
      await emit(deps, options, 'BUILDING', `Retrying: ${buildCmd}`)
      await runShellCommand(deps, options, buildCmd, {
        cwd: sourceDir,
        stage: 'BUILDING',
        timeoutMs: BUILD_TIMEOUT_MS,
        env: { ...getPackageManagerEnvironment(), CI: 'false' },
      })
      return
    }

    throw error
  }
}

function runShellCommand(deps, options, command, cmdOptions) {
  return runCommand(deps, options, 'sh', ['-c', command], cmdOptions)
}

function runCommand(deps, options, command, args, cmdOptions) {
  return new Promise((resolve, reject) => {
    const cwd = cmdOptions.cwd
    const localBin = path.join(cwd, 'node_modules', '.bin')
    const timeoutMs = cmdOptions.timeoutMs ?? COMMAND_TIMEOUT_MS
    const env = {
      NODE_ENV: 'production',
      NODE_OPTIONS: '--max-old-space-size=4096',
      CI: 'false',
      NPM_CONFIG_AUDIT: 'false',
      NPM_CONFIG_FUND: 'false',
      NPM_CONFIG_PROGRESS: 'false',
      NPM_CONFIG_LOGLEVEL: 'error',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_progress: 'false',
      npm_config_loglevel: 'error',
      ...process.env,
      PATH: `${localBin}:${path.dirname(process.execPath)}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
      ...(options.environment ?? {}),
      ...(cmdOptions.env ?? {}),
    }

    const child = spawn(command, args, { cwd, env, shell: false })
    const outputTail = []
    let settled = false

    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      if (error) {
        reject(error)
        return
      }
      resolve()
    }

    const timeoutId = setTimeout(() => {
      const message = `${command} ${args.join(' ')} timed out after ${formatDuration(timeoutMs)}.`
      const error = new Error(message)
      error.code = 'OSSTACK_COMMAND_TIMEOUT'
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 5000).unref?.()
      finish(error)
    }, timeoutMs)
    timeoutId.unref?.()

    const onData = (chunk) => {
      const redactions = [...(cmdOptions.redactions ?? []), ...Object.values(options.environment ?? {})]
      const clean = redactSecrets(chunk.toString(), redactions).trim()
      if (!clean) return

      outputTail.push(clean)
      if (outputTail.length > 20) outputTail.shift()

      addDeploymentEvent(
        deps,
        options.deploymentId,
        options.userId,
        options.projectId,
        cmdOptions.stage,
        clean,
        { log: clean },
      ).catch(() => {})
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', finish)
    child.on('close', (code) => {
      if (settled) return
      if (code === 0) { finish(); return }
      const tail = outputTail.join('\n').trim()
      finish(new Error(tail ? `${command} exited with code ${code}\n${tail}` : `${command} exited with code ${code}`))
    })
  })
}

function getKnownConfigError(error) {
  const msg = error instanceof Error ? error.message : String(error)
  if (msg.includes('Configuration must contain `projectId`') && msg.includes('@sanity/client')) {
    return 'Build needs Sanity environment variables. Add NEXT_PUBLIC_SANITY_PROJECT_ID and NEXT_PUBLIC_SANITY_DATASET, then deploy again.'
  }
  return null
}

const KNOWN_CLI_PACKAGE_MAP = {
  tsc: 'typescript',
  vite: 'vite',
  vue: '@vue/cli-service',
  'vue-cli-service': '@vue/cli-service',
  ng: '@angular/cli',
  craco: '@craco/craco',
  'react-scripts': 'react-scripts',
  'react-app-rewired': 'react-app-rewired',
  next: 'next',
  nuxt: 'nuxt',
  gatsby: 'gatsby',
  astro: 'astro',
  remix: '@remix-run/dev',
  parcel: 'parcel',
  rollup: 'rollup',
  webpack: 'webpack',
  'webpack-cli': 'webpack-cli',
  tailwind: 'tailwindcss',
  tailwindcss: 'tailwindcss',
  esbuild: 'esbuild',
  turbo: 'turbo',
  nx: 'nx',
  docusaurus: '@docusaurus/core',
  eleventy: '@11ty/eleventy',
  ember: 'ember-cli',
  qwik: '@builder.io/qwik',
}

function resolvePackageForMissingCommand(cmd) {
  return KNOWN_CLI_PACKAGE_MAP[cmd] ?? cmd
}

function extractMissingCommand(error) {
  const msg = error instanceof Error ? error.message : String(error)
  const match =
    msg.match(/(?:sh: \d+: |\/bin\/sh: \d+: |command not found: |': |: )([a-zA-Z0-9_@/-]+): not found/) ||
    msg.match(/([a-zA-Z0-9_@/-]+): command not found/) ||
    msg.match(/([a-zA-Z0-9_@/-]+): No such file or directory/)
  if (match && match[1]) {
    const cmd = match[1]
    if (isSafePackageName(cmd)) return cmd
  }
  return null
}

function extractMissingPackage(error) {
  const msg = error instanceof Error ? error.message : String(error)
  const match = msg.match(/Can't resolve '([^']+)'|Cannot find module '([^']+)'/)
  const importPath = match?.[1] ?? match?.[2]
  if (!importPath || importPath.startsWith('.') || importPath.startsWith('/') || importPath.includes('\0')) return null
  const pkgName = importPath.startsWith('@')
    ? importPath.split('/').slice(0, 2).join('/')
    : importPath.split('/')[0]
  return isSafePackageName(pkgName) ? pkgName : null
}

function isInstallationError(error) {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    msg.includes('missing:') ||
    msg.includes('cannot find module') ||
    msg.includes("can't resolve") ||
    msg.includes('module not found') ||
    msg.includes('not found in the pkg') ||
    msg.includes('enoent') ||
    msg.includes('peer dep') ||
    msg.includes('unresolved') ||
    msg.includes('package not installed')
  )
}

function isSafePackageName(value) {
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(value)
}

function getInstallRetryCommand(installCmd) {
  if (installCmd.packageManager === 'npm') {
    return {
      command: 'npm',
      args: ['install', '--legacy-peer-deps', '--no-audit', '--no-fund', '--prefer-online'],
    }
  }

  if (installCmd.packageManager === 'pnpm') {
    return {
      command: 'pnpm',
      args: ['install', '--no-frozen-lockfile', '--prefer-offline=false'],
    }
  }

  if (installCmd.packageManager === 'yarn') {
    return {
      command: 'yarn',
      args: ['install', '--non-interactive', '--ignore-engines'],
    }
  }

  return null
}

function getPackageManagerEnvironment() {
  return {
    CI: 'false',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_PROGRESS: 'false',
    NPM_CONFIG_LOGLEVEL: 'error',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_progress: 'false',
    npm_config_loglevel: 'error',
    YARN_ENABLE_TELEMETRY: '0',
    NEXT_TELEMETRY_DISABLED: '1',
  }
}

function isTimeoutError(error) {
  return error && typeof error === 'object' && error.code === 'OSSTACK_COMMAND_TIMEOUT'
}

function getDurationFromEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.round(seconds / 60)}m`
}

function getGitHubRepositoryReference(options) {
  if (options.repositoryFullName && /^[\w.-]+\/[\w.-]+$/.test(options.repositoryFullName)) {
    return options.repositoryFullName.replace(/\.git$/, '')
  }
  if (!options.repositoryUrl) return null
  try {
    const url = new URL(options.repositoryUrl)
    if (url.hostname !== 'github.com') return null
    const parts = url.pathname.replace(/\.git$/, '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  } catch { return null }
}

function buildGitCloneUrl(options, githubToken) {
  if (options.repositoryUrl) return options.repositoryUrl
  if (!githubToken) return `https://github.com/${options.repositoryFullName}.git`
  return `https://x-access-token:${encodeURIComponent(githubToken)}@github.com/${options.repositoryFullName}.git`
}

function redactSecrets(value, secrets) {
  return secrets.reduce((text, secret) => (secret ? text.replaceAll(secret, '[redacted]') : text), value)
}

function emit(deps, options, stage, message, extras = {}) {
  return addDeploymentEvent(deps, options.deploymentId, options.userId, options.projectId, stage, message, extras)
}

async function extractTarGz(buffer, destDir) {
  const tarBuffer = zlib.gunzipSync(buffer)
  let offset = 0

  await fs.mkdir(destDir, { recursive: true })

  while (offset < tarBuffer.length) {
    if (offset + 512 > tarBuffer.length) break

    const header = tarBuffer.subarray(offset, offset + 512)
    const isEof = header.every((x) => x === 0)
    if (isEof) break

    let fileName = header.subarray(0, 100).toString('utf8').replace(/\0+$/, '')
    const prefix = header.subarray(345, 345 + 155).toString('utf8').replace(/\0+$/, '')
    if (prefix) {
      fileName = `${prefix}/${fileName}`
    }

    const sizeString = header.subarray(124, 124 + 12).toString('utf8').trim().replace(/\0+$/, '')
    const fileSize = parseInt(sizeString, 8)
    const typeFlag = String.fromCharCode(header[156])

    offset += 512

    if (fileName && !fileName.includes('..')) {
      const parts = fileName.split('/').filter(Boolean)
      if (parts.length > 1) {
        const relativePath = parts.slice(1).join('/')
        const destPath = path.join(destDir, relativePath)

        if (typeFlag === '5') {
          await fs.mkdir(destPath, { recursive: true })
        } else if (typeFlag === '0' || typeFlag === '\0') {
          await fs.mkdir(path.dirname(destPath), { recursive: true })
          const fileData = tarBuffer.subarray(offset, offset + fileSize)
          await fs.writeFile(destPath, fileData)
        }
      }
    }

    offset += Math.ceil(fileSize / 512) * 512
  }
}

export { getGitHubRepositoryReference, buildGitCloneUrl, extractTarGz }
