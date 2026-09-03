// Netlify Function: api.js
// Route: /api/*  →  /.netlify/functions/api/:splat
// Dùng Firebase REST API thay vì firebase-admin SDK để nhẹ hơn

const https = require('https');
const crypto = require('crypto');

// ==========================================
// CONFIG
// Mọi khóa bí mật phải được cấu hình bằng Environment variables trên Netlify.
// ==========================================
const FB_URL = String(process.env.FIREBASE_DATABASE_URL || '').replace(/\/+$/, '');
const FB_SECRET = String(process.env.FIREBASE_SECRET || '');
const OTP_KEY = String(process.env.OTP_API_KEY || '');
const OTP_BASE = String(process.env.OTP_BASE_URL || 'https://chaycodeso3.com/api').replace(/\/+$/, '');
const PRICE_MUL = 3000;

// Két API nhà cung cấp. Chỉ Netlify Function biết khóa gốc; Firebase chỉ giữ ciphertext.
// Bắt buộc cấu hình PROVIDER_MASTER_KEY (ít nhất 32 ký tự) trên Netlify trước khi sử dụng.
const PROVIDER_MASTER_KEY = String(process.env.PROVIDER_MASTER_KEY || '');
const PROVIDER_VAULT_PATH = 'secure/providerSources';
const PROVIDER_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const PROVIDER_TYPES = Object.freeze({
    nnmshop: {
        name: 'NNM Shop',
        baseUrl: 'https://api.butteiumien.io.vn',
        walletPath: '/v1/wallet',
        productsPath: '/v1/products',
        buyPath: '/v1/checkout'
    },
    nastele: {
        name: 'Shop Hân Nguyễn',
        baseUrl: 'https://nastele.online',
        walletPath: '/api/partner/balance',
        productsPath: '/api/partner/products',
        buyPath: '/api/partner/orders'
    },
    nanlux: {
        name: 'MMO NanLux',
        baseUrl: 'https://api.mmonanlux.site',
        walletPath: '/api/balance',
        productsPath: '/api/products',
        buyPath: '/api/buy'
    },
    tunvn: {
        name: 'TunVN PreHub',
        baseUrl: 'https://tunvnmmo.duckdns.org',
        walletPath: '/api/balance',
        productsPath: '/api/products',
        buyPath: '/api/buy'
    }
});
const adminLoginAttempts = new Map();

const DEFAULT_ALLOWED_APPS = [
    1095, 1561, 1869, 1195, 1001, 1160, 1005, 1021, 1432, 1247,
    1010, 1656, 1007, 1034, 1102, 1301, 1289, 1090, 1136, 1002,
    1472, 1006, 1097, 1032, 1030, 1477, 1022, 1024, 1425, 1176
];

async function getAllowedAppIds() {
    try {
        const selected = await fbGet('settings/selectedApps');
        if (Array.isArray(selected) && selected.length > 0)
            return selected.map(a => Number(a.Id || a.id)).filter(Boolean);
    } catch (e) { /* ignore */ }
    return DEFAULT_ALLOWED_APPS;
}

// ==========================================
// HELPERS
// ==========================================
function requireFirebaseConfig() {
    if (!FB_URL || !FB_SECRET) {
        throw {
            status: 503,
            code: 'FIREBASE_CONFIG_MISSING',
            error: 'Backend chưa được cấu hình Firebase trên Netlify.'
        };
    }
}

function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'TaiKhoanXin-API/1.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Invalid JSON')); }
            });
        }).on('error', reject);
    });
}

function fetchPostJSON(url, body) {
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(body);
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve({}); }
            });
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

// Firebase REST API helpers
async function fbGet(path) {
    requireFirebaseConfig();
    const url = `${FB_URL}/${path}.json?auth=${FB_SECRET}`;
    return fetchJSON(url);
}

async function fbSet(path, value) {
    requireFirebaseConfig();
    const url = `${FB_URL}/${path}.json?auth=${FB_SECRET}`;
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(value);
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data || 'null')));
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

async function fbPatch(path, value) {
    requireFirebaseConfig();
    const url = `${FB_URL}/${path}.json?auth=${FB_SECRET}`;
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(value);
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data || 'null')));
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

function assertSecureFirebaseResult(result) {
    if (result && typeof result === 'object' && typeof result.error === 'string') {
        throw { status: 503, code: 'FIREBASE_SECURE_WRITE_FAILED', error: 'Firebase từ chối thao tác bảo mật.' };
    }
    return result;
}

async function fbSecureGet(path) {
    return assertSecureFirebaseResult(await fbGet(path));
}

async function fbSecureSet(path, value) {
    return assertSecureFirebaseResult(await fbSet(path, value));
}

