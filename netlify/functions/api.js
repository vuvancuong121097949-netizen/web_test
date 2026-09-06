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
// Secret server-to-server dành riêng cho bot Telegram. Không đưa giá trị này vào frontend.
const TELEGRAM_BOT_SHARED_SECRET = String(process.env.TELEGRAM_BOT_SHARED_SECRET || '');
const TELEGRAM_BANK_BIN = String(process.env.TELEGRAM_BANK_BIN || '970422');
const TELEGRAM_BANK_ACCOUNT = String(process.env.TELEGRAM_BANK_ACCOUNT || '346641789567');
const TELEGRAM_ACCOUNT_NAME = String(process.env.TELEGRAM_ACCOUNT_NAME || 'VU VAN CUONG');
const TELEGRAM_MIN_DEPOSIT = 10000;
const TELEGRAM_MAX_DEPOSIT = 100000000;
const TELEGRAM_DEPOSIT_TTL_MS = 15 * 60 * 1000;
// Dữ liệu của bot Telegram nằm trong nhánh riêng, không trộn vào users/orders/
// deposit_requests của website.
const TELEGRAM_DATA_ROOT = 'telegramBot';
const TELEGRAM_USERS_PATH = `${TELEGRAM_DATA_ROOT}/users`;
const TELEGRAM_ORDERS_PATH = `${TELEGRAM_DATA_ROOT}/orders`;
const TELEGRAM_DEPOSITS_PATH = `${TELEGRAM_DATA_ROOT}/deposits`;
const PROVIDER_VAULT_PATH = 'secure/providerSources';
const PROVIDER_STOCK_SYNC_LEASE_PATH = 'secure/providerStockSyncLease';
const PROVIDER_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const USER_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const PROVIDER_STOCK_SYNC_MIN_INTERVAL_MS = 4 * 1000;
const PROVIDER_STOCK_SYNC_LEASE_MS = 10 * 1000;
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
const userLoginAttempts = new Map();
let providerStockSyncPromise = null;

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

