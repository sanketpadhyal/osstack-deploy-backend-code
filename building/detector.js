import fs from 'node:fs/promises'
import path from 'node:path'

export const FRAMEWORK_BUILD_COMMANDS = [
  ['react-scripts',            'react-scripts build'],
  ['vite',                     'vite build'],
  ['next',                     'next build'],
  ['nuxt',                     'nuxt build'],
  ['nuxt-edge',                'nuxt build'],
  ['nuxt3',                    'nuxt build'],
  ['@remix-run/dev',           'remix build'],
  ['gatsby',                   'gatsby build'],
  ['astro',                    'astro build'],
  ['@angular/cli',             'ng build --configuration production'],
  ['@vue/cli-service',         'vue-cli-service build'],
  ['vue-cli-service',          'vue-cli-service build'],
  ['vue',                      'vite build'],
  ['@sveltejs/kit',            'svelte-kit build'],
  ['@sveltejs/adapter-static', 'svelte-kit build'],
  ['svelte',                   'rollup -c'],
  ['parcel',                   'parcel build index.html'],
  ['webpack',                  'webpack --mode production'],
  ['webpack-cli',              'webpack --mode production'],
  ['rollup',                   'rollup -c'],
  ['turbo',                    'turbo run build'],
  ['nx',                       'nx build'],
  ['expo',                     'expo export:web'],
  ['@craco/craco',             'craco build'],
  ['react-app-rewired',        'react-app-rewired build'],
  ['umi',                      'umi build'],
  ['@elderjs/elderjs',         'elder build'],
  ['solid-start',              'solid-start build'],
  ['@builder.io/qwik',         'qwik build'],
  ['@docusaurus/core',         'docusaurus build'],
  ['@11ty/eleventy',           'eleventy'],
  ['ember-cli',                'ember build --environment=production'],
]

export const DEPLOYABLE_PACKAGE_MARKERS = [
  'vite', 'webpack', 'webpack-cli', 'webpack-dev-server', 'parcel', 'rollup', 'esbuild', 'turbo', 'nx',
  'react', 'react-dom', 'react-scripts', 'react-app-rewired', '@craco/craco',
  'next', 'nuxt', 'nuxt-edge', 'nuxt3',
  '@remix-run/dev', '@remix-run/react',
  'gatsby',
  'astro',
  '@angular/cli', '@angular/core',
  '@vue/cli-service', 'vue', 'vue-router', 'pinia', 'vuex',
  'svelte', '@sveltejs/kit', '@sveltejs/adapter-auto', '@sveltejs/adapter-static',
  'solid-js', 'solid-start',
  '@builder.io/qwik', '@builder.io/qwik-city',
  'expo',
  'umi', '@elderjs/elderjs', '@docusaurus/core', '@11ty/eleventy', 'ember-cli',
  '@storybook/react', '@storybook/vue', '@storybook/svelte',
  'babel-cli', '@babel/cli', 'typescript', 'tailwindcss',
]

const SKIP_PACKAGE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.vercel'])
const SKIP_STATIC_DIRS = new Set(['.git', 'node_modules', '.next', '.vercel'])
const SKIP_OUTPUT_DIRS = new Set(['.git', 'node_modules', '.cache', '.next', '.vercel'])

const PREFERRED_APP_DIRS = [
  'frontend', 'client', 'app', 'web', 'website', 'site',
  'packages/app', 'packages/web', 'packages/frontend',
  'apps/web', 'apps/app', 'apps/frontend',
  'public', 'static', 'html', 'docs',
]

const OUTPUT_CANDIDATES = [
  'dist', 'build', 'out', '.output/public', 'output',
  'public', 'static', '.next/out', '.next/standalone',
  '.svelte-kit/output/prerendered', 'storybook-static',
  'www', 'docs', 'site', '_site', 'coverage', 'html',
]

export async function findDeployableApp(sourceDirectory) {
  const rootPackage = await readPackageJson(sourceDirectory)

  if (isDeployablePackage(rootPackage)) {
    return { directory: sourceDirectory, type: 'package' }
  }

  for (const relDir of PREFERRED_APP_DIRS) {
    const dir = path.join(sourceDirectory, relDir)
    const pkg = await readPackageJson(dir)
    if (isDeployablePackage(pkg)) return { directory: dir, type: 'package' }
  }

  const pkgDirs = await findPackageDirectories(sourceDirectory, 3)
  const deployableDir = pkgDirs.find((d) => d !== sourceDirectory)
  if (deployableDir) return { directory: deployableDir, type: 'package' }

  if (await isStaticHtmlDirectory(sourceDirectory)) {
    return { directory: sourceDirectory, type: 'static' }
  }

  for (const relDir of PREFERRED_APP_DIRS) {
    const dir = path.join(sourceDirectory, relDir)
    if (await isStaticHtmlDirectory(dir)) return { directory: dir, type: 'static' }
  }

  const staticDir = await findStaticHtmlDirectory(sourceDirectory, 3)
  if (staticDir) return { directory: staticDir, type: 'static' }

  throw new Error(
    'No deployable frontend found. Expected a package.json with a build script, or an index.html file. ' +
    'Make sure your repository contains a frontend project.',
  )
}