async function fbSecurePatch(path, value) {
    return assertSecureFirebaseResult(await fbPatch(path, value));
}

async function fbGetWithETag(path) {
    requireFirebaseConfig();
    const url = `${FB_URL}/${path}.json?auth=${FB_SECRET}`;
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: { 'X-Firebase-ETag': 'true' }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ value: JSON.parse(data || 'null'), etag: res.headers.etag });
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function fbSetIfMatch(path, value, etag) {
    requireFirebaseConfig();
    const url = `${FB_URL}/${path}.json?auth=${FB_SECRET}`;
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(value);
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
                'if-match': etag
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 412) return resolve({ committed: false, retry: true });
                try {
                    resolve({ committed: true, value: JSON.parse(data || 'null') });
                } catch (e) {
                    resolve({ committed: true, value: null });
                }
            });
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

async function fbTransaction(path, updater, retries = 8) {
    for (let i = 0; i < retries; i++) {
        const { value, etag } = await fbGetWithETag(path);
        const nextValue = updater(value);
        if (nextValue === undefined) return { committed: false, value };
        const result = await fbSetIfMatch(path, nextValue, etag);
        if (result.committed) return result;
        if (!result.retry) return result;
    }
    throw new Error('Firebase transaction retry limit reached');
}

async function addUserBalance(username, amount) {
    return fbTransaction(`users/${username}/balance`, balance => Number(balance || 0) + Number(amount || 0));
}

// Đọc OTP key + base URL từ Firebase settings/config (đồng bộ với web + bot).
// Cache 60s để không gọi Firebase mỗi request. Fallback env/hardcode nếu chưa cấu hình.
let _otpCfgCache = null;
let _otpCfgCacheTs = 0;
const OTP_CFG_TTL = 60000;
async function getOtpConfig() {
    const now = Date.now();
    if (_otpCfgCache && (now - _otpCfgCacheTs) < OTP_CFG_TTL) return _otpCfgCache;
    let cfg = {};
    try { cfg = (await fbGet('settings/config')) || {}; } catch (e) { cfg = {}; }
    const nextConfig = {
        key: OTP_KEY,
        base: (cfg && cfg.otpBaseUrl) ? cfg.otpBaseUrl : OTP_BASE,
        mul: (cfg && Number(cfg.priceMultiplier) > 0) ? Number(cfg.priceMultiplier) : PRICE_MUL
    };
    if (!nextConfig.key) {
        throw {
            status: 503,
            code: 'OTP_CONFIG_MISSING',
            error: 'Backend chưa được cấu hình OTP_API_KEY trên Netlify.'
        };
    }
    _otpCfgCache = nextConfig;
    _otpCfgCacheTs = now;
    return _otpCfgCache;
}

async function callOTPApi(params) {
    const cfg = await getOtpConfig();
    const qs = new URLSearchParams({ ...params, apik: cfg.key }).toString();
    return fetchJSON(`${cfg.base}?${qs}`);
}

// Catalog app thay đổi chậm nhưng được dùng ở nhiều luồng. Cache trên instance Netlify
// để việc mở lại trang/chuyển tab không liên tục tải toàn bộ danh sách từ nguồn.
let _otpAppsCache = null;
let _otpAppsCacheTs = 0;
let _otpAppsPending = null;
const OTP_APPS_TTL = 60000;
async function getOtpAppsCatalog() {
    const now = Date.now();
    if (_otpAppsCache && now - _otpAppsCacheTs < OTP_APPS_TTL) return _otpAppsCache;
    if (_otpAppsPending) return _otpAppsPending;

    _otpAppsPending = callOTPApi({ act: 'app' })
        .then(data => {
            if (data && data.ResponseCode === 0 && Array.isArray(data.Result)) {
                _otpAppsCache = data;
                _otpAppsCacheTs = Date.now();
            }
            return data;
        })
        .finally(() => { _otpAppsPending = null; });
    return _otpAppsPending;
}