async function addAccountBalance(account, amount) {
    return fbTransaction(`${account.userPath}/balance`, balance => Number(balance || 0) + Number(amount || 0));
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

function requireTelegramBotConfig() {
    if (TELEGRAM_BOT_SHARED_SECRET.length < 32) {
        throw {
            status: 503,
            code: 'TELEGRAM_BOT_NOT_CONFIGURED',
            error: 'Chưa cấu hình TELEGRAM_BOT_SHARED_SECRET trên Netlify.'
        };
    }
}

function getTelegramHeader(event, name) {
    const headers = event.headers || {};
    return String(headers[name] || headers[name.toLowerCase()] || '').trim();
}

function validateTelegramId(value) {
    const telegramId = String(value || '').trim();
    if (!/^\d{1,30}$/.test(telegramId)) {
        throw { status: 400, code: 'INVALID_TELEGRAM_ID', error: 'Telegram ID không hợp lệ.' };
    }
    return telegramId;
}

function getTelegramBotIdentity(event) {
    const secret = getTelegramHeader(event, 'x-telegram-bot-secret');
    const telegramIdHeader = getTelegramHeader(event, 'x-telegram-user-id');
    if (!secret && !telegramIdHeader) return null;
    requireTelegramBotConfig();
    if (!secret || !safeSecretEqual(secret, TELEGRAM_BOT_SHARED_SECRET)) {
        throw { status: 401, code: 'INVALID_TELEGRAM_BOT_AUTH', error: 'Xác thực bot Telegram không hợp lệ.' };
    }
    const telegramId = validateTelegramId(telegramIdHeader);
    return { telegramId, username: `tg_${telegramId}`, channel: 'telegram' };
}

async function ensureTelegramUser(telegramId) {
    const identity = {
        telegramId: validateTelegramId(telegramId),
        username: `tg_${validateTelegramId(telegramId)}`,
        channel: 'telegram'
    };
    const userPath = `${TELEGRAM_USERS_PATH}/${identity.telegramId}`;
    const existing = await fbSecureGet(userPath);
    if (existing && typeof existing === 'object'
        && existing.telegramId !== undefined
        && String(existing.telegramId) !== identity.telegramId) {
        throw { status: 409, code: 'TELEGRAM_ID_COLLISION', error: 'Telegram ID đã bị trùng dữ liệu tài khoản.' };
    }
    if (!existing) {
        await fbTransaction(userPath, current => current ? undefined : ({
            username: identity.username,
            telegramId: identity.telegramId,
            source: 'telegram_bot',
            balance: 0,
            totalDeposited: 0,
            totalSpent: 0,
            totalOrders: 0,
            completedOrders: 0,
            createdAt: Date.now(),
            lastSeenAt: Date.now()
        }));
    }
    await fbSecurePatch(userPath, { lastSeenAt: Date.now() });
    const userData = await fbSecureGet(userPath);
    if (!userData || typeof userData !== 'object'
        || String(userData.telegramId || '') !== identity.telegramId) {
        throw { status: 409, code: 'TELEGRAM_USER_NOT_READY', error: 'Không thể khởi tạo ví Telegram.' };
    }
    return {
        username: identity.username,
        userData,
        telegramId: identity.telegramId,
        channel: 'telegram',
        userPath,
        ordersPath: TELEGRAM_ORDERS_PATH,
        depositsPath: TELEGRAM_DEPOSITS_PATH
    };
}

async function requireTelegramBotUser(event) {
    const identity = getTelegramBotIdentity(event);
    if (!identity) {
        throw { status: 401, code: 'TELEGRAM_BOT_AUTH_REQUIRED', error: 'Thiếu xác thực bot Telegram.' };
    }
    return ensureTelegramUser(identity.telegramId);
}

function requireTelegramBotService(event) {
    requireTelegramBotConfig();
    const secret = getTelegramHeader(event, 'x-telegram-bot-secret');
    if (!secret || !safeSecretEqual(secret, TELEGRAM_BOT_SHARED_SECRET)) {
        throw { status: 401, code: 'INVALID_TELEGRAM_BOT_AUTH', error: 'Xác thực bot Telegram không hợp lệ.' };
    }
}

async function confirmTelegramDeposit(account, memo, amount, transactionId) {
    const { telegramId, username, depositsPath, userPath } = account;
    if (!transactionId) throw { status: 400, code: 'INVALID_TRANSACTION_ID', error: 'Thiếu mã giao dịch ngân hàng.' };
    if (!Number.isInteger(amount) || amount < TELEGRAM_MIN_DEPOSIT || amount > TELEGRAM_MAX_DEPOSIT) {
        throw { status: 400, code: 'INVALID_DEPOSIT_AMOUNT', error: 'Số tiền giao dịch không hợp lệ.' };
    }
    const depositPath = `${depositsPath}/${memo}`;
    const deposit = await fbSecureGet(depositPath);
    if (!deposit || typeof deposit !== 'object'
        || deposit.username !== username
        || String(deposit.telegramId || '') !== telegramId) {
        throw { status: 404, code: 'DEPOSIT_NOT_FOUND', error: 'Không tìm thấy yêu cầu nạp tiền.' };
    }
    if (Number(deposit.amount || 0) !== amount) {
        throw { status: 400, code: 'DEPOSIT_AMOUNT_MISMATCH', error: 'Số tiền chuyển khoản không khớp yêu cầu nạp.' };
    }
    if (String(deposit.status || '') !== 'Chờ duyệt') {
        const userData = await fbSecureGet(userPath) || {};
        return {
            telegramId, memo, amount,
            status: String(deposit.status || 'Đã xử lý'),
            balance: Number(userData.balance || 0),
            alreadyProcessed: true
        };
    }

    const claim = await fbTransaction(depositPath, current => {
        if (!current || current.status !== 'Chờ duyệt') return undefined;
        return {
            ...current,
            status: 'Đang cộng tiền (Auto Telegram)',
            approvedAt: Date.now(),
            transactionId,
            approvedBy: 'telegram-sepay'
        };
    });
    if (!claim.committed) {
        const latest = await fbSecureGet(depositPath) || {};
        const userData = await fbSecureGet(userPath) || {};
        return {
            telegramId, memo, amount,
            status: String(latest.status || 'Đã xử lý'),
            balance: Number(userData.balance || 0),
            alreadyProcessed: true
        };
    }

    try {
        const balanceResult = await addAccountBalance(account, amount);
        await fbSecurePatch(depositPath, {
            status: 'Đã duyệt (Auto Telegram)',
            creditedAt: Date.now(),
            creditedAmount: amount,
            balanceAfter: Number(balanceResult.value || 0)
        });
        return {
            telegramId, memo, amount,
            status: 'Đã duyệt (Auto Telegram)',
            balance: Number(balanceResult.value || 0),
            processed: true
        };
    } catch (creditError) {
        await fbSecurePatch(depositPath, {
            status: 'Lỗi cộng tiền - cần kiểm tra',
            creditError: String(creditError.message || 'Không thể cộng tiền').slice(0, 240)
        });
        throw creditError;
    }
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

function validateFirebaseKeySegment(value, label = 'Mã dữ liệu') {
    const segment = String(value || '').trim();
    if (!segment || segment.length > 80 || /[.#$\[\]\/]/.test(segment)) {
        throw { status: 400, code: 'INVALID_KEY', error: `${label} không hợp lệ.` };
    }
    return segment;
}

function getProductDuration(product) {
    const direct = String(
        product?.duration
        || product?.productDuration
        || product?.term
        || product?.validity
        || ''
    ).trim();
    if (direct) return direct.slice(0, 120);
    const sourceText = String(`${product?.name || ''} ${product?.desc || ''}`).trim();
    const match = sourceText.match(/\b\d{1,4}\s*(?:ngày|ngay|tháng|thang|năm|nam|day|days|month|months|year|years)\b/i);
    return match ? match[0].replace(/\s+/g, ' ').slice(0, 120) : 'Dùng ngay';
}

function createUserSessionToken(username, sessionVersion) {
    const now = Date.now();
    const payload = {
        sub: 'user',
        username: validateFirebaseKeySegment(username, 'Tên đăng nhập'),
        sv: Number(sessionVersion || 0),
        iat: now,
        exp: now + USER_SESSION_TTL_MS,
        nonce: crypto.randomBytes(12).toString('hex')
    };
    const encoded = base64UrlEncode(JSON.stringify(payload));
    const signature = crypto.createHmac('sha256', deriveVaultKey('user-session-v1'))
        .update(encoded)
        .digest();
    return `${encoded}.${base64UrlEncode(signature)}`;
}

function verifyUserSessionToken(token) {
    requireProviderVaultConfig();
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw { status: 401, code: 'USER_AUTH_REQUIRED', error: 'Vui lòng đăng xuất rồi đăng nhập lại để thanh toán sản phẩm API.' };
    }
    const expected = crypto.createHmac('sha256', deriveVaultKey('user-session-v1'))
        .update(parts[0])
        .digest();
    const received = base64UrlDecode(parts[1]);
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
        throw { status: 401, code: 'INVALID_USER_SESSION', error: 'Phiên thanh toán không hợp lệ. Vui lòng đăng nhập lại.' };
    }
    let payload;
    try { payload = JSON.parse(base64UrlDecode(parts[0]).toString('utf8')); }
    catch (e) {
        throw { status: 401, code: 'INVALID_USER_SESSION', error: 'Phiên thanh toán không hợp lệ. Vui lòng đăng nhập lại.' };
    }
    if (payload.sub !== 'user' || !Number.isFinite(payload.exp) || payload.exp <= Date.now()) {
        throw { status: 401, code: 'USER_SESSION_EXPIRED', error: 'Phiên thanh toán đã hết hạn. Vui lòng đăng nhập lại.' };
    }
    payload.username = validateFirebaseKeySegment(payload.username, 'Tên đăng nhập');
    return payload;
}

function getBearerToken(event) {
    const authorization = String(event.headers.authorization || event.headers.Authorization || '');
    return /^Bearer\s+/i.test(authorization) ? authorization.replace(/^Bearer\s+/i, '').trim() : '';
}

async function requireCheckoutUser(event, apiKey) {
    const telegramIdentity = getTelegramBotIdentity(event);
    if (telegramIdentity) return ensureTelegramUser(telegramIdentity.telegramId);
    const bearerToken = getBearerToken(event);
    if (!bearerToken && apiKey) {
        const account = await authenticate(apiKey);
        return { ...account, channel: 'web', userPath: `users/${account.username}`, ordersPath: 'orders' };
    }
    const payload = verifyUserSessionToken(bearerToken);
    const userData = await fbSecureGet(`users/${payload.username}`);
    if (!userData || typeof userData !== 'object'
        || Number(userData.sessionVersion || 0) !== Number(payload.sv || 0)) {
        throw { status: 401, code: 'USER_SESSION_REVOKED', error: 'Phiên đăng nhập không còn hiệu lực. Vui lòng đăng nhập lại.' };
    }
    return {
        username: payload.username,
        userData,
        channel: 'web',
        userPath: `users/${payload.username}`,
        ordersPath: 'orders'
    };
}

function getAdminToken(event) {
    const authorization = String(event.headers.authorization || event.headers.Authorization || '');
    if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
    return String(event.headers['x-admin-token'] || event.headers['X-Admin-Token'] || '').trim();
}

async function requireAdminSession(event) {
    const token = getAdminToken(event);
    let payload;
    try {
        payload = verifyAdminSessionToken(token);
    } catch (adminSessionError) {
        try {
            const userPayload = verifyUserSessionToken(token);
            if (String(userPayload.username || '').trim().toLowerCase() !== 'admin') {
                throw { status: 403, code: 'ADMIN_PERMISSION_REQUIRED', error: 'Tài khoản không có quyền quản trị.' };
            }
            payload = userPayload;
        } catch (userSessionError) {
            if (userSessionError?.code === 'ADMIN_PERMISSION_REQUIRED') throw userSessionError;
            throw { status: 401, code: 'ADMIN_AUTH_REQUIRED', error: 'Phiên quản trị đã hết hạn. Vui lòng đăng xuất rồi đăng nhập lại.' };
        }
    }
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

function assertBrowserSameOrigin(event) {
    const origin = String(event.headers.origin || event.headers.Origin || '').trim();
    if (!origin) {
        throw { status: 403, code: 'INVALID_ORIGIN', error: 'Yêu cầu đồng bộ phải được gửi từ website.' };
    }
    assertAdminSameOrigin(event);
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

function assertUserLoginRate(event) {
    const key = getAdminClientKey(event);
    const now = Date.now();
    const windowStart = now - (10 * 60 * 1000);
    const recent = (userLoginAttempts.get(key) || []).filter(timestamp => timestamp >= windowStart);
    userLoginAttempts.set(key, recent);
    if (recent.length >= 10) {
        throw { status: 429, code: 'TOO_MANY_LOGIN_ATTEMPTS', error: 'Bạn thử đăng nhập quá nhiều lần. Vui lòng chờ 10 phút.' };
    }
    return key;
}

function recordUserLoginFailure(key) {
    const attempts = userLoginAttempts.get(key) || [];
    attempts.push(Date.now());
    userLoginAttempts.set(key, attempts.slice(-10));
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

function providerRequest(providerType, endpoint, apiKey, options = {}) {
    const config = getProviderConfig(providerType);
    const target = new URL(endpoint, config.baseUrl);
    const method = String(options.method || 'GET').toUpperCase();
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || (method === 'GET' ? 12000 : 30000));
    const requestBody = options.body === undefined ? '' : JSON.stringify(options.body);
    return new Promise((resolve, reject) => {
        let settled = false;
        let hardTimeout = null;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            if (hardTimeout) clearTimeout(hardTimeout);
            callback(value);
        };
        const request = https.request({
            hostname: target.hostname,
            port: 443,
            path: target.pathname + target.search,
            method,
            headers: {
                'Accept': 'application/json',
                'X-API-Key': apiKey,
                'User-Agent': 'TaiKhoanXin-ProviderVault/1.1',
                ...(requestBody ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody)
                } : {})
            }
        }, response => {
            let responseBody = '';
            response.on('data', chunk => {
                responseBody += chunk;
                if (responseBody.length > 5 * 1024 * 1024) {
                    request.destroy(new Error('Phản hồi nhà cung cấp quá lớn.'));
                }
            });
            response.on('end', () => {
                let payload = null;
                try { payload = responseBody ? JSON.parse(responseBody) : {}; }
                catch (e) {
                    return finish(reject, { status: 502, code: 'PROVIDER_INVALID_RESPONSE', error: 'Nhà cung cấp trả dữ liệu không hợp lệ.' });
                }
                const providerMessage = String(payload?.detail || payload?.message || payload?.error || payload?.msg || '')
                    .replaceAll(String(apiKey), '***')
                    .slice(0, 240);
                if (response.statusCode < 200 || response.statusCode >= 300 || payload?.success === false) {
                    return finish(reject, {
                        status: response.statusCode >= 400 && response.statusCode < 500 ? response.statusCode : 502,
                        code: 'PROVIDER_REJECTED',
                        error: providerMessage || `Nhà cung cấp từ chối kết nối (HTTP ${response.statusCode}).`,
                        providerResponded: true
                    });
                }
                finish(resolve, payload);
            });
        });
        request.setTimeout(timeoutMs, () => request.destroy(new Error('Nhà cung cấp phản hồi quá chậm.')));
        hardTimeout = setTimeout(() => request.destroy(new Error('Nhà cung cấp vượt quá thời gian chờ.')), timeoutMs);
        request.on('error', error => finish(reject, {
            status: 502,
            code: 'PROVIDER_UNAVAILABLE',
            error: String(error.message || 'Không thể kết nối nhà cung cấp.').slice(0, 240),
            uncertain: method !== 'GET'
        }));
        if (requestBody) request.write(requestBody);
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

function getProviderProductArray(payload) {
    const candidates = [
        payload,
        payload?.data,
        payload?.products,
        payload?.items,
        payload?.data?.products,
        payload?.data?.items,
        payload?.result,
        payload?.result?.products,
        payload?.data?.result?.products
    ];
    const products = candidates.find(Array.isArray);
    if (!products) {
        throw {
            status: 502,
            code: 'PROVIDER_INVALID_CATALOG',
            error: 'Nhà cung cấp trả danh mục sản phẩm không đúng cấu trúc.'
        };
    }
    return products;
}

function normalizeProviderProducts(providerType, payload) {
    return getProviderProductArray(payload).map(item => ({
        id: String(item.id ?? item.product_id ?? item.productId ?? ''),
        name: String(item.name ?? item.product_name ?? item.title ?? 'Sản phẩm').slice(0, 160),
        price: Number(item.price_vnd ?? item.price ?? item.unitPrice ?? 0) || 0,
        stock: Number(item.stock ?? item.quantity ?? item.available ?? 0) || 0,
        description: String(item.description ?? item.desc ?? item.note ?? '').slice(0, 500),
        providerType
    })).filter(item => item.id);
}

async function acquireProviderStockSyncLease() {
    const owner = crypto.randomBytes(12).toString('hex');
    const startedAt = Date.now();
    const result = await fbTransaction(PROVIDER_STOCK_SYNC_LEASE_PATH, current => {
        const state = current && typeof current === 'object' ? current : {};
        if (Number(state.expiresAt || 0) > startedAt) return undefined;
        if (Number(state.lastStartedAt || 0) > 0
            && startedAt - Number(state.lastStartedAt) < PROVIDER_STOCK_SYNC_MIN_INTERVAL_MS) {
            return undefined;
        }
        return {
            ...state,
            owner,
            startedAt,
            lastStartedAt: startedAt,
            expiresAt: startedAt + PROVIDER_STOCK_SYNC_LEASE_MS
        };
    }, 4);
    return result.committed ? { owner, startedAt } : null;
}

async function releaseProviderStockSyncLease(lease, result) {
    if (!lease) return;
    try {
        await fbTransaction(PROVIDER_STOCK_SYNC_LEASE_PATH, current => {
            if (!current || current.owner !== lease.owner) return undefined;
            return {
                ...current,
                owner: null,
                expiresAt: 0,
                lastCompletedAt: Date.now(),
                lastResult: result ? {
                    checkedProducts: Number(result.checkedProducts || 0),
                    updatedProducts: Number(result.updatedProducts || 0),
                    failedProviders: Number(result.failedProviders || 0)
                } : null
            };
        }, 3);
    } catch (error) {
        console.warn('Không thể giải phóng khóa đồng bộ tồn kho:', error.message || error);
    }
}

async function commitProviderStockUpdate(productId, expectedProduct, stock, liveProduct, syncStartedAt, options = {}) {
    const normalizedStock = Math.max(0, Math.floor(Number(stock) || 0));
    const normalizedCost = liveProduct ? Math.max(0, Number(liveProduct.price) || 0) : null;
    const preventIncrease = options.preventIncrease === true;
    const markObserved = options.markObserved === true;
    const quantityChanged = Math.max(0, Math.floor(Number(expectedProduct.quantity) || 0)) !== normalizedStock;
    const costChanged = normalizedCost !== null
        && Math.max(0, Number(expectedProduct.providerCost) || 0) !== normalizedCost;
    if (!quantityChanged && !costChanged && !markObserved) return false;

    const expectedProviderId = String(expectedProduct.providerId || '').trim();
    const expectedProviderType = String(expectedProduct.providerType || '').trim();
    const expectedProviderProductId = String(expectedProduct.providerProductId || '').trim();
    const result = await fbTransaction(`products/${productId}`, current => {
        if (!current || typeof current !== 'object') return undefined;
        if (current.sourceMode !== 'provider' && current.deliveryMode !== 'provider') return undefined;
        if (String(current.providerId || '').trim() !== expectedProviderId) return undefined;
        if (String(current.providerType || '').trim() !== expectedProviderType) return undefined;
        if (String(current.providerProductId || '').trim() !== expectedProviderProductId) return undefined;
        if (Number(current.providerStockSyncedAt || 0) >= syncStartedAt) return undefined;

        const currentQuantity = Math.max(0, Math.floor(Number(current.quantity) || 0));
        const nextQuantity = preventIncrease ? Math.min(currentQuantity, normalizedStock) : normalizedStock;
        const nextQuantityChanged = currentQuantity !== nextQuantity;
        const nextCostChanged = normalizedCost !== null
            && Math.max(0, Number(current.providerCost) || 0) !== normalizedCost;
        if (!nextQuantityChanged && !nextCostChanged && !markObserved) return undefined;

        return {
            ...current,
            ...(nextQuantityChanged ? { quantity: nextQuantity } : {}),
            ...(nextCostChanged ? { providerCost: normalizedCost } : {}),
            providerStockSyncedAt: syncStartedAt,
            updatedAt: Date.now()
        };
    }, 4);
    return result.committed;
}

async function syncProviderProductStocks() {
    if (providerStockSyncPromise) return providerStockSyncPromise;

    providerStockSyncPromise = (async () => {
        requireProviderVaultConfig();
        const lease = await acquireProviderStockSyncLease();
        if (!lease) {
            return { syncedAt: Date.now(), checkedProducts: 0, updatedProducts: 0, failedProviders: 0, skipped: true };
        }

        let syncResult = null;
        try {
            const productsRecord = await fbSecureGet('products') || {};
            const linkedProducts = Object.entries(productsRecord).filter(([, product]) => (
                product && typeof product === 'object'
                && (product.sourceMode === 'provider' || product.deliveryMode === 'provider')
            ));

            if (linkedProducts.length === 0) {
                syncResult = { syncedAt: Date.now(), checkedProducts: 0, updatedProducts: 0, failedProviders: 0 };
                return syncResult;
            }

            const providerRecords = await fbSecureGet(PROVIDER_VAULT_PATH) || {};
            const productsByProvider = new Map();
            const unavailableSourceUpdates = [];

            linkedProducts.forEach(([productId, product]) => {
                const providerId = String(product.providerId || '').trim();
                if (!providerId || !providerRecords[providerId] || providerRecords[providerId].enabled === false) {
                    unavailableSourceUpdates.push({ productId, product });
                    return;
                }
                if (!productsByProvider.has(providerId)) productsByProvider.set(providerId, []);
                productsByProvider.get(providerId).push([productId, product]);
            });

            const providerTasks = Array.from(productsByProvider.entries()).map(async ([providerId, products]) => {
                const record = providerRecords[providerId];
                try {
                    const storedKey = decryptProviderKey(record.secret, providerId, record.type);
                    const config = getProviderConfig(record.type);
                    const payload = await providerRequest(record.type, config.productsPath, storedKey, { timeoutMs: 6000 });
                    const catalog = normalizeProviderProducts(record.type, payload);
                    const catalogById = new Map(catalog.map(item => [String(item.id), item]));

                    const results = await Promise.all(products.map(([productId, product]) => {
                        const providerProductId = String(product.providerProductId || '').trim();
                        const liveProduct = catalogById.get(providerProductId) || null;
                        return commitProviderStockUpdate(
                            productId,
                            product,
                            liveProduct ? liveProduct.stock : 0,
                            liveProduct,
                            lease.startedAt
                        );
                    }));
                    return { updatedProducts: results.filter(Boolean).length, failedProviders: 0 };
                } catch (error) {
                    return { updatedProducts: 0, failedProviders: 1 };
                }
            });

            const unavailableSourceTask = Promise.all(unavailableSourceUpdates.map(update => commitProviderStockUpdate(
                update.productId,
                update.product,
                0,
                null,
                lease.startedAt
            ))).then(results => ({ updatedProducts: results.filter(Boolean).length, failedProviders: 0 }));
            const taskResults = await Promise.all([unavailableSourceTask, ...providerTasks]);
            syncResult = {
                syncedAt: Date.now(),
                checkedProducts: linkedProducts.length,
                updatedProducts: taskResults.reduce((sum, item) => sum + item.updatedProducts, 0),
                failedProviders: taskResults.reduce((sum, item) => sum + item.failedProviders, 0)
            };
            return syncResult;
        } finally {
            await releaseProviderStockSyncLease(lease, syncResult);
        }
    })();

    try {
        return await providerStockSyncPromise;
    } finally {
        providerStockSyncPromise = null;
    }
}

function providerProductIdValue(value) {
    const text = String(value ?? '').trim();
    return /^\d+$/.test(text) ? Number(text) : text;
}

function buildProviderPurchaseBody(providerType, productId, quantity, orderId) {
    const normalizedId = providerProductIdValue(productId);
    if (providerType === 'nastele') return { productId: normalizedId, qty: quantity };
    if (providerType === 'tunvn') return { product_id: normalizedId, quantity, currency: 'vnd' };
    if (providerType === 'nanlux') {
        return { product_id: normalizedId, qty: quantity, buyer_info: `Website order ${orderId}` };
    }
    return { product_id: normalizedId, qty: quantity };
}

function formatProviderAccount(value) {
    if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
    if (!value || typeof value !== 'object') return '';
    if (typeof value.account === 'string') return value.account.trim();
    if (typeof value.value === 'string') return value.value.trim();
    const fields = [
        value.username ?? value.email ?? value.login ?? value.user ?? value.id,
        value.password ?? value.pass,
        value.twofa ?? value.two_fa ?? value['2fa'] ?? value.recovery ?? value.recovery_email ?? value.secret,
        value.note
    ].map(item => item === undefined || item === null ? '' : String(item).trim()).filter(Boolean);
    return fields.join('|');
}

function serializeProviderAccount(value) {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (!value || typeof value !== 'object') return '';
    try {
        return JSON.stringify(value);
    } catch (_) {
        return String(value);
    }
}

function extractProviderAccountRecords(payload) {
    const results = [];
    const collect = (value, depth = 0) => {
        if (depth > 5 || value === undefined || value === null) return;
        if (Array.isArray(value)) {
            value.forEach(item => collect(item, depth + 1));
            return;
        }
        if (typeof value === 'string' || typeof value === 'number') {
            const account = formatProviderAccount(value);
            if (account) results.push({ account, raw: serializeProviderAccount(value) });
            return;
        }
        if (typeof value !== 'object') return;
        if (Array.isArray(value.accounts)) return collect(value.accounts, depth + 1);
        if (Array.isArray(value.items)) return collect(value.items, depth + 1);
        const account = formatProviderAccount(value);
        if (account) results.push({ account, raw: serializeProviderAccount(value) });
    };

    const candidates = [
        payload?.accounts,
        payload?.items,
        payload?.data?.accounts,
        payload?.data?.items,
        payload?.order?.accounts,
        payload?.order?.items,
        payload?.data?.order?.accounts,
        payload?.data?.order?.items,
        payload?.result?.accounts,
        payload?.result?.items,
        payload?.data?.result?.accounts,
        payload?.data?.result?.items
    ];
    candidates.forEach(candidate => collect(candidate));
    const seen = new Set();
    return results.filter(item => {
        const key = `${item.account}\n${item.raw}`;
        if (!item.account || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function normalizeProviderPurchase(providerType, payload) {
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    const accountRecords = extractProviderAccountRecords(payload);
    const accounts = accountRecords.map(item => item.account);
    const rawAccounts = accountRecords.map(item => item.raw || item.account);
    const orderId = data?.order_id ?? data?.orderId ?? data?.order_code
        ?? payload?.order_id ?? payload?.orderId ?? payload?.order_code
        ?? data?.id ?? payload?.id ?? '';
    const totalCost = Number(
        data?.total_cost ?? data?.totalAmount ?? data?.amount_vnd ?? data?.total_price
        ?? payload?.total_cost ?? payload?.totalAmount ?? payload?.amount_vnd ?? payload?.total_price ?? 0
    ) || 0;
    return {
        providerType,
        providerOrderId: String(orderId || ''),
        totalCost,
        accounts,
        rawAccounts
    };
}

async function buyProviderProduct(record, providerId, productId, quantity, orderId) {
    const config = getProviderConfig(record.type);
    const storedKey = decryptProviderKey(record.secret, providerId, record.type);
    const payload = await providerRequest(record.type, config.buyPath, storedKey, {
        method: 'POST',
        body: buildProviderPurchaseBody(record.type, productId, quantity, orderId)
    });
    const purchase = normalizeProviderPurchase(record.type, payload);
    if (purchase.accounts.length < quantity) {
        throw {
            status: 502,
            code: 'PROVIDER_EMPTY_DELIVERY',
            error: 'Nguồn đã nhận yêu cầu nhưng chưa trả đủ dữ liệu tài khoản. Admin cần kiểm tra đơn bên nguồn.',
            uncertain: true
        };
    }
    return purchase;
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
        return ok({ service: 'TaiKhoanXin API (Netlify)', version: '1.6.0', endpoints: ['/api/balance', '/api/apps', '/api/rent', '/api/otp/:id', '/api/cancel/:id', '/api/history', '/api/user/catalog', '/api/user/balance', '/api/user/orders', '/api/telegram/deposit', '/api/telegram/deposit/:memo', '/api/telegram/deposit/confirm', '/api/telegram/deposit/confirm-by-memo', '/api/telegram/admin/stats', '/api/provider/checkout', '/api/provider/order/:id'] });

    try {
        // Các thao tác đăng nhập, quản trị và mua hàng chỉ nhận yêu cầu cùng website.
        if (path.startsWith('/admin/') || path.startsWith('/user/') || path.startsWith('/provider/')) {
            assertAdminSameOrigin(event);
        }

        if (path === '/user/session' && method === 'POST') {
            requireProviderVaultConfig();
            const rateKey = assertUserLoginRate(event);
            const username = validateFirebaseKeySegment(body.username, 'Tên đăng nhập');
            const password = String(body.password || '');
            if (!password || password.length > 300) {
                recordUserLoginFailure(rateKey);
                return err(401, 'INVALID_USER_CREDENTIALS', 'Tên đăng nhập hoặc mật khẩu không đúng.');
            }
            const userData = await fbSecureGet(`users/${username}`);
            if (!userData || typeof userData !== 'object' || !safeSecretEqual(password, userData.password)) {
                recordUserLoginFailure(rateKey);
                return err(401, 'INVALID_USER_CREDENTIALS', 'Tên đăng nhập hoặc mật khẩu không đúng.');
            }
            userLoginAttempts.delete(rateKey);
            return ok({
                data: {
                    token: createUserSessionToken(username, userData.sessionVersion),
                    expiresIn: USER_SESSION_TTL_MS,
                    expiresAt: Date.now() + USER_SESSION_TTL_MS,
                    username,
                    sessionVersion: Number(userData.sessionVersion || 0)
                }
            });
        }

        // ---- GET /api/user/catalog ----
        // Danh mục dành cho bot/ứng dụng bên ngoài. Chỉ trả sản phẩm giao từ provider,
        // không trả API key nguồn hoặc dữ liệu kho nội bộ.
        if (path === '/user/catalog' && method === 'GET') {
            const { username, channel } = await requireCheckoutUser(event, apiKey);
            const rawProducts = await fbSecureGet('products') || {};
            const events = await fbSecureGet('settings/events') || {};
            const discountPercent = Math.min(100, Math.max(0, Number(events.discountPercent || 0)));
            const products = Object.entries(rawProducts)
                .filter(([, product]) => product && typeof product === 'object')
                .filter(([, product]) => product.sourceMode === 'provider' || product.deliveryMode === 'provider')
                .map(([id, product]) => {
                    const webPrice = Number(product.price || 0);
                    const telegramPrice = Number(product.telegramPrice || 0);
                    const price = channel === 'telegram' && Number.isFinite(telegramPrice) && telegramPrice > 0
                        ? telegramPrice
                        : webPrice;
                    const finalPrice = Math.round(price - (price * discountPercent / 100));
                    return {
                        id,
                        name: String(product.name || 'Sản phẩm').slice(0, 160),
                        duration: getProductDuration(product),
                        format: String(product.format || '').slice(0, 120),
                        desc: String(product.desc || '').slice(0, 1200),
                        price,
                        finalPrice,
                        quantity: Math.max(0, Math.floor(Number(product.quantity) || 0)),
                        logoUrl: Array.isArray(product.logoUrls) ? String(product.logoUrls[0] || '') : '',
                        warranty: String(product.warranty || 'Không bảo hành').slice(0, 160),
                        warrantyDays: Number(product.warrantyDays || 0)
                    };
                })
                .filter(product => product.price > 0)
                .sort((a, b) => Number(b.quantity > 0) - Number(a.quantity > 0) || a.name.localeCompare(b.name, 'vi'));
            return ok({ data: { username, channel, discountPercent, products } });
        }

        // ---- GET /api/user/balance ----
        if (path === '/user/balance' && method === 'GET') {
            const { username, userData } = await requireCheckoutUser(event, apiKey);
            const balance = Number(userData.balance || 0);
            return ok({ data: { username, balance, balance_display: balance.toLocaleString('vi-VN') + 'đ' } });
        }

        // ---- GET /api/user/orders ----
        // Chỉ trả lịch sử tóm tắt; thông tin tài khoản được lấy riêng theo orderId.
        if (path === '/user/orders' && method === 'GET') {
            const account = await requireCheckoutUser(event, apiKey);
            const { username } = account;
            const allOrders = await fbSecureGet(account.ordersPath || 'orders') || {};
            const orders = Object.entries(allOrders)
                .filter(([, order]) => order && typeof order === 'object' && order.username === username)
                .map(([orderId, order]) => ({
                    orderId,
                    productName: String(order.productName || 'Sản phẩm').slice(0, 180),
                    quantity: Number(order.quantity || 1),
                    price: Number(order.price || 0),
                    status: String(order.status || 'Đang xử lý').slice(0, 120),
                    timestamp: Number(order.timestamp || order.purchasedAt || 0),
                    fulfilledAt: Number(order.fulfilledAt || 0),
                    accountAvailable: Array.isArray(order.deliveredAccounts)
                        ? order.deliveredAccounts.length > 0
                        : Boolean(String(order.accountDetails || '').trim() && order.status === 'Hoàn thành')
                }))
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, 20);
            return ok({ data: { username, orders } });
        }

        // ---- POST /api/telegram/deposit ----
        // Tạo yêu cầu nạp tiền trong telegramBot/deposits, không đưa vào hàng duyệt của website.
        if (path === '/telegram/deposit' && method === 'POST') {
            const { telegramId, username, depositsPath } = await requireTelegramBotUser(event);
            const amount = Number(body.amount);
            if (!Number.isInteger(amount) || amount < TELEGRAM_MIN_DEPOSIT || amount > TELEGRAM_MAX_DEPOSIT) {
                return err(400, 'INVALID_DEPOSIT_AMOUNT', `Số tiền nạp phải từ ${TELEGRAM_MIN_DEPOSIT.toLocaleString('vi-VN')}đ đến ${TELEGRAM_MAX_DEPOSIT.toLocaleString('vi-VN')}đ.`);
            }
            const now = Date.now();
            let memo = '';
            for (let attempt = 0; attempt < 8; attempt += 1) {
                const candidate = `Chuyentien_${crypto.randomInt(10000, 100000)}`;
                if (!(await fbSecureGet(`${depositsPath}/${candidate}`))) {
                    memo = candidate;
                    break;
                }
            }
            if (!memo) {
                return err(503, 'DEPOSIT_MEMO_UNAVAILABLE', 'Không thể tạo mã nạp tiền lúc này. Vui lòng thử lại.');
            }
            const expiresAt = now + TELEGRAM_DEPOSIT_TTL_MS;
            await fbSecureSet(`${depositsPath}/${memo}`, {
                username,
                telegramId,
                source: 'telegram_bot',
                amount,
                memo,
                timestamp: now,
                expiresAt,
                date: new Date(now).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
                status: 'Chờ duyệt'
            });
            const qrUrl = `https://img.vietqr.io/image/${encodeURIComponent(TELEGRAM_BANK_BIN)}-${encodeURIComponent(TELEGRAM_BANK_ACCOUNT)}-compact2.jpg?amount=${amount}&addInfo=${encodeURIComponent(memo)}&accountName=${encodeURIComponent(TELEGRAM_ACCOUNT_NAME)}`;
            return ok({
                data: {
                    telegramId,
                    username,
                    amount,
                    memo,
                    expiresAt,
                    bank: {
                        bin: TELEGRAM_BANK_BIN,
                        account: TELEGRAM_BANK_ACCOUNT,
                        accountName: TELEGRAM_ACCOUNT_NAME
                    },
                    qrUrl
                }
            });
        }

        // ---- GET /api/telegram/deposit/:memo ----
        if (path.startsWith('/telegram/deposit/') && method === 'GET') {
            const account = await requireTelegramBotUser(event);
            const { telegramId, username, depositsPath, userPath } = account;
            const memo = validateFirebaseKeySegment(path.replace('/telegram/deposit/', ''), 'Mã nạp tiền');
            const deposit = await fbSecureGet(`${depositsPath}/${memo}`);
            if (!deposit || typeof deposit !== 'object'
                || deposit.username !== username
                || String(deposit.telegramId || '') !== telegramId) {
                return err(404, 'DEPOSIT_NOT_FOUND', 'Không tìm thấy yêu cầu nạp tiền.');
            }
            const userData = await fbSecureGet(userPath) || {};
            return ok({
                data: {
                    telegramId,
                    memo,
                    amount: Number(deposit.amount || 0),
                    status: String(deposit.status || 'Chờ duyệt'),
                    expiresAt: Number(deposit.expiresAt || 0),
                    balance: Number(userData.balance || 0),
                    approvedAt: Number(deposit.approvedAt || 0),
                    creditedAt: Number(deposit.creditedAt || 0)
                }
            });
        }

        // ---- POST /api/telegram/deposit/confirm ----
        // SePay webhook của bot gọi endpoint này. Giao dịch được claim bằng Firebase transaction
        // nên webhook gửi lại không cộng tiền lần hai.
        if (path === '/telegram/deposit/confirm' && method === 'POST') {
            const account = await requireTelegramBotUser(event);
            const memo = validateFirebaseKeySegment(body.memo, 'Mã nạp tiền');
            const amount = Number(body.amount);
            const transactionId = String(body.transactionId || '').trim().slice(0, 160);
            return ok({ data: await confirmTelegramDeposit(account, memo, amount, transactionId) });
        }

        // ---- POST /api/telegram/deposit/confirm-by-memo ----
        // Chỉ bot server được gọi; SePay không cần biết ID Telegram của khách.
        if (path === '/telegram/deposit/confirm-by-memo' && method === 'POST') {
            requireTelegramBotService(event);
            const memo = validateFirebaseKeySegment(body.memo, 'Mã nạp tiền');
            const deposit = await fbSecureGet(`${TELEGRAM_DEPOSITS_PATH}/${memo}`);
            if (!deposit || typeof deposit !== 'object' || deposit.source !== 'telegram_bot') {
                return err(404, 'DEPOSIT_NOT_FOUND', 'Không tìm thấy yêu cầu nạp tiền.');
            }
            const telegramId = validateTelegramId(deposit.telegramId);
            const account = await ensureTelegramUser(telegramId);
            const amount = Number(body.amount);
            const transactionId = String(body.transactionId || '').trim().slice(0, 160);
            return ok({ data: await confirmTelegramDeposit(account, memo, amount, transactionId) });
        }

        if (path === '/provider/stock-sync' && method === 'POST') {
            assertBrowserSameOrigin(event);
            const result = await syncProviderProductStocks();
            return ok({ data: result });
        }

        if (path === '/provider/checkout' && method === 'POST') {
            requireProviderVaultConfig();
            const account = await requireCheckoutUser(event, apiKey);
            const { username, userPath, ordersPath } = account;
            const productId = validateFirebaseKeySegment(body.productId, 'Mã sản phẩm');
            const orderId = validateFirebaseKeySegment(body.orderId, 'Mã đơn hàng');
            const quantity = Number(body.quantity);
            if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
                return err(400, 'INVALID_QUANTITY', 'Số lượng mua phải từ 1 đến 100.');
            }

            const orderPath = `${ordersPath}/${orderId}`;
            const existingOrder = await fbSecureGet(orderPath);
            if (existingOrder) {
                if (existingOrder.username === username
                    && existingOrder.fulfillmentSource === 'provider'
                    && (existingOrder.status === 'Hoàn thành' || existingOrder.providerPurchaseState === 'completed')) {
                    const deliveredAccounts = Array.isArray(existingOrder.deliveredAccounts)
                        ? existingOrder.deliveredAccounts
                        : Object.values(existingOrder.deliveredAccounts || {});
                    return ok({
                        data: {
                            orderId,
                            totalAmount: Number(existingOrder.price || 0),
                            deliveredQuantity: deliveredAccounts.length,
                            status: existingOrder.status,
                            idempotent: true
                        }
                    });
                }
                return err(409, 'ORDER_ALREADY_EXISTS', 'Đơn hàng này đã được tạo hoặc đang xử lý. Vui lòng xem trong lịch sử đơn.');
            }

            const product = await fbSecureGet(`products/${productId}`);
            if (!product || typeof product !== 'object') return err(404, 'PRODUCT_NOT_FOUND', 'Sản phẩm không còn tồn tại.');
            if (product.sourceMode !== 'provider' && product.deliveryMode !== 'provider') {
                return err(400, 'PRODUCT_NOT_PROVIDER', 'Sản phẩm này không được cấu hình giao từ nguồn API.');
            }
            const providerId = validateProviderId(product.providerId);
            const providerProductId = String(product.providerProductId || '').trim();
            if (!providerProductId) return err(400, 'PROVIDER_PRODUCT_MISSING', 'Sản phẩm chưa liên kết với mã hàng bên nguồn.');

            const providerRecord = await fbSecureGet(`${PROVIDER_VAULT_PATH}/${providerId}`);
            if (!providerRecord || typeof providerRecord !== 'object' || providerRecord.enabled === false) {
                return err(409, 'PROVIDER_DISABLED', 'Nguồn API đang tắt hoặc đã bị xóa.');
            }
            const storedKey = decryptProviderKey(providerRecord.secret, providerId, providerRecord.type);
            const providerConfig = getProviderConfig(providerRecord.type);
            const stockCheckStartedAt = Date.now();
            const catalogPayload = await providerRequest(providerRecord.type, providerConfig.productsPath, storedKey, { timeoutMs: 8000 });
            const providerProducts = normalizeProviderProducts(providerRecord.type, catalogPayload);
            const liveProduct = providerProducts.find(item => String(item.id) === providerProductId);
            if (!liveProduct) {
                await commitProviderStockUpdate(productId, product, 0, null, stockCheckStartedAt);
                return err(404, 'PROVIDER_PRODUCT_NOT_FOUND', 'Sản phẩm không còn trong danh mục của nguồn API.');
            }
            if (Number(liveProduct.stock || 0) < quantity) {
                await commitProviderStockUpdate(productId, product, liveProduct.stock, liveProduct, stockCheckStartedAt);
                return err(409, 'PROVIDER_OUT_OF_STOCK', `Nguồn API chỉ còn ${Number(liveProduct.stock || 0)} sản phẩm.`);
            }

            const events = await fbSecureGet('settings/events') || {};
            const discountPercent = Math.min(100, Math.max(0, Number(events.discountPercent || 0)));
            const configuredTelegramPrice = Number(product.telegramPrice || 0);
            const basePrice = account.channel === 'telegram'
                && Number.isFinite(configuredTelegramPrice)
                && configuredTelegramPrice > 0
                ? configuredTelegramPrice
                : Number(product.price || 0);
            if (!Number.isFinite(basePrice) || basePrice <= 0) return err(400, 'INVALID_PRODUCT_PRICE', 'Giá bán sản phẩm không hợp lệ.');
            const unitPrice = Math.round(basePrice - (basePrice * discountPercent / 100));
            const totalAmount = unitPrice * quantity;
            const providerUnitCost = Number(liveProduct.price || 0);
            if (providerUnitCost > unitPrice) {
                await commitProviderStockUpdate(
                    productId,
                    product,
                    liveProduct.stock,
                    liveProduct,
                    stockCheckStartedAt
                );
                return err(
                    409,
                    'PROVIDER_PRICE_INCREASED',
                    `Giá nguồn hiện là ${providerUnitCost.toLocaleString('vi-VN')}đ, cao hơn giá bán sau khuyến mãi ${unitPrice.toLocaleString('vi-VN')}đ. Admin cần cập nhật giá bán.`
                );
            }
            const now = Date.now();
            const dateDisplay = new Date(now).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
            const orderBase = {
                username,
                ...(account.channel === 'telegram' ? {
                    telegramId: account.telegramId,
                    channel: 'telegram_bot'
                } : {}),
                productId,
                productName: `${product.name || liveProduct.name} (x${quantity})`,
                quantity,
                duration: getProductDuration(product),
                productFormat: product.format || '',
                price: totalAmount,
                priceChannel: account.channel === 'telegram' ? 'telegram' : 'web',
                date: dateDisplay,
                timestamp: now,
                purchasedAt: now,
                purchasedAtDisplay: dateDisplay,
                warranty: product.warranty || 'Không bảo hành',
                warrantyDays: Number(product.warrantyDays || 0),
                deliveryMode: 'provider',
                fulfillmentSource: 'provider',
                providerId,
                providerType: providerRecord.type,
                providerLabel: String(providerRecord.label || product.providerLabel || 'Nguồn API').slice(0, 80),
                providerProductId,
                status: 'Đang xử lý đơn hàng...',
                providerPurchaseState: 'reserved',
                accountDetails: 'Đơn đã thanh toán và đang được xử lý.'
            };

            const reservation = await fbTransaction(orderPath, current => current ? undefined : orderBase);
            if (!reservation.committed) return err(409, 'ORDER_ALREADY_EXISTS', 'Đơn hàng đã được tạo. Vui lòng xem trong lịch sử đơn.');

            const debit = await fbTransaction(`${userPath}/balance`, balance => {
                const available = Number(balance || 0);
                if (available < totalAmount) return undefined;
                return available - totalAmount;
            });
            if (!debit.committed) {
                await fbSecurePatch(orderPath, {
                    status: 'Hủy - Số dư không đủ',
                    providerPurchaseState: 'cancelled',
                    accountDetails: 'Số dư không đủ để thanh toán.',
                    cancelledAt: Date.now()
                });
                return err(402, 'INSUFFICIENT_BALANCE', 'Số dư không đủ để thanh toán sản phẩm.');
            }

            await fbSecurePatch(orderPath, {
                paymentState: 'paid',
                providerPurchaseState: 'processing',
                balanceAfterPayment: Number(debit.value || 0)
            });

            try {
                const purchase = await buyProviderProduct(providerRecord, providerId, providerProductId, quantity, orderId);
                const deliveredAccounts = purchase.accounts;
                const postPurchaseStockStartedAt = Date.now();
                const postPurchaseStockPromise = providerRequest(
                    providerRecord.type,
                    providerConfig.productsPath,
                    storedKey,
                    { timeoutMs: 5000 }
                ).then(payload => {
                    const products = normalizeProviderProducts(providerRecord.type, payload);
                    return {
                        succeeded: true,
                        product: products.find(item => String(item.id) === providerProductId) || null,
                        observedAt: Date.now()
                    };
                }).catch(error => {
                    console.warn('Không thể đọc lại tồn kho ngay sau khi mua:', error.message || error);
                    return { succeeded: false, product: null };
                });
                const accountDetails = deliveredAccounts.length <= 1
                    ? deliveredAccounts[0]
                    : deliveredAccounts.map((item, index) => `[${index + 1}] ${item}`).join('\n');
                await fbSecurePatch(orderPath, {
                    status: 'Hoàn thành',
                    accountDetails,
                    deliveredAccounts,
                    deliveredRawAccounts: purchase.rawAccounts,
                    deliveredQuantity: deliveredAccounts.length,
                    autoFulfilled: true,
                    providerPurchaseState: 'completed',
                    providerOrderId: purchase.providerOrderId,
                    fulfilledAt: Date.now()
                });
                try {
                    await fbTransaction(`products/${productId}`, current => {
                        if (!current || typeof current !== 'object') return undefined;
                        if (current.sourceMode !== 'provider' && current.deliveryMode !== 'provider') return undefined;
                        if (String(current.providerId || '').trim() !== providerId) return undefined;
                        if (String(current.providerType || '').trim() !== String(product.providerType || '').trim()) return undefined;
                        if (String(current.providerProductId || '').trim() !== providerProductId) return undefined;
                        const currentSyncAt = Number(current.providerStockSyncedAt || 0);
                        const currentQuantity = Math.max(0, Math.floor(Number(current.quantity) || 0));
                        return {
                            ...current,
                            quantity: Math.max(0, currentQuantity - quantity),
                            providerCost: Number(liveProduct.price || product.providerCost || 0),
                            providerProductName: liveProduct.name,
                            providerStockSyncedAt: Math.max(currentSyncAt, postPurchaseStockStartedAt),
                            updatedAt: Date.now()
                        };
                    }, 4);
                } catch (error) {
                    console.warn('Không thể giảm tồn kho cục bộ ngay sau khi mua:', error.message || error);
                }
                const refreshedStock = await postPurchaseStockPromise;
                if (refreshedStock.succeeded) {
                    try {
                        await commitProviderStockUpdate(
                            productId,
                            product,
                            refreshedStock.product ? refreshedStock.product.stock : 0,
                            refreshedStock.product,
                            refreshedStock.observedAt,
                            { preventIncrease: true, markObserved: true }
                        );
                    } catch (error) {
                        console.warn('Không thể chốt tồn kho sau khi mua:', error.message || error);
                    }
                }
                await fbSecureSet(`secure/providerOrderAudit/${orderId}`, {
                    providerId,
                    providerType: providerRecord.type,
                    providerOrderId: purchase.providerOrderId,
                    productId,
                    providerProductId,
                    requestedQuantity: quantity,
                    deliveredQuantity: deliveredAccounts.length,
                    providerCost: Number(purchase.totalCost || liveProduct.price * quantity || 0),
                    createdAt: now,
                    fulfilledAt: Date.now()
                });
                return ok({
                    data: {
                        orderId,
                        status: 'Hoàn thành',
                        totalAmount,
                        balanceRemaining: Number(debit.value || 0),
                        deliveredQuantity: deliveredAccounts.length
                    }
                });
            } catch (providerError) {
                if (providerError.uncertain) {
                    await fbSecurePatch(orderPath, {
                        status: 'Cần admin kiểm tra nguồn',
                        providerPurchaseState: 'uncertain',
                        accountDetails: 'Đơn đang được kiểm tra. Vui lòng liên hệ hỗ trợ nếu cần.',
                        providerError: String(providerError.error || 'Không có phản hồi rõ ràng').slice(0, 240)
                    });
                    throw {
                        status: 502,
                        code: 'PROVIDER_PURCHASE_UNCERTAIN',
                        error: 'Đơn chưa nhận được kết quả đầy đủ. Đơn đã chuyển cho admin kiểm tra và chưa bị xử lý lại.'
                    };
                }

                const refund = await addAccountBalance(account, totalAmount);
                await fbSecurePatch(orderPath, {
                    status: 'Hủy - Đã hoàn tiền',
                    providerPurchaseState: 'refunded',
                    accountDetails: 'Đơn không thể hoàn tất. Hệ thống đã hoàn tiền vào số dư.',
                    providerError: String(providerError.error || 'Nguồn từ chối đơn').slice(0, 240),
                    refundedAt: Date.now(),
                    refundedAmount: totalAmount,
                    balanceAfterRefund: Number(refund.value || 0)
                });
                throw {
                    status: providerError.status || 409,
                    code: providerError.code || 'PROVIDER_PURCHASE_FAILED',
                    error: `${providerError.error || 'Nguồn API từ chối đơn.'} Tiền đã được hoàn vào số dư web.`
                };
            }
        }

        // ---- GET /api/provider/order/:id ----
        // Trả thông tin giao hàng cho đúng chủ đơn để bot có thể giao tài khoản.
        if (path.startsWith('/provider/order/') && method === 'GET') {
            const account = await requireCheckoutUser(event, apiKey);
            const { username, ordersPath } = account;
            const orderId = validateFirebaseKeySegment(path.replace('/provider/order/', ''), 'Mã đơn hàng');
            const order = await fbSecureGet(`${ordersPath}/${orderId}`);
            if (!order || typeof order !== 'object' || order.username !== username) {
                return err(404, 'ORDER_NOT_FOUND', 'Không tìm thấy đơn hàng hoặc bạn không có quyền xem đơn này.');
            }
            return ok({
                data: {
                    orderId,
                    productName: String(order.productName || 'Sản phẩm').slice(0, 180),
                    quantity: Number(order.quantity || 1),
                    price: Number(order.price || 0),
                    status: String(order.status || 'Đang xử lý').slice(0, 120),
                    accountDetails: String(order.accountDetails || '').slice(0, 12000),
                    deliveredAccounts: Array.isArray(order.deliveredAccounts) ? order.deliveredAccounts : [],
                    deliveredQuantity: Number(order.deliveredQuantity || 0),
                    warranty: String(order.warranty || 'Không bảo hành').slice(0, 160),
                    warrantyDays: Number(order.warrantyDays || 0),
                    fulfilledAt: Number(order.fulfilledAt || 0)
                }
            });
        }

        // ---- GET /api/telegram/admin/stats ----
        // Thống kê riêng của bot Telegram. Không đọc users/orders của website.
        if (path === '/telegram/admin/stats' && method === 'GET') {
            await requireTelegramBotUser(event);
            const [usersRecord, ordersRecord, depositsRecord] = await Promise.all([
                fbSecureGet(TELEGRAM_USERS_PATH),
                fbSecureGet(TELEGRAM_ORDERS_PATH),
                fbSecureGet(TELEGRAM_DEPOSITS_PATH)
            ]);
            const users = usersRecord && typeof usersRecord === 'object' ? usersRecord : {};
            const orders = ordersRecord && typeof ordersRecord === 'object' ? ordersRecord : {};
            const deposits = depositsRecord && typeof depositsRecord === 'object' ? depositsRecord : {};
            const orderEntries = Object.entries(orders).filter(([, order]) => order && typeof order === 'object');
            const depositEntries = Object.entries(deposits).filter(([, deposit]) => deposit && typeof deposit === 'object');
            const isCompleted = order => String(order.status || '') === 'Hoàn thành'
                || String(order.providerPurchaseState || '') === 'completed';
            const isCredited = deposit => Number(deposit.creditedAt || 0) > 0
                || String(deposit.status || '').includes('Đã duyệt');
            const completedOrders = orderEntries.filter(([, order]) => isCompleted(order));
            const creditedDeposits = depositEntries.filter(([, deposit]) => isCredited(deposit));
            const customers = Object.entries(users).map(([telegramId, user]) => {
                const userOrders = orderEntries.filter(([, order]) => (
                    String(order.telegramId || '') === String(telegramId)
                    || String(order.username || '') === `tg_${telegramId}`
                ));
                const userDeposits = depositEntries.filter(([, deposit]) => (
                    String(deposit.telegramId || '') === String(telegramId)
                ));
                const finished = userOrders.filter(([, order]) => isCompleted(order));
                const deposited = userDeposits
                    .filter(([, deposit]) => isCredited(deposit))
                    .reduce((sum, [, deposit]) => sum + Number(deposit.creditedAmount || deposit.amount || 0), 0);
                const spent = finished.reduce((sum, [, order]) => sum + Number(order.price || 0), 0);
                return {
                    telegramId: String(telegramId),
                    balance: Number(user.balance || 0),
                    orders: userOrders.length,
                    completedOrders: finished.length,
                    deposited,
                    spent,
                    createdAt: Number(user.createdAt || 0),
                    lastSeenAt: Number(user.lastSeenAt || user.createdAt || 0)
                };
            }).sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 100);
            return ok({ data: {
                summary: {
                    customers: Object.keys(users).length,
                    orders: orderEntries.length,
                    completedOrders: completedOrders.length,
                    revenue: completedOrders.reduce((sum, [, order]) => sum + Number(order.price || 0), 0),
                    deposits: creditedDeposits.length,
                    depositedAmount: creditedDeposits.reduce((sum, [, deposit]) => sum + Number(deposit.creditedAmount || deposit.amount || 0), 0),
                    balances: Object.values(users).reduce((sum, user) => sum + Number(user?.balance || 0), 0)
                },
                customers
            } });
        }

        // ---- KÉT API NHÀ CUNG CẤP (chỉ admin) ----

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