export async function getInstallCommand(sourceDirectory) {
  if (await pathExists(path.join(sourceDirectory, 'pnpm-lock.yaml'))) {
    return { command: 'pnpm', args: ['install', '--no-frozen-lockfile'], packageManager: 'pnpm' }
  }

  if (await pathExists(path.join(sourceDirectory, 'yarn.lock'))) {
    return { command: 'yarn', args: ['install', '--non-interactive'], packageManager: 'yarn' }
  }

  return { command: 'npm', args: ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'], packageManager: 'npm' }
}

export async function getBuildCommand(sourceDirectory, packageManager) {
  const packageJson = await readPackageJson(sourceDirectory)
  const scripts = packageJson?.scripts ?? {}

  for (const scriptName of ['build', 'export', 'generate']) {
    if (typeof scripts[scriptName] === 'string') {
      return getPackageManagerRunCommand(packageManager, scriptName)
    }
  }

  for (const [dep, cmd] of FRAMEWORK_BUILD_COMMANDS) {
    if (hasDependency(packageJson, dep)) {
      return getPackageManagerExecCommand(packageManager, cmd)
    }
  }

  throw new Error(
    'No build script found in package.json. ' +
    'Add a "build" script (e.g. "vite build" or "react-scripts build") so oSStack can deploy this project.',
  )
}

export async function getOutputDirectory(sourceDirectory) {
  for (const candidate of OUTPUT_CANDIDATES) {
    const dir = path.join(sourceDirectory, candidate)
    const stat = await fs.stat(dir).catch(() => null)
    if (!stat?.isDirectory()) continue

    const hasAnyFile =
      (await pathExists(path.join(dir, 'index.html'))) ||
      (await directoryHasHtmlFile(dir)) ||
      (await directoryHasAnyFile(dir))

    if (hasAnyFile) return dir
  }

  return findOutputDirectory(sourceDirectory, 4)
}

export function isDeployablePackage(packageJson) {
  if (!packageJson) return false

  if (
    typeof packageJson.scripts?.build === 'string' ||
    typeof packageJson.scripts?.export === 'string' ||
    typeof packageJson.scripts?.generate === 'string'
  ) {
    return true
  }

  return hasAnyDependency(packageJson, DEPLOYABLE_PACKAGE_MARKERS)
}

async function readPackageJson(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

function hasDependency(packageJson, name) {
  return Boolean(packageJson?.dependencies?.[name] ?? packageJson?.devDependencies?.[name])
}

function hasAnyDependency(packageJson, names) {
  return names.some((name) => hasDependency(packageJson, name))
}

async function pathExists(value) {
  return fs.access(value).then(() => true).catch(() => false)
}

async function isStaticHtmlDirectory(dir) {
  const stat = await fs.stat(dir).catch(() => null)
  return Boolean(stat?.isDirectory() && (await pathExists(path.join(dir, 'index.html'))))
}

async function findPackageDirectories(dir, maxDepth, depth = 0) {
  if (depth > maxDepth) return []

  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const result = []

  if (await pathExists(path.join(dir, 'package.json'))) {
    const pkg = await readPackageJson(dir)
    if (isDeployablePackage(pkg)) result.push(dir)
  }

  if (depth === maxDepth) return result

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_PACKAGE_DIRS.has(entry.name)) continue
    result.push(...(await findPackageDirectories(path.join(dir, entry.name), maxDepth, depth + 1)))
  }

  return result
}

async function findStaticHtmlDirectory(dir, maxDepth, depth = 0) {
  if (await isStaticHtmlDirectory(dir)) return dir
  if (depth >= maxDepth) return null

  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_STATIC_DIRS.has(entry.name)) continue
    const found = await findStaticHtmlDirectory(path.join(dir, entry.name), maxDepth, depth + 1)
    if (found) return found
  }

  return null
}

async function findOutputDirectory(dir, maxDepth, depth = 0) {
  if (await pathExists(path.join(dir, 'index.html'))) return dir
  if (depth >= maxDepth) return null

  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_OUTPUT_DIRS.has(entry.name)) continue
    const found = await findOutputDirectory(path.join(dir, entry.name), maxDepth, depth + 1)
    if (found) return found
  }

  return null
}

async function directoryHasHtmlFile(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.some((e) => e.isFile() && e.name.endsWith('.html'))
}

async function directoryHasAnyFile(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  if (entries.some((e) => e.isFile())) return true

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_OUTPUT_DIRS.has(entry.name)) continue
    const sub = await fs.readdir(path.join(dir, entry.name), { withFileTypes: true }).catch(() => [])
    if (sub.some((e) => e.isFile())) return true
  }

  return false
}

function getPackageManagerRunCommand(pm, scriptName) {
  if (pm === 'pnpm') return `pnpm run ${scriptName}`
  if (pm === 'yarn') return `yarn ${scriptName}`
  return `npm run ${scriptName}`
}

function getPackageManagerExecCommand(pm, cmd) {
  if (pm === 'pnpm') return `pnpm exec ${cmd}`
  if (pm === 'yarn') return `yarn ${cmd}`
  return `npx ${cmd}`
}