// Xác thực API Key → trả về { username, userData } hoặc throw
async function authenticate(apiKey) {
    if (!apiKey) throw { status: 401, code: 'MISSING_API_KEY', error: 'Thiếu API Key. Thêm header: X-Api-Key hoặc ?api_key=' };
    requireFirebaseConfig();

    // Bước 1: Thử dùng orderBy (nhanh, cần .indexOn trong Firebase Rules)
    const url = `${FB_URL}/users.json?auth=${FB_SECRET}&orderBy="apiKey"&equalTo="${apiKey}"`;
    let result = await fetchJSON(url);

    // Bước 2: Nếu Firebase trả lỗi (VD: chưa có .indexOn rule) → fallback fetch toàn bộ users rồi lọc thủ công
    if (!result || result.error || typeof result !== 'object') {
        console.warn('[Auth] orderBy query failed, falling back to full scan. Error:', result?.error || 'unknown');
        const allUsers = await fetchJSON(`${FB_URL}/users.json?auth=${FB_SECRET}`);
        if (allUsers && typeof allUsers === 'object' && !allUsers.error) {
            result = {};
            for (const [uid, userData] of Object.entries(allUsers)) {
                if (userData && typeof userData === 'object' && userData.apiKey === apiKey) {
                    result[uid] = userData;
                    break;
                }
            }
        } else {
            throw { status: 503, code: 'DB_ERROR', error: 'Không thể kết nối Firebase. Vui lòng thử lại.' };
        }
    }

    if (!result || Object.keys(result).length === 0)
        throw { status: 401, code: 'INVALID_API_KEY', error: 'API Key không hợp lệ hoặc đã bị thu hồi.' };

    const username = Object.keys(result)[0];
    const userData = result[username];

    // Bước 3: Kiểm tra userData hợp lệ (không phải string lỗi từ Firebase)
    if (!userData || typeof userData !== 'object') {
        throw { status: 401, code: 'INVALID_API_KEY', error: 'API Key không hợp lệ hoặc đã bị thu hồi.' };
    }

    return { username, userData };
}

// ==========================================
// PROVIDER VAULT (admin only)
// ==========================================
function providerVaultConfigured() {
    return PROVIDER_MASTER_KEY.length >= 32;
}

function requireProviderVaultConfig() {
    if (!providerVaultConfigured()) {
        throw {
            status: 503,
            code: 'VAULT_NOT_CONFIGURED',
            error: 'Chưa cấu hình PROVIDER_MASTER_KEY trên Netlify.'
        };
    }
}

function base64UrlEncode(value) {
    return Buffer.from(value).toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

function base64UrlDecode(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(normalized + padding, 'base64');
}

function deriveVaultKey(purpose) {
    requireProviderVaultConfig();
    return crypto.createHash('sha256')
        .update(PROVIDER_MASTER_KEY)
        .update('\0')
        .update(purpose)
        .digest();
}

function safeSecretEqual(first, second) {
    const firstHash = crypto.createHash('sha256').update(String(first || '')).digest();
    const secondHash = crypto.createHash('sha256').update(String(second || '')).digest();
    return crypto.timingSafeEqual(firstHash, secondHash);
}

function createAdminSessionToken(sessionVersion) {
    const now = Date.now();
    const payload = {
        sub: 'admin',
        sv: Number(sessionVersion || 0),
        iat: now,
        exp: now + PROVIDER_SESSION_TTL_MS,
        nonce: crypto.randomBytes(12).toString('hex')
    };
    const encoded = base64UrlEncode(JSON.stringify(payload));
    const signature = crypto.createHmac('sha256', deriveVaultKey('admin-session-v1'))
        .update(encoded)
        .digest();
    return `${encoded}.${base64UrlEncode(signature)}`;
}

function verifyAdminSessionToken(token) {
    requireProviderVaultConfig();
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw { status: 401, code: 'ADMIN_AUTH_REQUIRED', error: 'Vui lòng xác minh lại tài khoản quản trị.' };
    }

    const expected = crypto.createHmac('sha256', deriveVaultKey('admin-session-v1'))
        .update(parts[0])
        .digest();
    const received = base64UrlDecode(parts[1]);
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
        throw { status: 401, code: 'INVALID_ADMIN_SESSION', error: 'Phiên quản trị không hợp lệ.' };
    }

    let payload;
    try { payload = JSON.parse(base64UrlDecode(parts[0]).toString('utf8')); }
    catch (e) {
        throw { status: 401, code: 'INVALID_ADMIN_SESSION', error: 'Phiên quản trị không hợp lệ.' };
    }
    if (payload.sub !== 'admin' || !Number.isFinite(payload.exp) || payload.exp <= Date.now()) {
        throw { status: 401, code: 'ADMIN_SESSION_EXPIRED', error: 'Phiên quản trị đã hết hạn. Vui lòng xác minh lại.' };
    }
    return payload;
}

function getAdminToken(event) {
    const authorization = String(event.headers.authorization || event.headers.Authorization || '');
    if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
    return String(event.headers['x-admin-token'] || event.headers['X-Admin-Token'] || '').trim();
}

async function requireAdminSession(event) {
    const payload = verifyAdminSessionToken(getAdminToken(event));
    const adminUser = await fbSecureGet('users/admin');
    if (!adminUser || typeof adminUser !== 'object'
        || Number(adminUser.sessionVersion || 0) !== Number(payload.sv || 0)) {
        throw { status: 401, code: 'ADMIN_SESSION_REVOKED', error: 'Phiên quản trị không còn hiệu lực.' };
    }
    return { username: 'admin', userData: adminUser };
}

