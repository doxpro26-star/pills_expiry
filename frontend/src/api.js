// API Configuration
export const API_BASE = (import.meta.env.VITE_API_URL || 'https://pills-expiry.onrender.com').replace(/\/$/, '')

// ESP32 Configuration - stored in localStorage for user override
const DEFAULT_ESP32_IP = import.meta.env.VITE_ESP32_IP || '192.168.4.1'

export function getEsp32Ip() {
  try {
    return localStorage.getItem('esp32_ip') || DEFAULT_ESP32_IP
  } catch { return DEFAULT_ESP32_IP }
}
export function setEsp32Ip(ip) {
  try { localStorage.setItem('esp32_ip', ip) } catch {}
}
export function getEsp32Base() {
  const ip = getEsp32Ip()
  // Ensure http:// prefix - ESP32 only supports HTTP, not HTTPS
  if (ip.startsWith('http://') || ip.startsWith('https://')) return ip.replace(/\/$/, '')
  return `http://${ip}`
}

// Detect if we are on HTTPS cloud deployment (mixed content will block http:// ESP32 fetch)
export function isHttps() {
  return typeof window !== 'undefined' && window.location.protocol === 'https:'
}
export function isCloudDeployment() {
  // Cloud if API_BASE is not localhost and page is https
  return API_BASE.includes('onrender.com') || API_BASE.includes('workers.dev') || API_BASE.includes('vercel.app') || API_BASE.includes('netlify.app')
}

export async function api(path, options = {}) {
  const url = `${API_BASE}${path}`
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || err.details || `HTTP ${res.status}`)
  }
  return res.json()
}

// ---------- ESP32 Direct Fetch (Client-Side) ----------
// This is the CORRECT way for cloud deployments: browser fetches ESP32 directly
// (when connected to ESP32-CAM_AP) then uploads blob to backend
export async function fetchEsp32Blob(endpoint = '/capture') {
  const base = getEsp32Base()
  const url = `${base}${endpoint}`
  
  let lastError = null
  // Try direct fetch with CORS
  try {
    // Use no-cache to get fresh image
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      // mode cors is default - ESP32 sends Access-Control-Allow-Origin: *
    })
    if (!res.ok) throw new Error(`ESP32 returned HTTP ${res.status}`)
    const blob = await res.blob()
    if (blob.size < 100) throw new Error('ESP32 returned empty image')
    // Verify it's an image
    if (!blob.type.includes('image') && endpoint.includes('capture')) {
      // Some ESP32 firmware returns image/jpeg correctly, check size instead
    }
    return blob
  } catch (e) {
    lastError = e
    // Provide helpful error based on context
    const isMixedContent = isHttps() && url.startsWith('http://')
    const msg = e.message || String(e)
    
    // Detect mixed content blocking (https page trying to fetch http:// local IP)
    if (isMixedContent && (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed'))) {
      throw new Error(
        `Mixed content blocked: Cloud site is HTTPS but ESP32 is HTTP (${url}). ` +
        `Browsers block HTTPS→HTTP requests to local IPs. ` +
        `Solutions: (1) Click "Allow insecure content" in browser address bar, ` +
        `(2) Use Upload button instead, or (3) Run backend locally at http://localhost:5000 and set VITE_API_URL to it. ` +
        `You must be connected to WiFi ESP32-CAM_AP (password: 12345678).`
      )
    }
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      throw new Error(
        `Cannot reach ESP32 at ${url}. Check: (1) Connected to WiFi ESP32-CAM_AP (pass: 12345678), ` +
        `(2) ESP32 IP is ${getEsp32Ip()} (try http://${getEsp32Ip()}/status in browser), ` +
        `(3) ESP32 is powered on. Details: ${msg}`
      )
    }
    throw new Error(`ESP32 fetch failed (${url}): ${msg}`)
  }
}

// Client-side collect: fetch from ESP32 in browser, then upload to backend
export async function collectEsp32ClientSide(tablet, expiry) {
  const blob = await fetchEsp32Blob('/capture')
  // Convert blob to File for upload
  const file = new File([blob], 'capture.jpg', { type: 'image/jpeg' })
  return collectUpload(file, tablet, expiry)
}

