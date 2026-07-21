import fs from 'node:fs/promises'
import path from 'node:path'

const FILE_SIZE_LIMIT = 250 * 1024 * 1024

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json; charset=utf-8',
  '.obj': 'model/obj',
  '.mtl': 'text/plain; charset=utf-8',
  '.fbx': 'application/octet-stream',
  '.stl': 'model/stl',
  '.usdz': 'model/vnd.usdz+zip',
  '.bin': 'application/octet-stream',
  '.hdr': 'image/vnd.radiance',
  '.exr': 'image/aces',
  '.ktx': 'image/ktx',
  '.ktx2': 'image/ktx2',
  '.basis': 'application/octet-stream',
  '.drc': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
}

export function getContentType(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

export async function ensureDeploymentBucket(supabaseAdmin, bucketName) {
  const { data: buckets, error } = await supabaseAdmin.storage.listBuckets()
  if (error) throw error

  const options = { public: false, fileSizeLimit: FILE_SIZE_LIMIT }

  if (buckets?.some((b) => b.name === bucketName)) {
    await supabaseAdmin.storage.updateBucket(bucketName, options).catch(() => {})
    return
  }

  const { error: createError } = await supabaseAdmin.storage.createBucket(bucketName, options)
  if (createError) throw createError
}

export async function uploadDirectoryToStorage(supabaseAdmin, bucketName, directory, storagePrefix) {
  const files = await listFiles(directory)
  let totalBytes = 0

  for (const filePath of files) {
    const relativePath = path.relative(directory, filePath).split(path.sep).join('/')
    const fileBuffer = await fs.readFile(filePath)
    totalBytes += fileBuffer.byteLength

    const { error } = await supabaseAdmin.storage
      .from(bucketName)
      .upload(`${storagePrefix}/${relativePath}`, fileBuffer, {
        contentType: getContentType(relativePath),
        upsert: true,
      })

    if (error) throw error
  }

  return totalBytes
}

export async function serveDeploymentFile(supabaseAdmin, bucketName, slug, requestedFile, response, options = {}) {
  const { data: projectRow, error: projectError } = await supabaseAdmin
    .from('osstack_projects')
    .select('*')
    .eq('slug', slug)
    .maybeSingle()

  if (projectError) throw projectError
  if (!projectRow) { response.status(404).send('Deployment not found.'); return }

  const { data: userProfile } = await supabaseAdmin
    .from('osstack_profiles')
    .select('bandwidth_bytes')
    .eq('id', projectRow.user_id)
    .maybeSingle()

  const maxBandwidth = Number(userProfile?.bandwidth_bytes ?? 10737418240)

  const { data: userProjects } = await supabaseAdmin
    .from('osstack_projects')
    .select('bandwidth_bytes')
    .eq('user_id', projectRow.user_id)

  const totalBandwidth = (userProjects ?? []).reduce((total, p) => total + Number(p.bandwidth_bytes ?? 0), 0)

  if (totalBandwidth >= maxBandwidth) {
    response.status(509).send('Bandwidth limit exceeded (10 GB max). Upgrade your plan to continue serving traffic.')
    return
  }

  const { data: deploymentRow, error: deploymentError } = await supabaseAdmin
    .from('osstack_deployments')
    .select('*')
    .eq('project_id', projectRow.id)
    .eq('status', 'COMPLETED')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (deploymentError) throw deploymentError
  if (!deploymentRow) { response.status(404).send('Deployment files not found.'); return }

  let storagePath = `deployments/${projectRow.id}/${deploymentRow.id}/${requestedFile.replace(/^\/+/, '')}`
  let { data: fileBlob, error: fileError } = await supabaseAdmin.storage.from(bucketName).download(storagePath)

  if (fileError || !fileBlob) {
    const baseName = path.posix.basename(requestedFile)
    const sansLeadingFolder = requestedFile.includes('/') ? requestedFile.replace(/^[^/]+\//, '') : null

    const candidates = [
      baseName !== requestedFile ? baseName : null,
      sansLeadingFolder && sansLeadingFolder !== baseName ? sansLeadingFolder : null,
      `static/media/${baseName}`,
      `public/${baseName}`,
      `assets/${baseName}`,
      `images/${baseName}`,
      `img/${baseName}`,
    ].filter(Boolean)

    for (const candidate of candidates) {
      const candidatePath = `deployments/${projectRow.id}/${deploymentRow.id}/${candidate}`
      const { data: candBlob, error: candError } = await supabaseAdmin.storage.from(bucketName).download(candidatePath)
      if (!candError && candBlob) {
        fileBlob = candBlob
        fileError = null
        requestedFile = candidate
        break
      }
    }
  }

  if (fileError || !fileBlob) {
    if (shouldServeIndexFallback(requestedFile)) {
      const { data: indexBlob, error: indexError } = await supabaseAdmin.storage
        .from(bucketName)
        .download(`deployments/${projectRow.id}/${deploymentRow.id}/index.html`)

      if (!indexError && indexBlob) {
        await sendFile(response, indexBlob, 'index.html', slug, options, supabaseAdmin, projectRow)
        return
      }
    }

    response.status(404).send('File not found.')
    return
  }

  await sendFile(response, fileBlob, requestedFile, slug, options, supabaseAdmin, projectRow)
}

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const results = await Promise.all(
    entries.map((e) => {
      const fullPath = path.join(directory, e.name)
      return e.isDirectory() ? listFiles(fullPath) : fullPath
    }),
  )
  return results.flat()
}

function shouldServeIndexFallback(requestedFile) {
  if (requestedFile === 'index.html') return false
  const ext = path.extname(requestedFile)
  return !ext || ['.html', '.htm'].includes(ext.toLowerCase())
}

async function sendFile(response, fileBlob, requestedFile, slug, options, supabaseAdmin, projectRow) {
  const fileBuffer = Buffer.from(await fileBlob.arrayBuffer())

  if (supabaseAdmin && projectRow) {
    supabaseAdmin
      .from('osstack_projects')
      .update({ bandwidth_bytes: Number(projectRow.bandwidth_bytes ?? 0) + fileBuffer.byteLength })
      .eq('id', projectRow.id)
      .then(() => {})
      .catch(() => {})
  }

  const ext = path.extname(requestedFile).toLowerCase()
  const assetBase = options.assetBase ?? `/apps/${slug}/`

  if (ext === '.html') {
    response.set('Cache-Control', 'no-cache, no-store, must-revalidate')
    response.type('html').send(rewriteHtml(fileBuffer.toString('utf8'), assetBase, slug))
    return
  }

  if (ext === '.css') {
    response.set('Cache-Control', 'no-cache, no-store, must-revalidate')
    response.type(getContentType(requestedFile)).send(rewriteCss(fileBuffer.toString('utf8'), assetBase))
    return
  }

  if (ext === '.js' || ext === '.mjs') {
    response.set('Cache-Control', 'no-cache, no-store, must-revalidate')
    response.type('application/javascript; charset=utf-8').send(rewriteJs(fileBuffer.toString('utf8'), slug))
    return
  }

  response.type(getContentType(requestedFile)).send(fileBuffer)
}

function rewriteHtml(html, assetBase, slug) {
  const base = assetBase.endsWith('/') ? assetBase : `${assetBase}/`
  const routingShim = buildRoutingShim(slug)

  const withShim = html.includes('__OSSTACK_DEPLOYMENT_ROUTING_SHIM__')
    ? html
    : injectIntoHead(html, routingShim)

  const withBase = withShim.match(/<base\s/i)
    ? withShim.replace(/<base\b[^>]*>/i, `<base href="${base}">`)
    : injectIntoHead(withShim, `<base href="${base}">`)

  return withBase
    .replace(/((?:src|href|poster|content)=["'])\/(?!\/|apps\/|#)/gi, `$1${base}`)
    .replace(/((?:srcset)=["'])([^"']+)(["'])/gi, (_m, prefix, value, suffix) => {
      const rewritten = value
        .split(',')
        .map((candidate) => {
          const trimmed = candidate.trim()
          const [url, ...descriptor] = trimmed.split(/\s+/)
          if (!url.startsWith('/') || url.startsWith('//') || url.startsWith('/apps/')) return trimmed
          return [`${base}${url.replace(/^\/+/, '')}`, ...descriptor].join(' ')
        })
        .join(', ')
      return `${prefix}${rewritten}${suffix}`
    })
}

function injectIntoHead(html, snippet) {
  if (/<head([^>]*)>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${snippet}`)
  return `${snippet}${html}`
}

function buildRoutingShim(slug) {
  return `<script id="__OSSTACK_DEPLOYMENT_ROUTING_SHIM__">
(function () {
  var slug = ${JSON.stringify(slug)};
  var prefix = '/apps/' + slug;

  if (location.hostname === 'localhost' && (location.pathname === prefix || location.pathname.indexOf(prefix + '/') === 0)) {
    var rest = location.pathname.slice(prefix.length);
    while (rest.startsWith('/')) rest = rest.slice(1);
    location.replace(location.protocol + '//' + slug + '.localhost' + (location.port ? ':' + location.port : '') + '/' + rest + location.search + location.hash);
    return;
  }

  try {
    var rawPathnameDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'pathname');
    var rawHrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');

    function getRawPathname() {
      if (rawPathnameDesc && rawPathnameDesc.get) {
        return rawPathnameDesc.get.call(window.location);
      }
      return window.location.pathname;
    }

    function getRawHref() {
      if (rawHrefDesc && rawHrefDesc.get) {
        return rawHrefDesc.get.call(window.location);
      }
      return window.location.href;
    }

    function virtualizePathname(rawVal) {
      if (typeof rawVal === 'string' && rawVal.indexOf(prefix) === 0) {
        var resolved = rawVal.slice(prefix.length);
        return resolved ? (resolved.startsWith('/') ? resolved : '/' + resolved) : '/';
      }
      return rawVal;
    }

    function virtualizeHref(rawVal) {
      if (typeof rawVal !== 'string') return rawVal;
      try {
        var u = new URL(rawVal);
        if (u.pathname.indexOf(prefix) === 0) {
          var resolved = u.pathname.slice(prefix.length);
          u.pathname = resolved ? (resolved.startsWith('/') ? resolved : '/' + resolved) : '/';
        }
        return u.toString();
      } catch (e) {
        return rawVal;
      }
    }

    window.__osstack_location = {
      get pathname() {
        return virtualizePathname(getRawPathname());
      },
      get href() {
        return virtualizeHref(getRawHref());
      },
      set href(newVal) {
        if (newVal && typeof newVal === 'string') {
          if (newVal.indexOf(prefix) !== 0 && !newVal.startsWith('http:') && !newVal.startsWith('https:') && !newVal.startsWith('//')) {
            newVal = prefix + (newVal.startsWith('/') ? newVal : '/' + newVal);
          }
        }
        if (rawHrefDesc && rawHrefDesc.set) {
          rawHrefDesc.set.call(window.location, newVal);
        } else {
          window.location.href = newVal;
        }
      },
      get search() { return window.location.search; },
      get hash() { return window.location.hash; },
      get host() { return window.location.host; },
      get hostname() { return window.location.hostname; },
      get port() { return window.location.port; },
      get protocol() { return window.location.protocol; },
      get origin() { return window.location.origin; },
      assign: function(url) {
        if (url && typeof url === 'string' && url.indexOf(prefix) !== 0 && !url.startsWith('http:') && !url.startsWith('https:') && !url.startsWith('//')) {
          url = prefix + (url.startsWith('/') ? url : '/' + url);
        }
        window.location.assign(url);
      },
      replace: function(url) {
        if (url && typeof url === 'string' && url.indexOf(prefix) !== 0 && !url.startsWith('http:') && !url.startsWith('https:') && !url.startsWith('//')) {
          url = prefix + (url.startsWith('/') ? url : '/' + url);
        }
        window.location.replace(url);
      },
      reload: function() { window.location.reload(); },
      toString: function() { return this.href; }
    };

    window.__osstack_default_view = new Proxy(window, {
      get: function (target, prop) {
        if (prop === 'location') return window.__osstack_location;
        var val = Reflect.get(target, prop, target);
        if (typeof val === 'function') {
          return val.bind(target);
        }
        return val;
      },
      set: function (target, prop, value) {
        if (prop === 'location') {
          window.__osstack_location.href = value;
          return true;
        }
        return Reflect.set(target, prop, value, target);
      }
    });

    if (rawPathnameDesc && rawPathnameDesc.configurable) {
      Object.defineProperty(Location.prototype, 'pathname', {
        configurable: true,
        enumerable: rawPathnameDesc.enumerable,
        get: function () {
          return virtualizePathname(rawPathnameDesc.get.call(this));
        }
      });
    }

    if (rawHrefDesc && rawHrefDesc.configurable) {
      Object.defineProperty(Location.prototype, 'href', {
        configurable: true,
        enumerable: rawHrefDesc.enumerable,
        get: function () {
          return virtualizeHref(rawHrefDesc.get.call(this));
        },
        set: function (newVal) {
          if (newVal && typeof newVal === 'string') {
            if (newVal.indexOf(prefix) !== 0 && !newVal.startsWith('http:') && !newVal.startsWith('https:') && !newVal.startsWith('//')) {
              newVal = prefix + (newVal.startsWith('/') ? newVal : '/' + newVal);
            }
          }
          if (rawHrefDesc.set) {
            rawHrefDesc.set.call(this, newVal);
          } else {
            window.location.href = newVal;
          }
        }
      });
    }

    var originalPush = history.pushState;
    history.pushState = function (state, title, url) {
      if (url && typeof url === 'string') {
        if (url.indexOf(prefix) !== 0 && !url.startsWith('http:') && !url.startsWith('https:') && !url.startsWith('//')) {
          url = prefix + (url.startsWith('/') ? url : '/' + url);
        }
      }
      return originalPush.call(this, state, title, url);
    };

    var originalReplace = history.replaceState;
    history.replaceState = function (state, title, url) {
      if (url && typeof url === 'string') {
        if (url.indexOf(prefix) !== 0 && !url.startsWith('http:') && !url.startsWith('https:') && !url.startsWith('//')) {
          url = prefix + (url.startsWith('/') ? url : '/' + url);
        }
      }
      return originalReplace.call(this, state, title, url);
    };

    try {
      var rawImgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      if (rawImgSrcDesc && rawImgSrcDesc.set) {
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
          configurable: true,
          enumerable: rawImgSrcDesc.enumerable,
          get: function () {
            return rawImgSrcDesc.get.call(this);
          },
          set: function (val) {
            if (typeof val === 'string' && val && !val.startsWith('data:') && !val.startsWith('blob:') && !val.startsWith('http:') && !val.startsWith('https:') && !val.startsWith('//')) {
              if (val.indexOf(prefix) !== 0) {
                var clean = val;
                while (clean.startsWith('/')) clean = clean.slice(1);
                val = prefix + '/' + clean;
              }
            }
            rawImgSrcDesc.set.call(this, val);
          }
        });
      }
    } catch (e) {}

    Object.defineProperty(window, '__osstack_pathname', {
      configurable: true,
      get: function () {
        return window.__osstack_location.pathname;
      }
    });

    Object.defineProperty(window, '__osstack_href', {
      configurable: true,
      get: function () {
        return window.__osstack_location.href;
      }
    });
  } catch (e) {
    console.warn('oSStack routing virtualization failed:', e);
  }
})();
</script>`
}

function rewriteCss(css, assetBase) {
  const base = assetBase.endsWith('/') ? assetBase : `${assetBase}/`
  return css.replace(/url\((["']?)\/(?!\/|apps\/|#)([^)"']+)\1\)/gi, (_m, q, p) => `url(${q}${base}${p.replace(/^\/+/, '')}${q})`)
}

function rewriteJs(js, slug) {
  let replaced = js.replace(/\bdocument\.defaultView\b/g, 'window.__osstack_default_view')
  replaced = replaced
    .replace(/\bwindow\.location\b/g, 'window.__osstack_location')
    .replace(/\bglobalThis\.location\b/g, 'window.__osstack_location')
    .replace(/\bself\.location\b/g, 'window.__osstack_location')
    .replace(/\bdocument\.location\b/g, 'window.__osstack_location')
  return replaced
}

export function getSafeDeploymentFilePath(filePath) {
  let decoded
  try { decoded = decodeURIComponent(filePath) } catch { return null }
  const normalized = path.posix.normalize(decoded.replaceAll('\\', '/')).replace(/^\/+/, '')
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return null
  return normalized
}