function assertAdminSameOrigin(event) {
    const origin = String(event.headers.origin || event.headers.Origin || '').trim();
    if (!origin) return;
    const host = String(event.headers['x-forwarded-host'] || event.headers.host || '').trim();
    try {
        if (!host || new URL(origin).host !== host) throw new Error('origin mismatch');
    } catch (e) {
        throw { status: 403, code: 'INVALID_ORIGIN', error: 'Yêu cầu quản trị không cùng nguồn với website.' };
    }
}

function getAdminClientKey(event) {
    return String(
        event.headers['x-nf-client-connection-ip']
        || event.headers['client-ip']
        || event.headers['x-forwarded-for']
        || 'unknown'
    ).split(',')[0].trim().slice(0, 80);
}

function assertAdminLoginRate(event) {
    const key = getAdminClientKey(event);
    const now = Date.now();
    const windowStart = now - (10 * 60 * 1000);
    const recent = (adminLoginAttempts.get(key) || []).filter(timestamp => timestamp >= windowStart);
    adminLoginAttempts.set(key, recent);
    if (recent.length >= 5) {
        throw { status: 429, code: 'TOO_MANY_ATTEMPTS', error: 'Bạn thử quá nhiều lần. Vui lòng chờ 10 phút.' };
    }
    return key;
}

function recordAdminLoginFailure(key) {
    const attempts = adminLoginAttempts.get(key) || [];
    attempts.push(Date.now());
    adminLoginAttempts.set(key, attempts.slice(-5));
}

function encryptProviderKey(apiKey, providerId, providerType) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveVaultKey('provider-api-key-v1'), iv);
    cipher.setAAD(Buffer.from(`provider:${providerId}:${providerType}:v1`, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(String(apiKey), 'utf8'), cipher.final()]);
    return {
        version: 1,
        algorithm: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: encrypted.toString('base64')
    };
}

function decryptProviderKey(secret, providerId, providerType) {
    if (!secret || Number(secret.version) !== 1 || secret.algorithm !== 'aes-256-gcm') {
        throw { status: 500, code: 'INVALID_VAULT_RECORD', error: 'Dữ liệu API key không hợp lệ.' };
    }
    try {
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            deriveVaultKey('provider-api-key-v1'),
            Buffer.from(secret.iv, 'base64')
        );
        decipher.setAAD(Buffer.from(`provider:${providerId}:${providerType}:v1`, 'utf8'));
        decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
        return Buffer.concat([
            decipher.update(Buffer.from(secret.ciphertext, 'base64')),
            decipher.final()
        ]).toString('utf8');
    } catch (e) {
        throw { status: 500, code: 'VAULT_DECRYPT_FAILED', error: 'Không thể mở API key đã mã hóa.' };
    }
}

function getProviderConfig(providerType) {
    const config = PROVIDER_TYPES[String(providerType || '')];
    if (!config) {
        throw { status: 400, code: 'UNSUPPORTED_PROVIDER', error: 'Nhà cung cấp chưa được hỗ trợ.' };
    }
    return config;
}

function providerRequest(providerType, endpoint, apiKey) {
    const config = getProviderConfig(providerType);
    const target = new URL(endpoint, config.baseUrl);
    return new Promise((resolve, reject) => {
        const request = https.request({
            hostname: target.hostname,
            port: 443,
            path: target.pathname + target.search,
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-API-Key': apiKey,
                'User-Agent': 'TaiKhoanXin-ProviderVault/1.0'
            }
        }, response => {
            let responseBody = '';
            response.on('data', chunk => {
                responseBody += chunk;
                if (responseBody.length > 1024 * 1024) {
                    request.destroy(new Error('Phản hồi nhà cung cấp quá lớn.'));
                }
            });
            response.on('end', () => {
                let payload = null;
                try { payload = responseBody ? JSON.parse(responseBody) : {}; }
                catch (e) {
                    return reject({ status: 502, code: 'PROVIDER_INVALID_RESPONSE', error: 'Nhà cung cấp trả dữ liệu không hợp lệ.' });
                }
                const providerMessage = String(payload?.message || payload?.error || payload?.msg || '')
                    .replaceAll(String(apiKey), '***')
                    .slice(0, 240);
                if (response.statusCode < 200 || response.statusCode >= 300 || payload?.success === false) {
                    return reject({
                        status: 400,
                        code: 'PROVIDER_REJECTED',
                        error: providerMessage || `Nhà cung cấp từ chối kết nối (HTTP ${response.statusCode}).`
                    });
                }
                resolve(payload);
            });
        });
        request.setTimeout(12000, () => request.destroy(new Error('Nhà cung cấp phản hồi quá chậm.')));
        request.on('error', error => reject({
            status: 502,
            code: 'PROVIDER_UNAVAILABLE',
            error: String(error.message || 'Không thể kết nối nhà cung cấp.').slice(0, 240)
        }));
        request.end();
    });
}