// Client-side identify: fetch from ESP32 in browser, then upload to backend
export async function identifyEsp32ClientSide() {
  const blob = await fetchEsp32Blob('/capture')
  const file = new File([blob], 'capture.jpg', { type: 'image/jpeg' })
  return identifyUpload(file)
}

// Check ESP32 connectivity from browser
export async function checkEsp32Status() {
  const base = getEsp32Base()
  try {
    const res = await fetch(`${base}/status`, { cache: 'no-store' })
    if (!res.ok) return { online: false, error: `HTTP ${res.status}` }
    const data = await res.json()
    return { online: true, data, base }
  } catch (e) {
    return { online: false, error: e.message, base, httpsBlocked: isHttps() }
  }
}

// Legacy: Backend-mediated fetch (only works when backend is on same network as ESP32, i.e., local dev)
// On Render/cloud, this will always fail because Render cannot reach 192.168.4.1
export const collectEsp32 = (tablet, expiry) =>
  api('/collect', { method: 'POST', body: JSON.stringify({ tablet, expiry }) })

export const collectUpload = (file, tablet, expiry) => {
  const fd = new FormData()
  fd.append('image', file)
  fd.append('tablet', tablet)
  fd.append('expiry', expiry)
  return fetch(`${API_BASE}/collect_upload`, { method: 'POST', body: fd }).then(async r => {
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
    return j
  })
}

// Smart collect: tries client-side first (works on cloud), falls back to backend fetch (works locally)
export async function smartCollectEsp32(tablet, expiry) {
  // If cloud deployment, ALWAYS use client-side (backend can't reach ESP32)
  if (isCloudDeployment() || isHttps()) {
    try {
      return await collectEsp32ClientSide(tablet, expiry)
    } catch (e) {
      // If client-side fails due to mixed content, try backend as last resort (will likely also fail but give clearer error)
      if (e.message.includes('Mixed content')) throw e
      // For other errors, try backend fallback
      console.warn('Client-side ESP32 fetch failed, trying backend proxy:', e.message)
      try {
        return await collectEsp32(tablet, expiry)
      } catch (be) {
        // Prefer original client error which is more helpful
        throw new Error(`${e.message} | Backend fallback also failed: ${be.message}`)
      }
    }
  } else {
    // Local deployment: try backend first (more efficient), fallback to client
    try {
      return await collectEsp32(tablet, expiry)
    } catch (e) {
      console.warn('Backend ESP32 fetch failed, trying client-side:', e.message)
      return await collectEsp32ClientSide(tablet, expiry)
    }
  }
}

export const identifyEsp32 = () => api('/identify', { method: 'POST' })

export const identifyUpload = (file) => {
  const fd = new FormData()
  fd.append('image', file)
  return fetch(`${API_BASE}/identify_upload`, { method: 'POST', body: fd }).then(async r => {
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || j.details || `HTTP ${r.status}`)
    return j
  })
}

// Smart identify: same logic as smartCollect
export async function smartIdentifyEsp32() {
  if (isCloudDeployment() || isHttps()) {
    try {
      return await identifyEsp32ClientSide()
    } catch (e) {
      if (e.message.includes('Mixed content')) throw e
      console.warn('Client-side ESP32 fetch failed, trying backend:', e.message)
      try {
        return await identifyEsp32()
      } catch (be) {
        throw new Error(`${e.message} | Backend fallback also failed: ${be.message}`)
      }
    }
  } else {
    try {
      return await identifyEsp32()
    } catch (e) {
      console.warn('Backend ESP32 fetch failed, trying client-side:', e.message)
      return await identifyEsp32ClientSide()
    }
  }
}

// Health / Model
export const getHealth = () => api('/health')
export const reloadModel = () => api('/reload_model', { method: 'POST' })

// ESP32 URLs for UI
export const esp32Base = () => getEsp32Base()
export const esp32CaptureUrl = () => `${getEsp32Base()}/capture`
export const esp32StatusUrl = () => `${getEsp32Base()}/status`
export const esp32StreamUrl = () => `${getEsp32Base()}/stream`
export const esp32StreamHttpUrl = () => `${getEsp32Base()}/stream`
// Backend proxy (only works when backend is local and can reach ESP32)
export const esp32Proxy = (subpath) => `${API_BASE}/esp32/${subpath}`
export const esp32Stream = () => `${API_BASE}/proxy/stream`
export const proxyStreamUrl = () => `${API_BASE}/proxy/stream`