function extractProviderBalance(payload) {
    const data = payload && typeof payload.data === 'object' ? payload.data : payload;
    if (!data || typeof data !== 'object') return null;
    const candidates = [data.balance_vnd, data.balance, data.wallet_balance, data.available_balance, data.amount];
    const found = candidates.find(value => value !== undefined && value !== null && value !== '');
    if (found === undefined) return null;
    const normalized = Number(String(found).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(normalized) ? normalized : null;
}

async function testProviderCredential(providerType, apiKey) {
    const config = getProviderConfig(providerType);
    const payload = await providerRequest(providerType, config.walletPath, apiKey);
    const balance = extractProviderBalance(payload);
    return {
        ok: true,
        balance,
        balanceDisplay: balance === null ? 'Đã kết nối' : `${balance.toLocaleString('vi-VN')}đ`
    };
}

function normalizeProviderProducts(providerType, payload) {
    const raw = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.data)
            ? payload.data
            : (Array.isArray(payload?.data?.products)
                ? payload.data.products
                : (Array.isArray(payload?.products) ? payload.products : [])));
    return raw.slice(0, 300).map(item => ({
        id: String(item.id ?? item.product_id ?? item.productId ?? ''),
        name: String(item.name ?? item.product_name ?? item.title ?? 'Sản phẩm').slice(0, 160),
        price: Number(item.price_vnd ?? item.price ?? item.unitPrice ?? 0) || 0,
        stock: Number(item.stock ?? item.quantity ?? item.available ?? 0) || 0,
        providerType
    })).filter(item => item.id);
}

function sanitizeProviderRecord(id, record) {
    const config = PROVIDER_TYPES[record?.type] || {};
    return {
        id,
        type: String(record?.type || ''),
        providerName: config.name || 'Nhà cung cấp',
        label: String(record?.label || config.name || 'Nguồn API').slice(0, 80),
        enabled: record?.enabled !== false,
        keyMask: String(record?.keyMask || '••••'),
        balance: record?.balance !== null && record?.balance !== undefined && Number.isFinite(Number(record.balance))
            ? Number(record.balance)
            : null,
        balanceDisplay: String(record?.balanceDisplay || ''),
        lastTestOk: record?.lastTestOk === true,
        lastTestAt: Number(record?.lastTestAt || 0),
        createdAt: Number(record?.createdAt || 0),
        updatedAt: Number(record?.updatedAt || 0)
    };
}

function validateProviderId(value) {
    const id = String(value || '').trim();
    if (!/^[a-zA-Z0-9_-]{6,80}$/.test(id)) {
        throw { status: 400, code: 'INVALID_PROVIDER_ID', error: 'Mã nguồn API không hợp lệ.' };
    }
    return id;
}

function formatPhone(num) {
    let p = num ? num.toString() : '';
    if (p.startsWith('84')) p = '0' + p.substring(2);
    else if (p && !p.startsWith('0')) p = '0' + p;
    return p;
}

function ok(body) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ success: true, ...body }) };
}

function err(status, code, message, extra = {}) {
    return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ success: false, code, error: message, ...extra }) };
}

// ==========================================
// HANDLER CHÍNH
// ==========================================
exports.handler = async (event) => {
    // CORS preflight
    if (event.httpMethod === 'OPTIONS')
        return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'X-Api-Key,X-Admin-Token,Authorization,Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' }, body: '' };

    const path = (event.path || '').replace('/.netlify/functions/api', '').replace('/api', '') || '/';
    const method = event.httpMethod;
    const apiKey = (event.headers['x-api-key'] || event.headers['X-Api-Key'] || event.queryStringParameters?.api_key || '').trim();
    let body = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch (e) { }

    // Root info
    if (path === '/' || path === '')
        return ok({ service: 'TaiKhoanXin OTP API (Netlify)', version: '1.1.0', endpoints: ['/api/balance', '/api/apps', '/api/rent', '/api/otp/:id', '/api/cancel/:id', '/api/history'] });

    try {
        // ---- KÉT API NHÀ CUNG CẤP (chỉ admin) ----
        if (path.startsWith('/admin/')) assertAdminSameOrigin(event);

        if (path === '/admin/status' && method === 'GET') {
            return ok({
                data: {
                    configured: providerVaultConfigured(),
                    encryption: 'AES-256-GCM',
                    supportedProviders: Object.entries(PROVIDER_TYPES).map(([id, item]) => ({ id, name: item.name }))
                }
            });
        }

        if (path === '/admin/session' && method === 'POST') {
            requireProviderVaultConfig();
            const rateKey = assertAdminLoginRate(event);
            const username = String(body.username || '').trim().toLowerCase();
            const password = String(body.password || '');
            if (username !== 'admin' || !password || password.length > 300) {
                recordAdminLoginFailure(rateKey);
                return err(401, 'INVALID_ADMIN_CREDENTIALS', 'Thông tin quản trị không đúng.');
            }
            const adminUser = await fbSecureGet('users/admin');
            if (!adminUser || typeof adminUser !== 'object' || !safeSecretEqual(password, adminUser.password)) {
                recordAdminLoginFailure(rateKey);
                return err(401, 'INVALID_ADMIN_CREDENTIALS', 'Thông tin quản trị không đúng.');
            }
            adminLoginAttempts.delete(rateKey);
            return ok({
                data: {
                    token: createAdminSessionToken(adminUser.sessionVersion),
                    expiresIn: PROVIDER_SESSION_TTL_MS,
                    expiresAt: Date.now() + PROVIDER_SESSION_TTL_MS
                }
            });
        }

        if (path === '/admin/providers' && method === 'GET') {
            await requireAdminSession(event);
            const records = await fbSecureGet(PROVIDER_VAULT_PATH) || {};
            const providers = Object.entries(records)
                .map(([id, record]) => sanitizeProviderRecord(id, record))
                .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
            return ok({ data: { providers } });
        }

        if (path === '/admin/providers' && method === 'POST') {
            await requireAdminSession(event);
            const type = String(body.type || '').trim();
            const config = getProviderConfig(type);
            const label = String(body.label || config.name).trim().slice(0, 80);
            const providerApiKey = String(body.apiKey || '').trim();
            if (label.length < 2) return err(400, 'INVALID_LABEL', 'Vui lòng nhập tên nguồn API.');
            if (providerApiKey.length < 8 || providerApiKey.length > 512) {
                return err(400, 'INVALID_PROVIDER_KEY', 'API key phải có từ 8 đến 512 ký tự.');
            }

            const id = body.id
                ? validateProviderId(body.id)
                : `src_${crypto.randomBytes(10).toString('hex')}`;
            const oldRecord = body.id ? await fbSecureGet(`${PROVIDER_VAULT_PATH}/${id}`) : null;
            if (body.id && !oldRecord) return err(404, 'PROVIDER_NOT_FOUND', 'Không tìm thấy nguồn API cần cập nhật.');

            const connection = await testProviderCredential(type, providerApiKey);
            const now = Date.now();
            const record = {
                type,
                label,
                enabled: body.enabled !== false,
                keyMask: `••••${providerApiKey.slice(-4)}`,
                secret: encryptProviderKey(providerApiKey, id, type),
                balance: connection.balance,
                balanceDisplay: connection.balanceDisplay,
                lastTestOk: true,
                lastTestAt: now,
                createdAt: Number(oldRecord?.createdAt || now),
                updatedAt: now,
                updatedBy: 'admin'
            };
            await fbSecureSet(`${PROVIDER_VAULT_PATH}/${id}`, record);
            return ok({ data: { provider: sanitizeProviderRecord(id, record) } });
        }

        const providerRoute = path.match(/^\/admin\/providers\/([a-zA-Z0-9_-]+)(?:\/(test|products))?$/);
        if (providerRoute) {
            await requireAdminSession(event);
            const id = validateProviderId(providerRoute[1]);
            const action = providerRoute[2] || '';
            const record = await fbSecureGet(`${PROVIDER_VAULT_PATH}/${id}`);
            if (!record || typeof record !== 'object') return err(404, 'PROVIDER_NOT_FOUND', 'Không tìm thấy nguồn API.');

            if (!action && method === 'DELETE') {
                await fbSecureSet(`${PROVIDER_VAULT_PATH}/${id}`, null);
                return ok({ data: { id, deleted: true } });
            }

            const storedKey = decryptProviderKey(record.secret, id, record.type);
            if (action === 'test' && method === 'POST') {
                const testedAt = Date.now();
                try {
                    const connection = await testProviderCredential(record.type, storedKey);
                    await fbSecurePatch(`${PROVIDER_VAULT_PATH}/${id}`, {
                        balance: connection.balance,
                        balanceDisplay: connection.balanceDisplay,
                        lastTestOk: true,
                        lastTestAt: testedAt,
                        updatedAt: testedAt
                    });
                    return ok({ data: { ...connection, testedAt } });
                } catch (providerError) {
                    await fbSecurePatch(`${PROVIDER_VAULT_PATH}/${id}`, {
                        lastTestOk: false,
                        lastTestAt: testedAt
                    });
                    throw providerError;
                }
            }

            if (action === 'products' && method === 'GET') {
                const config = getProviderConfig(record.type);
                const payload = await providerRequest(record.type, config.productsPath, storedKey);
                const products = normalizeProviderProducts(record.type, payload);
                return ok({ data: { providerId: id, total: products.length, products } });
            }
        }

        // ---- GET /api/balance ----
        if (path === '/balance' && method === 'GET') {
            const { username, userData } = await authenticate(apiKey);
            const balance = userData.balance || 0;
            return ok({ data: { username, balance, balance_display: balance.toLocaleString('vi-VN') + 'đ' } });
        }

        // ---- GET /api/otp-raw ----
        // Proxy thuần tới chaycodeso3.com cho giao diện web (thay cho proxy CORS công cộng).
        // Không cần API key người dùng: chỉ chuyển tiếp các act/param an toàn, dùng OTP_KEY phía server.
        if (path === '/otp-raw' && method === 'GET') {
            const q = event.queryStringParameters || {};
            const act = q.act;
            const allowedActs = ['app', 'number', 'code'];
            if (!allowedActs.includes(act))
                return err(400, 'INVALID_ACT', 'act không hợp lệ (chỉ chấp nhận app/number/code).');
            const params = { act };
            ['appId', 'number', 'carrier', 'prefix', 'id'].forEach(k => {
                if (q[k] !== undefined && q[k] !== '') params[k] = q[k];
            });
            let d = act === 'app' ? await getOtpAppsCatalog() : await callOTPApi(params);
            if (act === 'app' && q.scope === 'selected' && d.ResponseCode === 0 && Array.isArray(d.Result)) {
                const allowedIds = new Set(await getAllowedAppIds());
                d = { ...d, Result: d.Result.filter(app => allowedIds.has(Number(app.Id))) };
            }
            // Trả nguyên văn JSON của chaycodeso3 (ResponseCode/Result/Msg) — frontend dùng trực tiếp.
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                body: JSON.stringify(d)
            };
        }

        // ---- GET /api/apps ----
        if (path === '/apps' && method === 'GET') {
            const d = await getOtpAppsCatalog();
            if (d.ResponseCode !== 0) return err(502, 'SOURCE_ERROR', 'Không thể lấy danh sách app: ' + d.Msg);
            await authenticate(apiKey); // xác thực
            const allowedIds = await getAllowedAppIds();
            const cfg = await getOtpConfig();
            const apps = d.Result.filter(a => allowedIds.includes(Number(a.Id))).map(a => ({
                id: a.Id, name: a.Name,
                cost: a.Cost * cfg.mul,
                cost_display: (a.Cost * cfg.mul).toLocaleString('vi-VN') + 'đ',
                available: a.Available !== false
            }));
            return ok({ data: { total: apps.length, apps } });
        }

        // ---- POST /api/rent ----
        if (path === '/rent' && method === 'POST') {
            const { username, userData } = await authenticate(apiKey);
            const app_id = body.app_id;
            if (!app_id) return err(400, 'INVALID_PARAMS', 'Thiếu app_id');
            const currentBalance = userData.balance || 0;

            // Lấy giá
            const appsData = await getOtpAppsCatalog();
            const appInfo = appsData.Result?.find(a => a.Id == app_id);
            if (!appInfo) return err(404, 'APP_NOT_FOUND', `Không tìm thấy app_id: ${app_id}`);
            const cfg = await getOtpConfig();
            const price = appInfo.Cost * cfg.mul;
            if (currentBalance < price)
                return err(402, 'INSUFFICIENT_BALANCE', 'Số dư không đủ.', { data: { balance: currentBalance, required: price } });

            // Gọi API thuê số
            const params = { act: 'number', appId: app_id };
            // Map carrier/network parameter to correct API format
            const carrierInput = body.carrier || body.network || '';
            if (carrierInput) {
                // Map old values to correct API carrier values
                const carrierMap = {
                    'VIETTEL': 'Viettel', 'viettel': 'Viettel', 'Viettel': 'Viettel',
                    'VINAPHONE': 'Vina', 'vinaphone': 'Vina', 'Vina': 'Vina', 'vina': 'Vina',
                    'MOBIFONE': 'Mobi', 'mobifone': 'Mobi', 'Mobi': 'Mobi', 'mobi': 'Mobi',
                    'VNMOBILE': 'VNMB', 'vnmobile': 'VNMB', 'VNMB': 'VNMB', 'vnmb': 'VNMB',
                    'ITEL': 'ITelecom', 'itel': 'ITelecom', 'ITelecom': 'ITelecom', 'itelecom': 'ITelecom'
                };
                params.carrier = carrierMap[carrierInput] || carrierInput;
            }
            const rentData = await callOTPApi(params);
            if (rentData.ResponseCode !== 0) return err(502, 'SOURCE_ERROR', 'Không lấy được số: ' + (rentData.Msg || 'Unknown'));

            const phoneInfo = rentData.Result;
            const debit = await fbTransaction(`users/${username}/balance`, balance => {
                const latestBalance = Number(balance || 0);
                if (latestBalance < price) return undefined;
                return latestBalance - price;
            });
            if (!debit.committed)
                return err(402, 'INSUFFICIENT_BALANCE', 'Số dư vừa thay đổi và không còn đủ.', { data: { required: price } });

            // Lưu lịch sử
            await fbPatch(`users/${username}/otp_history/${phoneInfo.Id}`, {
                appId: Number(app_id), appName: appInfo.Name,
                phone: phoneInfo.Number, price, source: 'API',
                date: new Date().toLocaleString('vi-VN'),
                timestamp: Date.now(), debitedAt: Date.now(), status: 'Đang chờ mã', code: ''
            });

            return ok({
                data: {
                    request_id: phoneInfo.Id,
                    phone: formatPhone(phoneInfo.Number),
                    app_name: appInfo.Name, price,
                    price_display: price.toLocaleString('vi-VN') + 'đ',
                    balance_remaining: debit.value,
                    tip: `Gọi GET /api/otp/${phoneInfo.Id} để lấy OTP`
                }
            });
        }

        // ---- GET /api/otp/:id ----
        if (path.startsWith('/otp/') && method === 'GET') {
            const reqId = path.replace('/otp/', '');
            const { username } = await authenticate(apiKey);
            const hist = await fbGet(`users/${username}/otp_history/${reqId}`);
            if (hist && hist.refundedAt) {
                return ok({ data: { request_id: reqId, status: 'cancelled', code: null, refunded: hist.refundedAmount || hist.price || 0 } });
            }
            const d = await callOTPApi({ act: 'code', id: reqId });
            if (d.ResponseCode === 0 && d.Result?.Code) {
                await fbPatch(`users/${username}/otp_history/${reqId}`, { status: 'Thành công', code: d.Result.Code });
                return ok({ data: { request_id: reqId, status: 'received', code: d.Result.Code, message: d.Result.Message || '' } });
            } else if (d.ResponseCode === 1) {
                return ok({ data: { request_id: reqId, status: 'waiting', code: null, tip: 'Thử lại sau 5-10 giây.' } });
            }
            return ok({ success: false, data: { request_id: reqId, status: 'cancelled' }, error: 'Yêu cầu thất bại.' });
        }

        // ---- POST /api/cancel/:id ----
        if (path.startsWith('/cancel/') && method === 'POST') {
            const reqId = path.replace('/cancel/', '');
            const { username } = await authenticate(apiKey);
            const hist = await fbGet(`users/${username}/otp_history/${reqId}`);
            if (!hist) return err(404, 'NOT_FOUND', 'Không tìm thấy yêu cầu OTP này.');
            if (hist.status === 'Thành công') return err(400, 'ALREADY_COMPLETED', 'Không thể hủy yêu cầu đã hoàn thành.');
            const refund = hist.price || 0;
            const claimed = await fbTransaction(`users/${username}/otp_history/${reqId}`, current => {
                if (!current || current.refundedAt) return undefined;
                if (current.status === 'Thành công') return undefined;
                return {
                    ...current,
                    status: 'Đã hoàn tiền (Hủy qua API)',
                    refundedAt: Date.now(),
                    refundedAmount: refund
                };
            });
            if (!claimed.committed) return err(409, 'ALREADY_REFUNDED', 'Yêu cầu này đã được hoàn tiền hoặc đã hoàn thành.');
            const balanceResult = await addUserBalance(username, refund);
            return ok({ data: { request_id: reqId, status: 'cancelled', refunded: refund, balance_remaining: balanceResult.value } });
        }

        // ---- GET /api/history ----
        if (path === '/history' && method === 'GET') {
            const { username } = await authenticate(apiKey);
            const hist = await fbGet(`users/${username}/otp_history`) || {};
            const list = Object.entries(hist).map(([id, h]) => ({
                request_id: id, app_name: h.appName,
                phone: formatPhone(h.phone), price: h.price,
                status: h.status, code: h.code || null,
                date: h.date, timestamp: h.timestamp, source: h.source || 'web'
            })).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 50);
            return ok({ data: { total: list.length, history: list } });
        }

        return err(404, 'NOT_FOUND', `Endpoint không tồn tại: ${method} /api${path}`);

    } catch (e) {
        if (e.status) return err(e.status, e.code, e.error);
        console.error('API Error:', e);
        return err(500, 'SERVER_ERROR', e.message || 'Lỗi server.');
    }
};
