// --- Firebase Configuration ---
// TODO: Thay thế đoạn mã bên dưới bằng cấu hình từ dự án Firebase của bạn
// Bạn copy đoạn cấu hình trong mục "Project settings" > "General" > "Your apps" > "SDK setup and configuration"
const firebaseConfig = {
    apiKey: "AIzaSyBPqrzmBQZZ_cjKhNwl66zYG71ojJofP88",
    authDomain: "accstore-47e37.firebaseapp.com",
    databaseURL: "https://accstore-47e37-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "accstore-47e37",
    storageBucket: "accstore-47e37.firebasestorage.app",
    messagingSenderId: "594664276586",
    appId: "1:594664276586:web:6d238ce62a92b972630013",
    measurementId: "G-N3ZRZW2RJN"
};

// Khởi tạo Firebase
if (Object.keys(firebaseConfig).length === 0) {
    console.warn("⚠️ BẠN CHƯA ĐIỀN FIREBASE CONFIG. Vui lòng mở file app.js và dán mã cấu hình Firebase vào biến firebaseConfig.");
} else {
    firebase.initializeApp(firebaseConfig);
}
const db = typeof firebase !== 'undefined' && firebase.apps.length > 0 ? firebase.database() : null;

// --- Mock Data & Configuration (Dữ liệu mặc định nếu Firebase trống) ---
// Mảng sản phẩm mặc định đã được xóa vì ứng dụng load 100% từ Firebase.

// --- App State ---
const appState = {
    currentUser: null,
    cartItem: null,
    orders: [], // user's purchases
    otpHistory: [], // user's otp history
    depositHistory: [], // user's deposit history
    allOrders: [], // all purchases (admin only)
    allDeposits: [], // all deposits (admin only)
    allUsers: [], // all users (admin only)
    products: [], // dynamic products from Firebase
    productInventory: {}, // admin-only inventory snapshot
    productCategories: [], // product groups managed by admin
    providerSources: [], // metadata only; API keys never leave Netlify backend
    notifications: [], // system notifications
    events: { discountPercent: 0, depositBonusPercent: 0 },
    banners: [],
    maintenanceSettings: { mode: 'off', zalo: '', facebook: '', telegram: '', email: '', message: '' },
    telegramBots: []
};

// --- Core Application Logic ---
const app = {
    DEFAULT_PRODUCT_CATEGORIES: [
        { id: 'entertainment', name: 'Giải trí', order: 10 },
        { id: 'office', name: 'Văn phòng', order: 20 },
        { id: 'design', name: 'Thiết kế', order: 30 },
        { id: 'ai', name: 'AI - Công cụ', order: 40 },
        { id: 'other', name: 'Khác', order: 90 }
    ],
    productSort: 'default',
    productSourceFilter: 'all',
    productCategoryFilter: 'all',
    DEPOSIT_EXPIRE_MS: 15 * 60 * 1000,
    depositCountdownTimer: null,
    adminFilters: {
        ordersQuery: '',
        ordersStatus: 'all',
        depositsQuery: '',
        productsQuery: '',
        productStock: 'all',
        productCategory: 'all',
        usersQuery: ''
    },
    providerAdminState: {
        configured: false,
        demoMode: false,
        demoInitialized: false,
        providers: [],
        editingId: '',
        productsByProvider: {}
    },

    init: function () {
        const demoQuery = new URLSearchParams(window.location.search).get('provider_demo');
        const localPreview = window.location.protocol === 'file:'
            || ['127.0.0.1', 'localhost'].includes(String(window.location.hostname || '').toLowerCase());
        this.providerAdminState.demoMode = localPreview && demoQuery === '1';
        if (this.providerAdminState.demoMode) {
            this.appState.currentUser = { username: 'admin', sessionVersion: 0, demoPreview: true };
        } else {
            this.checkAuth(); // Must run before listenToSettings so isAdmin check works on first Firebase callback
            this.listenToSettings();
            this.listenToProductCategories();
            this.listenToProducts();
            this.listenToNotifications();
            this.loadOTPConfigFromFirebase();
            this.loadSelectedAppsFromFirebase();
        }

        // Theo dõi sự kiện back/forward của trình duyệt
        window.addEventListener('popstate', (event) => {
            if (event.state && event.state.view) {
                this.navigate(event.state.view, false);
            } else {
                this.handleInitialRoute();
            }
        });

        // Xử lý route lần đầu truy cập
        this.handleInitialRoute();
        if (this.providerAdminState.demoMode) {
            setTimeout(() => this.openProviderDemoPreview(), 0);
        }

        if (!db) {
            setTimeout(() => {
                this.showToast("Cảnh báo: Bạn chưa cấu hình Firebase. Web có thể không hoạt động!", 'warning');
            }, 1000);
        }

        if (typeof emailjs !== 'undefined') {
            emailjs.init("GTUP-6T6SnqE7E5EA");
        }

        // Initialize Theme
        const savedTheme = localStorage.getItem('accstore_theme');
        if (savedTheme !== 'dark') {
            document.body.classList.add('light-theme');
            const icon = document.querySelector('#theme-toggle-btn i');
            if (icon) { icon.classList.remove('fa-moon'); icon.classList.add('fa-sun'); }
        }
        this.initScrollReveal();
        this.initTiltEffects();
        this.initAmbientNetwork();
        this.initProductEdgeEffects();
        this.initLogoMotion();
        this.initButtonMotion();
        this.restoreSiteWarningState();
        window.addEventListener('pointerdown', () => this.unlockNotificationSound(), { once: true });
        window.addEventListener('keydown', () => this.unlockNotificationSound(), { once: true });
        document.addEventListener('click', event => {
            if (!event.target.closest('.header-container')) this.closeMobileUtilityMenu();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') this.closeMobileUtilityMenu();
        });
    },

    initAmbientNetwork: function () {
        const canvas = document.getElementById('ambient-network-canvas');
        if (!canvas || this._ambientNetwork) return;
        const context = canvas.getContext('2d', { alpha: true });
        if (!context) return;

        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches;
        const state = {
            width: 0,
            height: 0,
            dpr: 1,
            nodes: [],
            edges: [],
            pulses: [],
            pointer: { x: -9999, y: -9999, active: false },
            lastFrame: 0,
            frameInterval: coarsePointer ? 50 : 33,
            resizeTimer: null,
            scrollEnergy: 0,
            lastScrollY: window.scrollY || 0
        };

        const buildNetwork = () => {
            const spacing = state.width < 700 ? 132 : 112;
            const columns = Math.ceil(state.width / spacing) + 1;
            const rows = Math.ceil(state.height / spacing) + 1;
            const nodes = [];
            const edges = [];

            for (let row = 0; row < rows; row += 1) {
                for (let column = 0; column < columns; column += 1) {
                    const seed = (row + 1) * 97 + (column + 1) * 53;
                    nodes.push({
                        x: column * spacing + Math.sin(seed) * 22,
                        y: row * spacing + Math.cos(seed * 1.7) * 18,
                        phase: (seed % 37) / 37 * Math.PI * 2
                    });
                    const index = row * columns + column;
                    if (column > 0) edges.push([index - 1, index]);
                    if (row > 0) edges.push([index - columns, index]);
                    if (row > 0 && column > 0 && seed % 5 === 0) {
                        edges.push([index - columns - 1, index]);
                    }
                }
            }

            const pulseCount = reduceMotion ? 0 : Math.max(5, Math.min(18, Math.floor(state.width / 105)));
            state.nodes = nodes;
            state.edges = edges;
            state.pulses = Array.from({ length: pulseCount }, (_, index) => ({
                edgeIndex: (index * 17 + 5) % Math.max(1, edges.length),
                progress: (index * 0.173) % 1,
                speed: (coarsePointer ? 0.00016 : 0.00022) + (index % 4) * 0.00004
            }));
        };

        const resize = () => {
            state.width = window.innerWidth;
            state.height = window.innerHeight;
            state.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
            canvas.width = Math.round(state.width * state.dpr);
            canvas.height = Math.round(state.height * state.dpr);
            canvas.style.width = `${state.width}px`;
            canvas.style.height = `${state.height}px`;
            context.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
            buildNetwork();
        };

        const getNodePosition = (node, time) => {
            const motion = reduceMotion ? 0 : (coarsePointer ? 1.1 : 2.2);
            return {
                x: node.x + Math.sin(time * 0.00022 + node.phase) * motion,
                y: node.y + Math.cos(time * 0.00018 + node.phase) * motion
            };
        };

        const draw = (time = 0) => {
            if (!reduceMotion) requestAnimationFrame(draw);
            if (document.hidden || time - state.lastFrame < state.frameInterval) return;
            state.lastFrame = time;
            context.clearRect(0, 0, state.width, state.height);

            const isLight = document.body.classList.contains('light-theme');
            const baseLine = isLight ? [51, 65, 85] : [91, 111, 174];
            const activeLine = isLight ? [16, 132, 151] : [34, 211, 190];
            const positions = state.nodes.map(node => getNodePosition(node, time));
            state.scrollEnergy *= coarsePointer ? 0.88 : 0.91;
            const scrollBoost = 1 + state.scrollEnergy * 3.2;

            state.edges.forEach(([fromIndex, toIndex]) => {
                const from = positions[fromIndex];
                const to = positions[toIndex];
                if (!from || !to) return;
                const midX = (from.x + to.x) / 2;
                const midY = (from.y + to.y) / 2;
                const distance = state.pointer.active
                    ? Math.hypot(midX - state.pointer.x, midY - state.pointer.y)
                    : 9999;
                const influence = Math.max(0, 1 - distance / 190);
                const color = influence > 0 ? activeLine : baseLine;
                const alpha = (isLight ? 0.055 : 0.075)
                    + influence * (isLight ? 0.16 : 0.21)
                    + state.scrollEnergy * (isLight ? 0.025 : 0.035);
                context.beginPath();
                context.moveTo(from.x, from.y);
                context.lineTo(to.x, to.y);
                context.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
                context.lineWidth = influence > 0.45 ? 1.2 : 0.7;
                context.stroke();
            });

            state.nodes.forEach((node, index) => {
                const point = positions[index];
                const distance = state.pointer.active
                    ? Math.hypot(point.x - state.pointer.x, point.y - state.pointer.y)
                    : 9999;
                const influence = Math.max(0, 1 - distance / 170);
                const size = 1.4 + influence * 2;
                context.fillStyle = isLight
                    ? `rgba(28,63,94,${0.11 + influence * 0.35})`
                    : `rgba(97,133,205,${0.16 + influence * 0.48})`;
                context.fillRect(point.x - size / 2, point.y - size / 2, size, size);
            });

            state.pulses.forEach(pulse => {
                const edge = state.edges[pulse.edgeIndex];
                if (!edge) return;
                pulse.progress += pulse.speed * state.frameInterval * scrollBoost;
                if (pulse.progress >= 1) {
                    pulse.progress = 0;
                    pulse.edgeIndex = (pulse.edgeIndex + 19) % state.edges.length;
                }
                const from = positions[edge[0]];
                const to = positions[edge[1]];
                const x = from.x + (to.x - from.x) * pulse.progress;
                const y = from.y + (to.y - from.y) * pulse.progress;
                context.fillStyle = isLight ? 'rgba(6,148,162,.55)' : 'rgba(35,229,207,.72)';
                context.fillRect(x - 1.4, y - 1.4, 2.8, 2.8);
            });
        };

        const handlePointerMove = event => {
            state.pointer.x = event.clientX;
            state.pointer.y = event.clientY;
            state.pointer.active = true;
        };
        const handlePointerLeave = () => { state.pointer.active = false; };
        const handleResize = () => {
            clearTimeout(state.resizeTimer);
            state.resizeTimer = setTimeout(resize, 120);
        };
        const handleScroll = () => {
            const currentY = window.scrollY || 0;
            const delta = Math.abs(currentY - state.lastScrollY);
            state.lastScrollY = currentY;
            state.scrollEnergy = Math.min(1, state.scrollEnergy + delta / 170);
        };

        if (!coarsePointer && !reduceMotion) {
            window.addEventListener('pointermove', handlePointerMove, { passive: true });
            document.documentElement.addEventListener('pointerleave', handlePointerLeave);
        }
        window.addEventListener('resize', handleResize, { passive: true });
        if (!reduceMotion) window.addEventListener('scroll', handleScroll, { passive: true });
        resize();
        this._ambientNetwork = state;
        if (reduceMotion) draw(performance.now());
        else requestAnimationFrame(draw);
    },

    initProductEdgeEffects: function () {
        if (this._productEdgeEffectsReady) return;
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
            || window.matchMedia?.('(pointer: coarse)').matches) return;
        this._productEdgeEffectsReady = true;
        let activeCard = null;

        document.addEventListener('pointermove', event => {
            const card = event.target.closest?.('.product-card:not(.product-card-skeleton)');
            if (!card) {
                if (activeCard) activeCard.classList.remove('is-edge-active');
                activeCard = null;
                return;
            }
            if (activeCard && activeCard !== card) activeCard.classList.remove('is-edge-active');
            activeCard = card;
            const rect = card.getBoundingClientRect();
            card.style.setProperty('--edge-x', `${Math.max(0, Math.min(rect.width, event.clientX - rect.left))}px`);
            card.style.setProperty('--edge-y', `${Math.max(0, Math.min(rect.height, event.clientY - rect.top))}px`);
            card.classList.add('is-edge-active');
        }, { passive: true });

        document.addEventListener('pointerleave', () => {
            if (activeCard) activeCard.classList.remove('is-edge-active');
            activeCard = null;
        });
    },

    initLogoMotion: function () {
        if (this._logoMotionReady) return;
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
            || window.matchMedia?.('(pointer: coarse)').matches) return;
        this._logoMotionReady = true;

        document.querySelectorAll('.logo').forEach(logo => {
            logo.addEventListener('pointermove', event => {
                const rect = logo.getBoundingClientRect();
                const x = (event.clientX - rect.left) / Math.max(1, rect.width);
                const y = (event.clientY - rect.top) / Math.max(1, rect.height);
                logo.style.setProperty('--logo-rotate-y', `${(x - 0.5) * 5}deg`);
                logo.style.setProperty('--logo-rotate-x', `${(0.5 - y) * 4}deg`);
                logo.style.setProperty('--logo-glint-x', `${x * 100}%`);
                logo.classList.add('is-logo-active');
            }, { passive: true });
            logo.addEventListener('pointerleave', () => {
                logo.style.setProperty('--logo-rotate-y', '0deg');
                logo.style.setProperty('--logo-rotate-x', '0deg');
                logo.classList.remove('is-logo-active');
            });
        });
    },

    initButtonMotion: function () {
        if (this._buttonMotionReady) return;
        this._buttonMotionReady = true;
        let pressed = null;
        const findAction = target => target?.closest?.(
            'button, .btn-primary, .btn-outline, .btn-large, .order-account-action'
        );
        const release = () => {
            if (!pressed) return;
            const button = pressed;
            pressed = null;
            button.classList.remove('motion-pressing');
            button.classList.add('motion-released');
            setTimeout(() => button.classList.remove('motion-released'), 260);
        };

        document.addEventListener('pointerdown', event => {
            const button = findAction(event.target);
            if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
            if (pressed && pressed !== button) pressed.classList.remove('motion-pressing');
            pressed = button;
            button.classList.add('motion-pressing');
        }, { passive: true });
        document.addEventListener('pointerup', release, { passive: true });
        document.addEventListener('pointercancel', release, { passive: true });
        window.addEventListener('blur', release);
    },

    initScrollReveal: function () {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const selector = '.section-header, .product-search-bar, .dashboard-content, .payment-info, .admin-stat-card';
        const reveal = () => {
            const items = document.querySelectorAll(selector);
            items.forEach((el, index) => {
                if (!el.classList.contains('reveal-on-scroll')) {
                    el.classList.add('reveal-on-scroll');
                    el.style.setProperty('--reveal-delay', `${Math.min(index % 8, 7) * 45}ms`);
                }
            });
        };
        reveal();
        if (this._revealObserver) this._revealObserver.disconnect();
        this._revealObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('is-visible');
                    this._revealObserver.unobserve(entry.target);
                }
            });
        }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
        document.querySelectorAll('.reveal-on-scroll').forEach(el => this._revealObserver.observe(el));
    },

    initTiltEffects: function (root = document) {
        if (typeof VanillaTilt === 'undefined') return;
        if (window.matchMedia && (
            window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
            window.matchMedia('(pointer: coarse)').matches
        )) return;

        const init = (selector, options) => {
            root.querySelectorAll(selector).forEach(el => {
                if (el.vanillaTilt) return;
                VanillaTilt.init(el, options);
            });
        };

        init('.product-card:not(.product-card-skeleton)', {
            max: 7,
            speed: 650,
            glare: true,
            'max-glare': 0.16,
            scale: 1.015,
            perspective: 1000
        });

        init('.otp-app-card', {
            max: 9,
            speed: 600,
            glare: true,
            'max-glare': 0.12,
            scale: 1.02,
            perspective: 900
        });

        init('.qr-tilt-card', {
            max: 5,
            speed: 700,
            glare: true,
            'max-glare': 0.18,
            scale: 1.01,
            perspective: 1100
        });
    },

    toggleTheme: function () {
        document.body.classList.toggle('light-theme');
        const isLight = document.body.classList.contains('light-theme');
        localStorage.setItem('accstore_theme', isLight ? 'light' : 'dark');

        const icon = document.querySelector('#theme-toggle-btn i');
        if (icon) {
            if (isLight) {
                icon.classList.remove('fa-moon');
                icon.classList.add('fa-sun');
            } else {
                icon.classList.remove('fa-sun');
                icon.classList.add('fa-moon');
            }
        }
    },

    toggleMobileUtilityMenu: function () {
        const menu = document.getElementById('header-actions');
        const button = document.getElementById('mobile-utility-toggle');
        if (!menu || !button) return;
        const isOpen = menu.classList.toggle('mobile-open');
        button.classList.toggle('active', isOpen);
        button.setAttribute('aria-expanded', String(isOpen));
        button.setAttribute('aria-label', isOpen ? 'Đóng menu tiện ích' : 'Mở menu tiện ích');
        const icon = button.querySelector('i');
        if (icon) icon.className = isOpen ? 'fas fa-times' : 'fas fa-bars';
    },

    closeMobileUtilityMenu: function () {
        const menu = document.getElementById('header-actions');
        const button = document.getElementById('mobile-utility-toggle');
        if (menu) menu.classList.remove('mobile-open');
        if (button) {
            button.classList.remove('active');
            button.setAttribute('aria-expanded', 'false');
            button.setAttribute('aria-label', 'Mở menu tiện ích');
            const icon = button.querySelector('i');
            if (icon) icon.className = 'fas fa-bars';
        }
    },

    closeMobileMenu: function () {
        this.closeMobileUtilityMenu();
    },

    updateMobileBottomNav: function (activeKey) {
        const normalizedKey = activeKey === 'dashboard' ? 'orders' : activeKey;
        document.querySelectorAll('[data-mobile-nav]').forEach(button => {
            button.classList.toggle('active', button.dataset.mobileNav === normalizedKey);
        });
    },

    mobileNavigate: function (target) {
        const requiresUser = ['otp', 'orders', 'account'];
        if (requiresUser.includes(target) && !this.appState.currentUser) {
            this.navigate('login');
            return;
        }

        if (target === 'products') {
            this.navigate('home');
            this.updateMobileBottomNav('products');
            requestAnimationFrame(() => {
                document.getElementById('products-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            return;
        }

        if (target === 'orders' || target === 'account') {
            this.navigate('dashboard');
            this.updateMobileBottomNav(target);
            requestAnimationFrame(() => {
                const sectionId = target === 'orders' ? 'section-orders' : 'section-settings';
                document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            return;
        }

        this.navigate(target);
        this.updateMobileBottomNav(target);
    },

    restoreSiteWarningState: function () {
        const savedState = sessionStorage.getItem('site_warning_collapsed');
        const isMobile = window.matchMedia && window.matchMedia('(max-width: 600px)').matches;
        const isCollapsed = isMobile ? false : savedState === '1';
        this.setSiteWarningCollapsed(isCollapsed);
    },

    setSiteWarningCollapsed: function (isCollapsed) {
        const ticker = document.querySelector('.site-warning-ticker');
        const button = ticker?.querySelector('.site-warning-toggle');
        if (!ticker || !button) return;
        ticker.classList.toggle('is-collapsed', isCollapsed);
        document.body.classList.toggle('warning-collapsed', isCollapsed);
        button.setAttribute('aria-expanded', String(!isCollapsed));
        button.setAttribute('aria-label', isCollapsed ? 'Mở cảnh báo sử dụng' : 'Thu gọn cảnh báo');
        button.title = isCollapsed ? 'Mở cảnh báo sử dụng' : 'Thu gọn cảnh báo';
        const icon = button.querySelector('i');
        if (icon) icon.className = isCollapsed ? 'fas fa-triangle-exclamation' : 'fas fa-chevron-down';
    },

    toggleSiteWarning: function () {
        const ticker = document.querySelector('.site-warning-ticker');
        if (!ticker) return;
        if (window.matchMedia && window.matchMedia('(max-width: 600px)').matches) {
            sessionStorage.removeItem('site_warning_collapsed');
            this.setSiteWarningCollapsed(false);
            return;
        }
        const isCollapsed = !ticker.classList.contains('is-collapsed');
        sessionStorage.setItem('site_warning_collapsed', isCollapsed ? '1' : '0');
        this.setSiteWarningCollapsed(isCollapsed);
    },

    // === Admin Tabs ===
    switchAdminTab: function (tabId, btnEl) {
        document.querySelectorAll('.admin-tab-panel').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
        const panel = document.getElementById('admin-tab-' + tabId);
        if (panel) panel.classList.add('active');
        if (btnEl) btnEl.classList.add('active');
        const mobileSelect = document.getElementById('admin-mobile-tab-select');
        if (mobileSelect && mobileSelect.value !== tabId) mobileSelect.value = tabId;
        if (btnEl && window.matchMedia('(max-width: 600px)').matches) {
            requestAnimationFrame(() => btnEl.scrollIntoView({
                behavior: 'smooth',
                block: 'nearest',
                inline: 'center'
            }));
        }
        // Render chart khi mở tab overview
        if (tabId === 'overview') this.renderAdminChart();
        if (tabId === 'inventory') this.renderAdminInventoryCenter();
        if (tabId === 'providers') this.loadProviderVault();
        if (tabId === 'settings') {
            this.loadOTPConfigStatus();
            this.loadPriceConfig();
            this.loadBotStatus();
            this.renderAdminMaintenanceSettings();
            // Populate select immediately (no Firebase wait needed — fixedApps is hardcoded)
            this.adminPopulateOTPNoteSelect();
            try { this.adminRenderOTPNotesSummary(); } catch(e) { console.warn('OTP notes render error:', e); }
            // Refresh note indicators after Firebase responds
            if (db) {
                db.ref('otp_app_notes').once('value').then(snap => {
                    const raw = snap.val() || {};
                    // Normalize: convert any non-string values to empty string
                    const cleaned = {};
                    Object.keys(raw).forEach(k => {
                        cleaned[k] = typeof raw[k] === 'string' ? raw[k] : '';
                    });
                    this.otpState.appNotes = cleaned;
                    this.adminPopulateOTPNoteSelect();
                    try { this.adminRenderOTPNotesSummary(); } catch(e) { console.warn('OTP notes render error:', e); }
                });
            }
        }
    },

    // === Admin Stats Cards ===
    renderAdminStats: function () {
        const today = new Date().toLocaleDateString('vi-VN');
        const DONE = ['Hoàn thành', 'Đã duyệt (Auto SePay)', 'Đã duyệt'];

        // Today revenue
        let todayRev = 0;
        this.appState.allDeposits.forEach(d => {
            if (!d.timestamp) return;
            if (DONE.some(s => (d.status || '').includes(s))) {
                if (new Date(Number(d.timestamp)).toLocaleDateString('vi-VN') === today) {
                    todayRev += parseInt(d.amount || 0);
                }
            }
        });

        const pendingOrders = this.appState.allOrders.filter(o => {
            const status = this.normalizeText(o.status || '');
            return status.includes('cho duyet') || status.includes('dang');
        }).length;
        const pendingDeps = this.appState.allDeposits.filter(d => d.status === 'Chờ duyệt').length;
        const totalUsers = this.appState.allUsers.length;

        const el = id => document.getElementById(id);
        if (el('stat-today-revenue')) el('stat-today-revenue').innerText = this.formatMoney(todayRev);
        if (el('stat-pending-orders')) el('stat-pending-orders').innerText = pendingOrders;
        if (el('stat-pending-deposits')) el('stat-pending-deposits').innerText = pendingDeps;
        if (el('stat-total-users')) el('stat-total-users').innerText = totalUsers;

        // Update tab badges
        if (el('tab-badge-orders')) el('tab-badge-orders').innerText = pendingOrders;
        if (el('tab-badge-deposits')) el('tab-badge-deposits').innerText = pendingDeps;
    },

    renderAdminFilterControls: function () {
        const ensure = (anchorId, id, html) => {
            const anchor = document.getElementById(anchorId);
            if (!anchor || document.getElementById(id)) return;
            const wrap = anchor.closest('.table-responsive') || anchor.parentElement;
            wrap.insertAdjacentHTML('afterbegin', html);
        };

        ensure('admin-orders-list', 'admin-orders-filter', `
            <div class="admin-filter-bar" id="admin-orders-filter">
                <div class="admin-filter-input-wrap"><i class="fas fa-search"></i><input type="text" placeholder="Tìm mã đơn, khách hàng, sản phẩm..." oninput="app.setAdminFilter('ordersQuery', this.value)"></div>
                <select onchange="app.setAdminFilter('ordersStatus', this.value)">
                    <option value="all">Tất cả trạng thái</option>
                    <option value="pending">Đang chờ/giao</option>
                    <option value="completed">Hoàn thành</option>
                    <option value="refunded">Hoàn tiền</option>
                </select>
            </div>
        `);

        ensure('admin-deposits-list', 'admin-deposits-filter', `
            <div class="admin-filter-bar" id="admin-deposits-filter">
                <div class="admin-filter-input-wrap"><i class="fas fa-search"></i><input type="text" placeholder="Tìm mã nạp hoặc khách hàng..." oninput="app.setAdminFilter('depositsQuery', this.value)"></div>
            </div>
        `);

        ensure('admin-products-list', 'admin-products-filter', `
            <div class="admin-filter-bar" id="admin-products-filter">
                <div class="admin-filter-input-wrap"><i class="fas fa-search"></i><input type="text" placeholder="Tìm tên, thời hạn, ghi chú..." oninput="app.setAdminFilter('productsQuery', this.value)"></div>
                <select id="admin-products-category-filter" onchange="app.setAdminFilter('productCategory', this.value)">
                    <option value="all">Tất cả nhóm</option>
                </select>
                <select onchange="app.setAdminFilter('productStock', this.value)">
                    <option value="all">Tất cả kho</option>
                    <option value="in">Còn hàng</option>
                    <option value="out">Hết hàng</option>
                </select>
            </div>
        `);
        this.populateAdminCategoryFilter();

        ensure('admin-users-list', 'admin-users-filter', `
            <div class="admin-filter-bar" id="admin-users-filter">
                <div class="admin-filter-input-wrap"><i class="fas fa-search"></i><input type="text" placeholder="Tìm username hoặc email..." oninput="app.setAdminFilter('usersQuery', this.value)"></div>
            </div>
        `);
    },

    setAdminFilter: function (key, value) {
        this.adminFilters[key] = value;
        if (key.includes('orders')) this._pages['admin-orders'] = 1;
        if (key.includes('deposits')) this._pages['admin-deposits'] = 1;
        if (key.includes('products')) this._pages['admin-products'] = 1;
        if (key.includes('users')) this._pages['admin-users'] = 1;
        this.renderAdmin();
    },

    filterAdminOrders: function () {
        const q = this.normalizeText(this.adminFilters.ordersQuery);
        const status = this.adminFilters.ordersStatus;
        return this.appState.allOrders.filter(o => {
            const text = this.normalizeText(`${o.id} ${o.username} ${o.productName} ${this.getOrderDurationText(o)} ${this.formatMoney(o.price || 0)} ${o.status}`);
            const normalizedStatus = this.normalizeText(o.status || '');
            const isPending = normalizedStatus.includes('cho duyet') || normalizedStatus.includes('dang');
            const isRefunded = this.normalizeText(o.status).includes('hoan tien');
            const statusOk = status === 'all'
                || (status === 'pending' && isPending)
                || (status === 'completed' && !isPending && !isRefunded)
                || (status === 'refunded' && isRefunded);
            return (!q || text.includes(q)) && statusOk;
        });
    },

    filterAdminDeposits: function (rows) {
        const q = this.normalizeText(this.adminFilters.depositsQuery);
        return rows.filter(d => !q || this.normalizeText(`${d.memo} ${d.username} ${d.amount} ${d.status}`).includes(q));
    },

    filterAdminProducts: function () {
        const q = this.normalizeText(this.adminFilters.productsQuery);
        const stock = this.adminFilters.productStock;
        const category = this.adminFilters.productCategory;
        return this.appState.products.filter(p => {
            const stockOk = stock === 'all' || (stock === 'in' ? Number(p.quantity || 0) > 0 : Number(p.quantity || 0) <= 0);
            const productCategory = this.getProductCategory(p);
            const categoryName = this.getProductCategoryName(productCategory);
            const categoryOk = category === 'all' || productCategory === category;
            const text = this.normalizeText(`${p.name} ${p.duration} ${p.desc} ${p.format} ${categoryName}`);
            return stockOk && categoryOk && (!q || text.includes(q));
        });
    },

    filterAdminUsers: function () {
        const q = this.normalizeText(this.adminFilters.usersQuery);
        return this.appState.allUsers.filter(u => !q || this.normalizeText(`${u.username} ${u.email}`).includes(q));
    },

    // === Dashboard Sidebar Scroll ===
    scrollDashSection: function (sectionId, btnEl) {
        document.querySelectorAll('.dash-nav-item').forEach(b => b.classList.remove('active'));
        if (btnEl) btnEl.classList.add('active');
        const target = document.getElementById(sectionId);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    // === Pagination Utility ===
    _pages: {},
    PAGE_SIZE: 10,

    // Renders rows for a given page and draws the pagination bar
    // tbodyId: ID of the <tbody>
    // key: unique key for tracking page state
    // rows: array of data
    // renderRowFn: function(item) => HTMLElement (tr)
    // pagBarId: ID of pagination bar container
    renderPaginatedTable: function (tbodyId, key, rows, renderRowFn, pagBarId) {
        if (!this._pages[key]) this._pages[key] = 1;
        const pageSize = this.PAGE_SIZE;
        const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
        // Clamp current page
        if (this._pages[key] > totalPages) this._pages[key] = totalPages;
        const currentPage = this._pages[key];

        const start = (currentPage - 1) * pageSize;
        const pageRows = rows.slice(start, start + pageSize);

        const tbody = document.getElementById(tbodyId);
        if (!tbody) return;
        tbody.innerHTML = '';
        pageRows.forEach((item, i) => {
            const el = renderRowFn(item, start + i + 1);
            if (el) tbody.appendChild(el);
        });

        // Render pagination bar
        const barContainer = document.getElementById(pagBarId);
        if (!barContainer) return;
        barContainer.innerHTML = '';
        if (totalPages <= 1) return;

        const bar = document.createElement('div');
        bar.className = 'pagination-bar';

        const info = document.createElement('span');
        info.className = 'pg-info';
        info.textContent = `${start + 1}–${Math.min(start + pageSize, rows.length)} / ${rows.length}`;
        bar.appendChild(info);

        // Prev button
        const prev = document.createElement('button');
        prev.className = 'pg-btn';
        prev.innerHTML = '<i class="fas fa-chevron-left"></i>';
        prev.disabled = currentPage === 1;
        prev.onclick = () => { this._pages[key] = currentPage - 1; this.renderPaginatedTable(tbodyId, key, rows, renderRowFn, pagBarId); };
        bar.appendChild(prev);

        // Page buttons (show max 5 around current)
        const startPg = Math.max(1, currentPage - 2);
        const endPg = Math.min(totalPages, startPg + 4);
        for (let p = startPg; p <= endPg; p++) {
            const btn = document.createElement('button');
            btn.className = 'pg-btn' + (p === currentPage ? ' active' : '');
            btn.textContent = p;
            const pg = p;
            btn.onclick = () => { this._pages[key] = pg; this.renderPaginatedTable(tbodyId, key, rows, renderRowFn, pagBarId); };
            bar.appendChild(btn);
        }

        // Next button
        const next = document.createElement('button');
        next.className = 'pg-btn';
        next.innerHTML = '<i class="fas fa-chevron-right"></i>';
        next.disabled = currentPage === totalPages;
        next.onclick = () => { this._pages[key] = currentPage + 1; this.renderPaginatedTable(tbodyId, key, rows, renderRowFn, pagBarId); };
        bar.appendChild(next);

        barContainer.appendChild(bar);
    },

    handleInitialRoute: function () {
        // Nếu mở file cục bộ trên máy tính (không phải http) thì bỏ qua
        if (window.location.protocol === 'file:') {
            this.navigate('home', false);
            return;
        }

        const path = window.location.pathname.replace(/\/$/, ""); // Xóa dấu '/' ở cuối
        if (path === '/bank' || path === '/deposit') {
            this.navigate('deposit', false);
        } else if (path === '/otp') {
            this.navigate('otp', false);
        } else if (path === '/dashboard') {
            this.navigate('dashboard', false);
        } else if (path === '/admin') {
            this.navigate('admin', false);
        } else if (path === '/checkout') {
            this.navigate('checkout', false);
        } else if (path === '/login') {
            this.navigate('login', false);
        } else if (path === '/register') {
            this.navigate('register', false);
        } else if (path === '/forgot') {
            this.navigate('forgot', false);
        } else {
            this.navigate('home', false);
        }
    },

    formatMoney: function (amount) {
        return Number(amount || 0).toLocaleString('vi-VN') + 'đ';
    },

    escapeHtml: function (value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[ch]));
    },

    normalizeVietnamPhone: function (value) {
        const original = String(value ?? '').trim();
        if (!original) return '';

        let digits = original.replace(/\D/g, '');
        if (digits.startsWith('0084')) digits = digits.substring(2);
        if (digits.startsWith('84') && digits.length >= 11) {
            digits = '0' + digits.substring(2);
        } else if (!digits.startsWith('0') && digits.length === 9 && /^[35789]/.test(digits)) {
            digits = '0' + digits;
        }

        return digits;
    },

    getOTPPhoneNumber: function (phoneInfo) {
        const preferredKeys = ['Number', 'number', 'Phone', 'phone', 'PhoneNumber', 'phoneNumber', 'mobile', 'Mobile', 'tel', 'Tel'];
        const candidates = [];

        preferredKeys.forEach(key => {
            if (phoneInfo && phoneInfo[key] !== undefined && phoneInfo[key] !== null) {
                candidates.push(phoneInfo[key]);
            }
        });

        const preferredPhone = candidates
            .map(candidate => this.normalizeVietnamPhone(candidate))
            .find(phone => this.isValidVietnamPhone(phone));
        if (preferredPhone) return preferredPhone;

        const collect = (value, depth = 0) => {
            if (value === undefined || value === null || depth > 2) return;
            if (typeof value === 'string' || typeof value === 'number') {
                const chunks = String(value).match(/(?:\+?84|0)?[ .-]?\d(?:[\d .-]{6,14}\d)?/g) || [];
                chunks.forEach(chunk => candidates.push(chunk));
                return;
            }
            if (typeof value === 'object') {
                Object.values(value).forEach(v => collect(v, depth + 1));
            }
        };
        collect(phoneInfo);

        const normalized = candidates
            .map(candidate => this.normalizeVietnamPhone(candidate))
            .filter(phone => this.isValidVietnamPhone(phone))
            .sort((a, b) => {
                const aScore = (a.startsWith('0') && a.length === 10 ? 100 : 0) + a.length;
                const bScore = (b.startsWith('0') && b.length === 10 ? 100 : 0) + b.length;
                return bScore - aScore;
            });

        return normalized[0] || this.normalizeVietnamPhone(phoneInfo && phoneInfo.Number);
    },

    isValidVietnamPhone: function (phone) {
        return /^0[35789]\d{8}$/.test(String(phone || ''));
    },

    // Chuyển về dạng 9 chữ số (bỏ số 0 đầu) để gọi API &phone= như bot to_api_phone()
    toApiPhone: function (phone) {
        let digits = String(phone || '').replace(/\D/g, '');
        if (digits.startsWith('0084')) digits = digits.substring(2);
        if (digits.startsWith('84') && digits.length >= 11) digits = digits.substring(2);
        if (digits.startsWith('0') && digits.length === 10) digits = digits.substring(1);
        return digits;
    },

    unlockNotificationSound: function () {
        if (this.notificationSoundReady) return;
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        this.notificationAudioContext = this.notificationAudioContext || new AudioContext();
        if (this.notificationAudioContext.state === 'suspended') {
            this.notificationAudioContext.resume().catch(() => {});
        }
        this.notificationSoundReady = true;
    },

    playChatRing: function () {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;

        const ctx = this.notificationAudioContext || new AudioContext();
        this.notificationAudioContext = ctx;
        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
            return;
        }

        const now = ctx.currentTime;
        [0, 0.18].forEach(offset => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, now + offset);
            osc.frequency.exponentialRampToValueAtTime(1320, now + offset + 0.08);
            gain.gain.setValueAtTime(0.0001, now + offset);
            gain.gain.exponentialRampToValueAtTime(0.16, now + offset + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.16);
            osc.connect(gain).connect(ctx.destination);
            osc.start(now + offset);
            osc.stop(now + offset + 0.18);
        });
    },

    normalizeText: function (value) {
        return String(value ?? '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/g, 'd')
            .replace(/Đ/g, 'D')
            .toLowerCase();
    },

    navigate: function (viewId, pushState = true) {
        // Đảm bảo đóng mobile menu trước khi điều hướng
        this.closeMobileMenu();

        const _navUser = this.appState.currentUser || (() => { try { return JSON.parse(localStorage.getItem('accstore_user') || 'null'); } catch(e) { return null; } })();
        const isAdmin = _navUser && _navUser.username && _navUser.username.trim().toLowerCase() === 'admin';
        const mode = appState.maintenanceSettings.mode;

        // Full maintenance: redirect non-admin to maintenance page
        // Allow login/register so admin can log back in if accidentally logged out
        const bypassMaint = ['maintenance', 'login', 'register'];
        if (mode === 'full' && !isAdmin && !bypassMaint.includes(viewId)) {
            return this._showView('maintenance', pushState);
        }

        // Account-only hidden: block checkout and buying
        if (mode === 'account_only' && !isAdmin && viewId === 'checkout') {
            this.showToast("Dịch vụ tài khoản tạm ngừng, vui lòng quay lại sau.", 'warning');
            return this._showView('home', false);
        }

        const requiresAuth = ['dashboard', 'otp', 'deposit', 'checkout', 'admin'];
        if (requiresAuth.includes(viewId) && !this.appState.currentUser) {
            this.showToast("Vui lòng đăng nhập để tiếp tục!", 'warning');
            return this.navigate('login', false);
        }


        if (viewId === 'admin' && (!this.appState.currentUser || this.appState.currentUser.username.trim().toLowerCase() !== 'admin')) {
            this.showToast("Bạn không có quyền truy cập trang này!");
            return this.navigate('home', false);
        }

        if (viewId === 'checkout' && !this.appState.cartItem) {
            return this.navigate('home', false);
        }

        if (viewId === 'notifications') {
            if (this.appState.currentUser) {
                localStorage.setItem('lastReadNotif_' + this.appState.currentUser.username, Date.now());
                const badge = document.getElementById('nav-notification-badge');
                if (badge) badge.classList.add('hidden');
            }
        }

        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('active', 'flow-enter', 'flow-exit');
        });
        const target = document.getElementById(`view-${viewId}`);
        if (target) target.classList.add('active');
        document.body.dataset.activeView = viewId;

        if (viewId === 'dashboard') this.renderDashboard();
        if (viewId === 'admin') this.renderAdmin();
        if (viewId === 'otp') this.loadOTPApps();
        if (viewId === 'checkout' && this.appState.cartItem) this.setupCheckout(this.appState.cartItem);
        if (viewId === 'maintenance') this.renderMaintenancePage();
        if (viewId === 'home') this.applyAccountOnlyUI();

        window.scrollTo(0, 0);

        // Thay đổi thanh URL trên trình duyệt
        if (pushState && window.location.protocol !== 'file:') {
            const path = viewId === 'deposit' ? '/bank' : (viewId === 'home' ? '/' : `/${viewId}`);
            if (window.location.pathname !== path) {
                history.pushState({ view: viewId }, '', path);
            }
        }

        // Apply staggered fade-up animation to main blocks
        if (target) {
            const animatedElements = target.querySelectorAll('.glass-card, .dashboard-content, .hero-content');
            animatedElements.forEach((el, index) => {
                // Remove class to reset animation
                el.classList.remove('animate-fade-up');
                void el.offsetWidth; // Trigger reflow

                el.style.animationDelay = `${index * 0.05}s`;
                el.classList.add('animate-fade-up');
            });
        }
        this.initScrollReveal();
        this.updateMobileBottomNav(viewId);
    },

    getSortedProducts: function (products) {
        const list = [...products];
        if (this.productSort === 'price-asc') return list.sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
        if (this.productSort === 'price-desc') return list.sort((a, b) => Number(b.price || 0) - Number(a.price || 0));
        if (this.productSort === 'stock') return list.sort((a, b) => Number(b.quantity || 0) - Number(a.quantity || 0));
        return list.sort((a, b) => Number(b.quantity > 0) - Number(a.quantity > 0));
    },

    isAutoProduct: function (product) {
        return !!(product && (product.deliveryMode === 'inventory' || product.sourceMode === 'inventory'));
    },

    isWarrantyEnabled: function (product) {
        if (!product) return false;
        if (product.warrantyEnabled === true) return true;
        if (product.warrantyEnabled === false) return false;
        const warranty = String(product.warranty || '').trim().toLowerCase();
        return !!warranty && !['không bảo hành', 'khong bao hanh', 'none', 'no'].includes(warranty);
    },

    getOrderDurationText: function (order) {
        if (!order) return 'Chưa rõ';
        const savedDuration = String(order.duration || order.productDuration || '').trim();
        return savedDuration || 'Chưa rõ';
    },

    filterProductsBySource: function (products) {
        if (this.productSourceFilter === 'auto') return products.filter(p => this.isAutoProduct(p));
        if (this.productSourceFilter === 'manual') return products.filter(p => !this.isAutoProduct(p));
        return products;
    },

    getProductCategory: function (product) {
        const categories = this.getProductCategories();
        const validIds = new Set(categories.map(category => category.id));
        const assignedCategory = String(product?.categoryId || product?.category || '').trim();
        if (assignedCategory && validIds.has(assignedCategory)) return assignedCategory;

        const text = this.normalizeText(`${product?.name || ''} ${product?.desc || ''}`);

        if (/(chatgpt|openai|gemini|claude|copilot|perplexity|deepseek|midjourney|\bgpt\b|\bai\b)/.test(text)) {
            return validIds.has('ai') ? 'ai' : 'other';
        }
        if (/(canva|adobe|capcut|meitu|wink|xingtu|figma|photoshop|lightroom|design|video|photo)/.test(text)) {
            return validIds.has('design') ? 'design' : 'other';
        }
        if (/(office|microsoft 365|gmail|google workspace|google drive|drive|notion|zoom|email|mail)/.test(text)) {
            return validIds.has('office') ? 'office' : 'other';
        }
        if (/(netflix|youtube|spotify|apple music|tiktok|disney|vieon|fpt play|game|gaming|music|am nhac)/.test(text)) {
            return validIds.has('entertainment') ? 'entertainment' : 'other';
        }
        return validIds.has('other') ? 'other' : (categories[0]?.id || 'other');
    },

    getProductCategories: function () {
        const categories = new Map(this.DEFAULT_PRODUCT_CATEGORIES.map(category => [
            category.id,
            { ...category, isDefault: true }
        ]));

        (this.appState.productCategories || []).forEach(category => {
            if (!category || !category.id) return;
            if (category.deleted) {
                categories.delete(category.id);
                return;
            }
            const existing = categories.get(category.id) || {};
            categories.set(category.id, {
                ...existing,
                ...category,
                name: String(category.name || existing.name || 'Nhóm chưa đặt tên').trim()
            });
        });

        return Array.from(categories.values()).sort((a, b) =>
            Number(a.order || 0) - Number(b.order || 0)
            || String(a.name).localeCompare(String(b.name), 'vi')
        );
    },

    getProductCategoryName: function (categoryId) {
        return this.getProductCategories().find(category => category.id === categoryId)?.name || 'Khác';
    },

    renderProductCategoryTabs: function () {
        const container = document.querySelector('.product-category-tabs');
        if (!container) return;

        const buttons = [
            `<button class="product-category-btn" data-category="all" onclick="app.setProductCategoryFilter('all', this)">
                Tất cả <span data-category-pill-count="all">0</span>
            </button>`,
            ...this.getProductCategories().map(category => `
                <button class="product-category-btn" data-category="${this.escapeHtml(category.id)}"
                    onclick="app.setProductCategoryFilter('${this.escapeHtml(category.id)}', this)">
                    ${this.escapeHtml(category.name)}
                    <span data-category-pill-count="${this.escapeHtml(category.id)}">0</span>
                </button>
            `)
        ];
        container.innerHTML = buttons.join('');

        if (this.productCategoryFilter !== 'all'
            && !this.getProductCategories().some(category => category.id === this.productCategoryFilter)) {
            this.productCategoryFilter = 'all';
        }
        this.updateProductCategoryCounts();
        this.syncProductFilterControls();
    },

    filterProductsByCategory: function (products) {
        if (this.productCategoryFilter === 'all') return products;
        return products.filter(p => this.getProductCategory(p) === this.productCategoryFilter);
    },

    filterProducts: function (products) {
        return this.filterProductsByCategory(this.filterProductsBySource(products));
    },

    getProductBadges: function (product, inStock) {
        const badges = [];
        if (inStock) badges.push({ icon: 'fas fa-bolt', text: 'Giao ngay' });
        if (this.isAutoProduct(product)) {
            badges.push({ icon: 'fas fa-robot', text: 'Tự động 24/7' });
        }
        if (this.isWarrantyEnabled(product)) {
            badges.push({ icon: 'fas fa-shield-alt', text: this.getWarrantyText(product) });
        } else {
            badges.push({ icon: 'fas fa-shield-alt', text: 'Không bảo hành' });
        }
        return badges.slice(0, 3);
    },

    createProductCard: function (product, index, keyword = '') {
        const p = product;
        const card = document.createElement('div');
        card.className = 'product-card animate-fade-up';
        card.style.animationDelay = `${Math.min(index, 12) * 0.035}s`;
        card.addEventListener('animationend', () => {
            card.classList.remove('animate-fade-up');
        }, { once: true });

        const discount = this.appState.events ? (this.appState.events.discountPercent || 0) : 0;
        const inStock = Number(p.quantity || 0) > 0;
        const safeName = this.escapeHtml(p.name || 'Sản phẩm');
        const safeDuration = this.escapeHtml(p.duration || 'Dùng ngay');
        const firstLogo = p.logoUrls && p.logoUrls.length > 0 ? p.logoUrls[0] : null;
        let finalPrice = Number(p.price || 0);
        let priceHtml = `<span class="pc-price">${this.formatMoney(finalPrice)}</span>`;

        if (discount > 0) {
            finalPrice = Math.round(finalPrice - (finalPrice * discount / 100));
            priceHtml = `
                <span class="pc-price">
                    <span class="pc-price-old">${this.formatMoney(p.price)}</span>
                    ${this.formatMoney(finalPrice)}
                    <span class="pc-discount-tag">-${discount}%</span>
                </span>`;
        }

        const bannerContent = firstLogo
            ? `<img src="${this.escapeHtml(firstLogo)}" alt="${safeName}" loading="lazy" decoding="async">`
            : `<span class="pc-banner-placeholder"><i class="fas fa-shopping-bag"></i></span>`;

        const highlightedName = keyword
            ? safeName.replace(new RegExp(`(${this.escapeHtml(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark class="psb-highlight">$1</mark>')
            : safeName;

        const badgeHtml = this.getProductBadges(p, inStock).map(badge => `
            <span class="pc-trust-pill"><i class="${badge.icon}"></i>${this.escapeHtml(badge.text)}</span>
        `).join('');

        card.innerHTML = `
            <div class="pc-banner" style="cursor:${inStock ? 'pointer' : 'default'}">
                ${bannerContent}
                <span class="pc-stock-badge ${inStock ? 'in-stock' : 'out-stock'}">
                    ${inStock ? `Còn ${Number(p.quantity || 0)}` : 'Hết hàng'}
                </span>
            </div>
            <div class="pc-body">
                <div class="pc-name" title="${safeName}">${highlightedName}</div>
                <div class="pc-duration"><i class="fas fa-clock"></i>${safeDuration}</div>
                <div class="pc-trust-row">${badgeHtml}</div>
                ${priceHtml}
                <button class="pc-btn ${inStock ? 'pc-btn-buy' : 'pc-btn-sold'}" ${!inStock ? 'disabled' : ''}>
                    ${inStock ? '<i class="fas fa-shopping-bag"></i> Xem &amp; Mua' : 'Hết hàng'}
                </button>
            </div>
        `;

        if (inStock) {
            const pid = p.id;
            const openProduct = () => this.showProductModal(pid);
            card.querySelector('.pc-banner').addEventListener('click', openProduct);
            card.querySelector('.pc-btn').addEventListener('click', openProduct);
        }

        return card;
    },

    renderProductControls: function () {
        const searchBar = document.getElementById('product-search-bar');
        if (!searchBar) return;
        if (document.getElementById('product-sort-controls')) {
            this.syncProductFilterControls();
            return;
        }

        const controls = document.createElement('div');
        controls.id = 'product-sort-controls';
        controls.className = 'product-sort-controls';
        controls.innerHTML = `
            <div class="product-filter-row">
                <div class="product-category-tabs" aria-label="Lọc theo danh mục"></div>
                <div class="product-utility-controls">
                    <div class="product-source-segment" aria-label="Lọc theo nguồn giao">
                        <button class="product-source-btn active" data-source="all" onclick="app.setProductSourceFilter('all', this)">Tất cả</button>
                        <button class="product-source-btn" data-source="auto" onclick="app.setProductSourceFilter('auto', this)"><i class="fas fa-bolt"></i> Tự động</button>
                        <button class="product-source-btn" data-source="manual" onclick="app.setProductSourceFilter('manual', this)"><i class="fas fa-user-check"></i> Thủ công</button>
                    </div>
                    <label class="product-sort-select" for="product-sort-select">
                        <i class="fas fa-arrow-down-wide-short"></i>
                        <select id="product-sort-select" onchange="app.setProductSort(this.value, this)" aria-label="Sắp xếp sản phẩm">
                            <option value="default">Nổi bật</option>
                            <option value="stock">Còn nhiều</option>
                            <option value="price-asc">Giá thấp đến cao</option>
                            <option value="price-desc">Giá cao đến thấp</option>
                        </select>
                    </label>
                </div>
            </div>
        `;
        searchBar.appendChild(controls);
        this.renderProductCategoryTabs();
    },

    syncProductFilterControls: function () {
        document.querySelectorAll('.product-category-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.category === this.productCategoryFilter);
        });
        document.querySelectorAll('.product-source-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.source === this.productSourceFilter);
        });

        const sortSelect = document.getElementById('product-sort-select');
        if (sortSelect && sortSelect.value !== this.productSort) sortSelect.value = this.productSort;
    },

    updateProductCategoryCounts: function () {
        const counts = { all: 0 };
        this.getProductCategories().forEach(category => {
            counts[category.id] = 0;
        });
        (this.appState.products || []).forEach(product => {
            counts.all++;
            const category = this.getProductCategory(product);
            counts[category] = (counts[category] || 0) + 1;
        });

        document.querySelectorAll('[data-category-pill-count]').forEach(el => {
            const count = counts[el.dataset.categoryPillCount] || 0;
            el.textContent = count;
            const button = el.closest('.product-category-btn');
            if (button) button.classList.toggle('hidden', el.dataset.categoryPillCount !== 'all' && count === 0);
        });
    },

    setProductSort: function (sort, btn) {
        this.productSort = sort || 'default';
        document.querySelectorAll('.product-sort-btn').forEach(b => b.classList.toggle('active', b === btn || b.dataset.sort === this.productSort));
        this.syncProductFilterControls();
        const input = document.getElementById('product-search-input');
        this.searchProducts(input ? input.value : '');
    },

    setProductSourceFilter: function (source, btn) {
        this.productSourceFilter = source || 'all';
        this.syncProductFilterControls();
        const input = document.getElementById('product-search-input');
        this.searchProducts(input ? input.value : '');
    },

    setProductCategoryFilter: function (category, btn, shouldScroll = false) {
        this.productCategoryFilter = category || 'all';
        this.syncProductFilterControls();

        const input = document.getElementById('product-search-input');
        this.searchProducts(input ? input.value : '');

        if (shouldScroll) {
            const section = document.getElementById('products-section');
            if (section) requestAnimationFrame(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        }
    },

    resetProductFilters: function (shouldScroll = false) {
        this.productCategoryFilter = 'all';
        this.productSourceFilter = 'all';
        this.productSort = 'default';

        const input = document.getElementById('product-search-input');
        const headerInput = document.querySelector('.header-search input');
        if (input) input.value = '';
        if (headerInput) headerInput.value = '';

        this.syncProductFilterControls();
        this.clearProductSearch();

        if (shouldScroll) {
            const section = document.getElementById('products-section');
            if (section) requestAnimationFrame(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        }
    },

    renderProductList: function (products, keyword = '') {
        const container = document.getElementById('product-list');
        if (!container) return;
        container.innerHTML = '';
        const visibleProducts = this.getSortedProducts(this.filterProducts(products));
        visibleProducts.forEach((p, index) => {
            container.appendChild(this.createProductCard(p, index, keyword));
        });

        const countEl = document.getElementById('psb-result-count');
        const emptyEl = document.getElementById('product-empty-search');
        const emptyMessage = document.getElementById('product-empty-message');
        if (countEl && !keyword) {
            countEl.textContent = `${visibleProducts.length} / ${(this.appState.products || []).length} sản phẩm`;
        }
        if (emptyEl) emptyEl.classList.toggle('hidden', visibleProducts.length > 0);
        if (emptyMessage && visibleProducts.length === 0 && !keyword) {
            emptyMessage.textContent = 'Chưa có sản phẩm phù hợp với bộ lọc này.';
        }

        this.initTiltEffects(container);
    },

    renderProductSkeleton: function () {
        const container = document.getElementById('product-list');
        if (!container) return;
        container.innerHTML = Array.from({ length: 8 }).map(() => `
            <div class="product-card product-card-skeleton">
                <div class="pc-banner"></div>
                <div class="pc-body">
                    <div class="sk-line sk-title"></div>
                    <div class="sk-line sk-short"></div>
                    <div class="sk-line sk-pills"></div>
                    <div class="sk-line sk-price"></div>
                    <div class="sk-line sk-btn"></div>
                </div>
            </div>
        `).join('');
        this.renderHomePopularProducts();
    },

    renderProducts: function () {
        const container = document.getElementById('product-list');
        if (!container) return;
        this.renderProductControls();
        this.updateProductCategoryCounts();
        this.syncProductFilterControls();
        this.renderProductList(this.appState.products);
        this.renderHomePopularProducts();
    },

    searchProducts: function (keyword) {
        const trimmed = (keyword || '').trim();
        const clearBtn = document.getElementById('psb-clear-btn');
        const countEl = document.getElementById('psb-result-count');
        const emptyEl = document.getElementById('product-empty-search');
        const keyEl = document.getElementById('psb-keyword');

        // Toggle nút xóa
        if (clearBtn) clearBtn.classList.toggle('hidden', !trimmed);

        if (!trimmed) {
            this.clearProductSearch();
            return;
        }

        const lc = this.normalizeText(trimmed);
        const filtered = this.appState.products.filter(p =>
            this.normalizeText(p.name).includes(lc) ||
            (p.desc && this.normalizeText(p.desc).includes(lc)) ||
            (p.duration && this.normalizeText(p.duration).includes(lc))
        );

        this.renderProductList(filtered, trimmed);
        const visibleCount = this.filterProducts(filtered).length;

        // Hiển thị trạng thái
        if (countEl) {
            countEl.textContent = filtered.length > 0
                ? `Tìm thấy ${visibleCount} sản phẩm cho "${trimmed}"`
                : '';
        }
        if (emptyEl) emptyEl.classList.toggle('hidden', visibleCount > 0);
        const emptyMessage = document.getElementById('product-empty-message');
        if (emptyMessage && visibleCount === 0) {
            emptyMessage.textContent = `Không tìm thấy sản phẩm phù hợp với "${trimmed}".`;
        }
        if (keyEl) keyEl.textContent = trimmed;
    },

    clearProductSearch: function () {
        const input = document.getElementById('product-search-input');
        const clearBtn = document.getElementById('psb-clear-btn');
        const countEl = document.getElementById('psb-result-count');
        const emptyEl = document.getElementById('product-empty-search');

        if (input) input.value = '';
        if (clearBtn) clearBtn.classList.add('hidden');
        if (countEl) countEl.textContent = '';
        if (emptyEl) emptyEl.classList.add('hidden');

        // Render lại toàn bộ sản phẩm
        this.renderProducts();
    },

    renderHomePopularProducts: function () {
        const container = document.getElementById('home-popular-list');
        if (!container) return;

        const products = this.getSortedProducts((this.appState.products || []).filter(p => Number(p.quantity || 0) > 0)).slice(0, 5);
        if (products.length === 0) {
            container.innerHTML = Array.from({ length: 5 }).map(() => `
                <div class="home-popular-item home-popular-skeleton">
                    <span class="home-popular-logo"></span>
                    <span class="home-popular-meta">
                        <span></span>
                        <small></small>
                    </span>
                    <span class="home-popular-price"></span>
                    <span class="home-popular-action"></span>
                </div>
            `).join('');
            return;
        }

        const discount = this.appState.events ? (this.appState.events.discountPercent || 0) : 0;
        container.innerHTML = products.map(p => {
            const name = this.escapeHtml(p.name || 'Sản phẩm');
            const duration = this.escapeHtml(p.duration || 'Dùng ngay');
            const warranty = this.escapeHtml(this.getWarrantyText(p));
            const rawPrice = Number(p.price || 0);
            const finalPrice = discount > 0 ? Math.round(rawPrice - (rawPrice * discount / 100)) : rawPrice;
            const firstLogo = p.logoUrls && p.logoUrls.length > 0 ? p.logoUrls[0] : '';
            const logo = firstLogo
                ? `<img src="${this.escapeHtml(firstLogo)}" alt="${name}" loading="lazy" decoding="async">`
                : `<i class="fas fa-shopping-bag"></i>`;
            const safeId = String(p.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

            return `
                <button type="button" class="home-popular-item" onclick="app.showProductModal('${safeId}')">
                    <span class="home-popular-logo">${logo}</span>
                    <span class="home-popular-meta">
                        <strong>${name}</strong>
                        <small>${duration} · ${warranty}</small>
                    </span>
                    <span class="home-popular-price">${this.formatMoney(finalPrice)}</span>
                    <span class="home-popular-action">Mua ngay</span>
                </button>
            `;
        }).join('');
    },

    showProductModal: function (productId) {
        // Chỉ cho phép 1 modal tại 1 thời điểm
        this.closeProductModal();

        const p = this.appState.products.find(x => x.id === productId);
        if (!p) return;

        const discount = this.appState.events ? (this.appState.events.discountPercent || 0) : 0;
        let finalPrice = p.price;
        if (discount > 0) finalPrice = Math.round(p.price - (p.price * discount / 100));

        const inStock = p.quantity > 0;
        const firstLogo = p.logoUrls && p.logoUrls.length > 0 ? p.logoUrls[0] : null;
        const userBalance = this.appState.currentUser ? (this.appState.currentUser.balance || 0) : 0;
        const canAfford = userBalance >= finalPrice;
        const isAuto = this.isAutoProduct(p);
        const safeName = this.escapeHtml(p.name || 'Sản phẩm');
        const safeDuration = this.escapeHtml(p.duration || 'Dùng ngay');
        const safeDesc = this.escapeHtml(p.desc || '');
        const warrantyText = this.getWarrantyText(p);
        const sourceLabel = isAuto ? 'Tự động 24/7' : 'Admin cấp thủ công';
        const deliveryLabel = isAuto ? 'Giao tự động sau thanh toán' : 'Admin xử lý và cấp tài khoản';

        const logoHtml = firstLogo
            ? `<img class="pm-logo" src="${this.escapeHtml(firstLogo)}" alt="${safeName}" loading="lazy" decoding="async">`
            : `<div class="pm-logo-placeholder"><i class="fas fa-shopping-bag"></i></div>`;

        const priceDisplay = discount > 0
            ? `<div><div class="pm-price-label" style="text-decoration:line-through;color:var(--text-muted);font-size:0.8rem">${this.formatMoney(p.price)}</div><div class="pm-price-value">${this.formatMoney(finalPrice)}</div></div>`
            : `<div><div class="pm-price-label">Giá bán</div><div class="pm-price-value">${this.formatMoney(finalPrice)}</div></div>`;

        const balanceInfo = this.appState.currentUser
            ? `<div class="pm-info-row"><span class="label"><i class="fas fa-wallet"></i> Số dư của bạn</span><span class="value" style="color:${canAfford ? '#10b981' : 'var(--danger)'}">${this.formatMoney(userBalance)}</span></div>`
            : '';

        const depositBtn = (this.appState.currentUser && !canAfford)
            ? `<button class="pm-btn-deposit" id="pm-btn-deposit"><i class="fas fa-plus"></i> Nạp tiền</button>`
            : '';

        const buyLabel = !inStock ? 'Hết hàng'
            : this.appState.currentUser ? '<i class="fas fa-bolt"></i> Mua ngay'
                : '<i class="fas fa-sign-in-alt"></i> Đăng nhập để mua';

        // Tạo overlay
        const overlay = document.createElement('div');
        overlay.className = 'product-modal-overlay';
        overlay.innerHTML = `
            <div class="product-modal">
                <button class="pm-close" id="pm-close-btn" title="Đóng"><i class="fas fa-times"></i></button>
                <div class="pm-header">
                    ${logoHtml}
                    <div class="pm-title-block">
                        <div class="pm-title">${safeName}</div>
                        <div class="pm-subtitle">
                            <span><i class="fas fa-clock" style="color:var(--primary)"></i> ${safeDuration}</span>
                            <span style="color:${inStock ? '#10b981' : 'var(--danger)'}"><i class="fas fa-box"></i> Còn ${Number(p.quantity || 0)}</span>
                            <span><i class="${isAuto ? 'fas fa-robot' : 'fas fa-user-check'}"></i> ${sourceLabel}</span>
                        </div>
                    </div>
                </div>
                <div class="pm-body">
                    ${safeDesc ? `<div class="pm-desc">${safeDesc}</div>` : ''}
                    <div class="pm-checklist">
                        <div class="pm-check"><i class="fas fa-truck-fast"></i><span>${deliveryLabel}</span></div>
                        <div class="pm-check"><i class="fas fa-shield-alt"></i><span>${this.escapeHtml(warrantyText)}</span></div>
                        <div class="pm-check"><i class="fas fa-copy"></i><span>Thông tin nhận được hiển thị trong lịch sử đơn</span></div>
                    </div>
                    ${balanceInfo}
                    <div class="pm-price-block">
                        ${priceDisplay}
                        <div class="pm-qty-wrap">
                            <label>Số lượng</label>
                            <input type="number" id="pm-qty-input" class="pm-qty-input" value="1" min="1" max="${p.quantity}" ${!inStock ? 'disabled' : ''}>
                        </div>
                    </div>
                    <div class="pm-footer">
                        <button class="pm-btn-buy" id="pm-btn-buy" ${!inStock ? 'disabled' : ''}>${buyLabel}</button>
                        ${depositBtn}
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        this._activeOverlay = overlay;

        // Gắn sự kiện SAU KHI đã append vào DOM
        overlay.querySelector('#pm-close-btn').addEventListener('click', () => this.closeProductModal());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) this.closeProductModal(); });

        const buyBtn = overlay.querySelector('#pm-btn-buy');
        if (buyBtn && inStock) {
            buyBtn.addEventListener('click', () => this.buyProductFromModal(p.id));
        } else if (buyBtn && !this.appState.currentUser) {
            buyBtn.addEventListener('click', () => { this.closeProductModal(); this.navigate('login'); });
        }

        const depBtn = overlay.querySelector('#pm-btn-deposit');
        if (depBtn) depBtn.addEventListener('click', () => { this.closeProductModal(); this.navigate('deposit'); });

        this._modalKeyHandler = (e) => { if (e.key === 'Escape') this.closeProductModal(); };
        document.addEventListener('keydown', this._modalKeyHandler);
    },

    closeProductModal: function () {
        if (this._activeOverlay) {
            this._activeOverlay.remove();
            this._activeOverlay = null;
        }
        if (this._modalKeyHandler) {
            document.removeEventListener('keydown', this._modalKeyHandler);
            this._modalKeyHandler = null;
        }
    },

    buyProductFromModal: function (productId) {
        if (!this.appState.currentUser) {
            this.closeProductModal();
            this.navigate('login');
            return;
        }
        const qtyInput = document.getElementById('pm-qty-input');
        const buyQuantity = qtyInput ? parseInt(qtyInput.value) || 1 : 1;

        const p = this.appState.products.find(x => x.id === productId);
        if (p) {
            if (buyQuantity < 1 || buyQuantity > Number(p.quantity || 0)) {
                this.showToast(`Kho chỉ còn ${Number(p.quantity || 0)} sản phẩm.`, 'warning');
                return;
            }
            // Dùng buyQuantity (nhất quán với setupCheckout)
            this.appState.cartItem = { ...p, buyQuantity };
            this.closeProductModal();
            this.navigate('checkout');
        }
    },



    listenToProducts: function () {
        if (!db) {
            return;
        }
        this.renderProductSkeleton();

        db.ref('products').on('value', snapshot => {
            if (snapshot.exists()) {
                const data = snapshot.val();
                const tempProducts = [];
                Object.keys(data).forEach(key => {
                    tempProducts.push({ ...data[key], id: key });
                });

                tempProducts.sort((a, b) => a.name.localeCompare(b.name));

                this.appState.products = tempProducts;
                this.renderProducts();

                // Cập nhật typing effect theo tên sản phẩm từ Firebase
                HeroFX.updateTypingWords(tempProducts.map(p => p.name));

                if (document.getElementById('view-admin') && document.getElementById('view-admin').classList.contains('active')) {
                    this.renderAdminProducts();
                }
            } else {
                this.appState.products = [];
                this.renderProducts();
            }
        });
    },

    listenToProductCategories: function () {
        if (!db) return;
        db.ref('productCategories').on('value', snapshot => {
            const data = snapshot.val() || {};
            this.appState.productCategories = Object.keys(data).map(id => ({ ...data[id], id }));
            this.renderProductCategoryTabs();
            this.populateProductCategorySelect();
            this.populateAdminCategoryFilter();
            this.renderAdminCategoryManager();
            if (document.getElementById('product-list')) this.renderProducts();
            if (document.getElementById('admin-products-list')) this.renderAdminProducts();
        });
    },

    // Auth System
    updateHeaderUserIdentity: function (user) {
        const accountLink = document.getElementById('nav-user-1');
        const emailLabel = document.getElementById('nav-user-email');
        if (!accountLink || !emailLabel) return;

        const email = String(user?.email || '').trim();
        const username = String(user?.username || '').trim();
        const identity = email || username || 'Tài khoản';
        emailLabel.textContent = identity;
        accountLink.title = identity;
        accountLink.setAttribute('aria-label', `Tài khoản: ${identity}`);
    },

    checkAuth: function () {
        const user = localStorage.getItem('accstore_user');
        if (user) {
            this.appState.currentUser = JSON.parse(user);
            this.updateHeaderUserIdentity(this.appState.currentUser);

            document.getElementById('nav-guest-1').classList.add('hidden');
            document.getElementById('nav-guest-2').classList.add('hidden');
            document.getElementById('nav-user-1').classList.remove('hidden');
            document.getElementById('nav-user-2').classList.remove('hidden');
            const navNotif = document.getElementById('nav-notifications');
            if (navNotif) navNotif.classList.remove('hidden');

            const navOtp = document.getElementById('nav-otp');
            if (navOtp) navOtp.classList.remove('hidden');
            const navDep = document.getElementById('nav-deposit');
            if (navDep) navDep.classList.remove('hidden');

            const isAdmin = this.appState.currentUser.username.trim().toLowerCase() === 'admin';
            const navAdmin = document.getElementById('nav-admin');
            if (navAdmin) {
                if (isAdmin) navAdmin.classList.remove('hidden');
                else navAdmin.classList.add('hidden');
            }

            const userDisp = document.getElementById('user-display-name');
            if (userDisp) userDisp.innerText = this.appState.currentUser.username;

            // Bắt đầu lắng nghe dữ liệu từ Firebase
            this.listenToOrders();
            this.listenToCustomerChat();
            this.listenToUserBalance();
            this._otpCleanupDone = false;
            this.listenToOTPHistory();
            this.startBackgroundOTPPoller();
            this.listenToDeposits(); // Tất cả user đều cần xem lịch sử nạp tiền
            if (isAdmin) {
                this.listenToUsers();
                this.listenToProductInventory();
            }
        } else {
            this.appState.currentUser = null;
            this.updateHeaderUserIdentity(null);
            document.getElementById('nav-guest-1').classList.remove('hidden');
            document.getElementById('nav-guest-2').classList.remove('hidden');
            document.getElementById('nav-user-1').classList.add('hidden');
            document.getElementById('nav-user-2').classList.add('hidden');
            const navNotif = document.getElementById('nav-notifications');
            if (navNotif) navNotif.classList.add('hidden');
            document.getElementById('nav-admin').classList.add('hidden');

            const navOtp = document.getElementById('nav-otp');
            if (navOtp) navOtp.classList.add('hidden');
            const navDep = document.getElementById('nav-deposit');
            if (navDep) navDep.classList.add('hidden');

            if (db) db.ref('orders').off(); // Ngừng lắng nghe nếu đăng xuất
        }
    },

    handleRegister: function (e) {
        e.preventDefault();
        const email = document.getElementById('reg-email').value;
        const u = document.getElementById('reg-username').value;
        const p = document.getElementById('reg-password').value;
        const pc = document.getElementById('reg-password-confirm').value;
        const err = document.getElementById('reg-error');

        if (p !== pc) {
            err.innerText = "Mật khẩu xác nhận không khớp!";
            return;
        }

        if (!db) {
            err.innerText = "Lỗi kết nối máy chủ Firebase!";
            return;
        }
        db.ref('users/' + u).once('value', snapshot => {
            if (snapshot.exists()) {
                err.innerText = "Tên đăng nhập đã tồn tại!";
            } else {
                const newUserObj = {
                    username: u,
                    password: p,
                    email: email,
                    sessionVersion: 0
                };

                db.ref('users/' + u).set(newUserObj).then(() => {
                    this.loginUser(u, 0);
                    void this.recordLoginHistory(u, 'register');
                    this.showToast("Đăng ký thành công!");
                    err.innerText = "";
                    e.target.reset();

                    if (this.appState.cartItem) this.navigate('checkout');
                    else this.navigate('home');
                }).catch(error => {
                    err.innerText = "Đã xảy ra lỗi: " + error.message;
                });
            }
        });
    },

    handleLogin: function (e) {
        e.preventDefault();
        const u = document.getElementById('login-username').value;
        const p = document.getElementById('login-password').value;
        const err = document.getElementById('login-error');

        if (!db) {
            err.innerText = "Lỗi kết nối máy chủ Firebase!";
            return;
        }

        db.ref('users/' + u).once('value', snapshot => {
            if (snapshot.exists()) {
                const user = snapshot.val();
                if (user.password === p) {
                    this.loginUser(u, Number(user.sessionVersion || 0));
                    void this.recordLoginHistory(u, 'login');
                    this.showToast("Đăng nhập thành công!");
                    err.innerText = "";
                    e.target.reset();

                    if (this.appState.cartItem) this.navigate('checkout');
                    else this.navigate('dashboard');
                } else {
                    err.innerText = "Mật khẩu không đúng!";
                }
            } else {
                err.innerText = "Tên đăng nhập không tồn tại!";
            }
        });
    },

    forgotPasswordState: {
        username: null,
        resetCode: null
    },

    requestPasswordReset: function (e) {
        e.preventDefault();
        const u = document.getElementById('forgot-username').value;
        const err = document.getElementById('forgot-step1-error');
        const btn = document.getElementById('btn-request-code');

        if (!db) {
            err.innerText = "Lỗi kết nối máy chủ Firebase!";
            return;
        }

        btn.disabled = true;
        btn.innerText = "Đang kiểm tra...";

        db.ref('users/' + u).once('value', snapshot => {
            if (snapshot.exists()) {
                const user = snapshot.val();
                if (!user.email) {
                    err.innerText = "Tài khoản này chưa được liên kết email!";
                    btn.disabled = false;
                    btn.innerText = "Nhận Mã Xác Nhận";
                    return;
                }

                // Generate 6-digit mock code
                const mockCode = Math.floor(100000 + Math.random() * 900000).toString();

                // Save to DB
                db.ref('users/' + u).update({ resetCode: mockCode }).then(() => {
                    try {
                        this.forgotPasswordState.username = u;
                        this.forgotPasswordState.resetCode = mockCode;

                        // Show Step 2
                        document.getElementById('forgot-step1-form').classList.add('hidden');
                        document.getElementById('forgot-step2-form').classList.remove('hidden');
                        err.innerText = "";

                        btn.disabled = false;
                        btn.innerText = "Nhận Mã Xác Nhận";

                        // Real EmailJS Send
                        this.showToast("Đang gửi mã vào email của bạn...");
                        emailjs.send("service_9ze9ydb", "template_v5lmxco", {
                            to_email: user.email,
                            code: mockCode
                        }).then(() => {
                            this.showToast("Mã xác nhận đã được gửi vào email của bạn!");
                        }).catch((emailError) => {
                            console.error(emailError);
                            err.innerText = "Lỗi gửi email: " + (emailError.text || "Vui lòng thử lại");
                        });
                    } catch (e) {
                        err.innerText = "Lỗi JS: " + e.message;
                        btn.disabled = false;
                        btn.innerText = "Nhận Mã Xác Nhận";
                    }
                }).catch(error => {
                    err.innerText = "Lỗi Database: " + error.message;
                    btn.disabled = false;
                    btn.innerText = "Nhận Mã Xác Nhận";
                });
            } else {
                err.innerText = "Tên đăng nhập không tồn tại!";
                btn.disabled = false;
                btn.innerText = "Nhận Mã Xác Nhận";
            }
        });
    },

    handleForgot: function (e) {
        e.preventDefault();
        const codeInput = document.getElementById('forgot-code').value;
        const newPassword = document.getElementById('forgot-new-password').value;
        const err = document.getElementById('forgot-error');

        const u = this.forgotPasswordState.username;

        if (!u) {
            err.innerText = "Lỗi: Vui lòng yêu cầu lại mã xác nhận!";
            return;
        }

        db.ref('users/' + u).once('value', snapshot => {
            if (snapshot.exists()) {
                const user = snapshot.val();
                if (user.resetCode && user.resetCode === codeInput) {
                    // Update password, clear resetCode
                    db.ref('users/' + u).update({ password: newPassword, resetCode: null }).then(() => {
                        this.showToast("Đổi mật khẩu thành công! Vui lòng đăng nhập lại.");
                        err.innerText = "";
                        e.target.reset();
                        document.getElementById('forgot-step1-form').reset();

                        // Back to step 1
                        document.getElementById('forgot-step2-form').classList.add('hidden');
                        document.getElementById('forgot-step1-form').classList.remove('hidden');

                        this.navigate('login');
                    }).catch(error => {
                        err.innerText = "Đã xảy ra lỗi: " + error.message;
                    });
                } else {
                    err.innerText = "Mã xác nhận không chính xác!";
                }
            }
        });
    },

    loginUser: function (username, sessionVersion = 0) {
        const userObj = {
            username,
            sessionVersion: Number(sessionVersion || 0)
        };
        // Lưu local để tự động đăng nhập những lần sau
        localStorage.setItem('accstore_user', JSON.stringify(userObj));
        this.checkAuth();
    },

    getClientDeviceInfo: function () {
        const userAgent = String(navigator.userAgent || '');
        const platform = String(navigator.userAgentData?.platform || navigator.platform || '');
        let browser = 'Trình duyệt khác';
        let os = platform || 'Không xác định';
        let deviceType = 'Máy tính';

        if (/Edg\//i.test(userAgent)) browser = 'Microsoft Edge';
        else if (/OPR\//i.test(userAgent)) browser = 'Opera';
        else if (/Firefox\//i.test(userAgent)) browser = 'Firefox';
        else if (/Chrome\//i.test(userAgent)) browser = 'Google Chrome';
        else if (/Safari\//i.test(userAgent)) browser = 'Safari';

        if (/Windows/i.test(userAgent)) os = 'Windows';
        else if (/Android/i.test(userAgent)) os = 'Android';
        else if (/iPhone|iPad|iPod/i.test(userAgent)) os = 'iOS';
        else if (/Mac OS X/i.test(userAgent)) os = 'macOS';
        else if (/Linux/i.test(userAgent)) os = 'Linux';

        if (/iPad|Tablet/i.test(userAgent)) deviceType = 'Máy tính bảng';
        else if (/Mobi|Android|iPhone|iPod/i.test(userAgent)) deviceType = 'Điện thoại';

        const screenWidth = Number(window.screen?.width || 0);
        const screenHeight = Number(window.screen?.height || 0);
        return {
            browser,
            os,
            deviceType,
            platform,
            language: String(navigator.language || ''),
            screen: screenWidth && screenHeight ? `${screenWidth}x${screenHeight}` : '',
            userAgent: userAgent.slice(0, 350)
        };
    },

    recordLoginHistory: async function (username, source = 'login') {
        if (!db || !username) return;
        const clean = (value, max = 120) => String(value || '').trim().slice(0, max);
        const isLocal = ['127.0.0.1', 'localhost'].includes(String(window.location?.hostname || '').toLowerCase());
        let network = {};

        try {
            const response = await fetch('/api/login-context', {
                method: 'GET',
                headers: { Accept: 'application/json' },
                cache: 'no-store'
            });
            const contentType = response.headers.get('content-type') || '';
            if (!response.ok || !contentType.includes('application/json')) throw new Error('Login context unavailable');
            const payload = await response.json();
            if (payload?.success && payload.data) network = payload.data;
        } catch (error) {
            network = {};
        }

        const device = this.getClientDeviceInfo();
        const timezone = clean(network.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || '');
        const record = {
            timestamp: Date.now(),
            date: new Date().toLocaleString('vi-VN'),
            source: source === 'register' ? 'register' : 'login',
            ip: clean(network.ip || (isLocal ? '127.0.0.1' : 'Không xác định'), 64),
            city: clean(network.city || (isLocal ? 'Máy cục bộ' : '')),
            regionCode: clean(network.regionCode || '', 24),
            regionName: clean(network.regionName || ''),
            countryCode: clean(network.countryCode || '', 12),
            countryName: clean(network.countryName || ''),
            timezone,
            browser: clean(device.browser),
            os: clean(device.os),
            deviceType: clean(device.deviceType),
            platform: clean(device.platform),
            language: clean(device.language, 30),
            screen: clean(device.screen, 30),
            userAgent: clean(device.userAgent, 350),
            environment: isLocal ? 'local' : 'production'
        };

        try {
            const historyRef = db.ref(`loginHistory/${username}`);
            await historyRef.push().set(record);
            await db.ref(`users/${username}`).update({
                lastLoginAt: record.timestamp,
                lastLoginIp: record.ip,
                lastLoginLocation: [record.city, record.regionName, record.countryName].filter(Boolean).join(', ')
            });

            const snapshot = await historyRef.once('value');
            const entries = Object.entries(snapshot.val() || {})
                .sort((a, b) => Number(b[1]?.timestamp || 0) - Number(a[1]?.timestamp || 0));
            if (entries.length > 100) {
                const removals = {};
                entries.slice(100).forEach(([id]) => { removals[id] = null; });
                await historyRef.update(removals);
            }
        } catch (error) {
            console.warn('Không thể lưu lịch sử đăng nhập:', error);
        }
    },

    logout: function (forcedMessage = '') {
        const username = this.appState.currentUser?.username;
        this.stopBackgroundOTPPoller();
        if (this._userAccountRef && this._userAccountListener) {
            this._userAccountRef.off('value', this._userAccountListener);
        }
        this._userAccountRef = null;
        this._userAccountListener = null;
        if (db && username) {
            db.ref(`users/${username}/otp_history`).off();
            db.ref(`chats/${username}/messages`).off();
            db.ref('orders').off();
            db.ref('deposit_requests').off();
        }
        if (db && username?.trim().toLowerCase() === 'admin') {
            db.ref('users').off();
            if (this._productInventoryRef && this._productInventoryListener) {
                this._productInventoryRef.off('value', this._productInventoryListener);
            }
        }
        this._productInventoryRef = null;
        this._productInventoryListener = null;
        localStorage.removeItem('accstore_user');
        sessionStorage.removeItem('accstore_provider_admin_token');
        this.appState.currentUser = null;
        this.providerAdminState.providers = [];
        this.providerAdminState.productsByProvider = {};
        this.appState.orders = [];
        this.appState.allOrders = [];
        this.checkAuth();
        this.navigate(forcedMessage ? 'login' : 'home');
        this.showToast(forcedMessage || "Đã đăng xuất!", forcedMessage ? 'warning' : 'success');
    },

    // Realtime Database Listener
    listenToOrders: function () {
        if (!db || !this.appState.currentUser) return;

        // Xóa listener cũ trước khi tạo mới (tránh trùng lặp nếu gọi nhiều lần)
        db.ref('orders').off();

        // Lắng nghe sự kiện "value" để lấy toàn bộ dữ liệu đơn hàng mỗi khi có thay đổi
        db.ref('orders').on('value', snapshot => {
            const rawData = snapshot.val();
            const tempAllOrders = [];

            if (rawData) {
                // Chuyển object Firebase thành mảng
                Object.keys(rawData).forEach(key => {
                    tempAllOrders.push({ ...rawData[key], id: key });
                });

                // Sắp xếp mới nhất lên đầu
                tempAllOrders.sort((a, b) => b.timestamp - a.timestamp);
            }

            this.appState.allOrders = tempAllOrders;

            // Lọc ra đơn hàng của user hiện tại
            this.appState.orders = tempAllOrders.filter(o => o.username === this.appState.currentUser.username);

            // Tự động cập nhật lại giao diện nếu đang mở Dashboard hoặc Admin
            if (document.getElementById('view-dashboard').classList.contains('active')) {
                this.renderDashboard();
            }
            if (document.getElementById('view-admin').classList.contains('active')) {
                this.renderAdmin();
            }
        });
    },

    listenToUserBalance: function () {
        if (!db || !this.appState.currentUser) return;
        const u = this.appState.currentUser.username;
        if (this._userAccountRef && this._userAccountListener) {
            this._userAccountRef.off('value', this._userAccountListener);
        }
        this._userAccountRef = db.ref('users/' + u);
        this._userAccountListener = snapshot => {
            if (snapshot.exists()) {
                const user = snapshot.val();
                const serverSessionVersion = Number(user.sessionVersion || 0);
                const localSessionVersion = this.appState.currentUser?.sessionVersion;

                if (localSessionVersion === undefined || localSessionVersion === null) {
                    if (serverSessionVersion > 0) {
                        this.logout('Phiên đăng nhập đã bị quản trị viên kết thúc. Vui lòng đăng nhập lại.');
                        return;
                    }
                    this.appState.currentUser.sessionVersion = serverSessionVersion;
                    localStorage.setItem('accstore_user', JSON.stringify(this.appState.currentUser));
                } else if (Number(localSessionVersion) !== serverSessionVersion) {
                    const reason = user.forceLogoutReason
                        ? `Phiên đăng nhập đã bị kết thúc: ${user.forceLogoutReason}`
                        : 'Phiên đăng nhập đã bị quản trị viên kết thúc. Vui lòng đăng nhập lại.';
                    this.logout(reason);
                    return;
                }

                this.appState.currentUser.balance = user.balance || 0;

                const serverEmail = String(user.email || '').trim();
                if (String(this.appState.currentUser.email || '').trim() !== serverEmail) {
                    this.appState.currentUser.email = serverEmail;
                    localStorage.setItem('accstore_user', JSON.stringify(this.appState.currentUser));
                }
                this.updateHeaderUserIdentity(this.appState.currentUser);

                // Sync API key
                if (user.apiKey !== undefined) {
                    this.appState.currentUser.apiKey = user.apiKey || null;
                }

                const balSpan = document.getElementById('nav-balance');
                if (balSpan) balSpan.innerText = this.formatMoney(this.appState.currentUser.balance);
            } else if (this.appState.currentUser) {
                this.logout('Tài khoản không còn tồn tại hoặc đã bị vô hiệu hóa.');
            }
        };
        this._userAccountRef.on('value', this._userAccountListener);
    },

    cleanupStuckOTPs: function () {
        if (!this.appState.currentUser || !db) return;
        const username = this.appState.currentUser.username;
        const now = Date.now();
        // OTP quá 310 giây mà vẫn "Đang chờ mã" → hoàn tiền
        (this.appState.otpHistory || []).forEach(h => {
            if (h.status === 'Đang chờ mã' && !h.refundedAt && (now - h.timestamp) >= 310000) {
                this.refundOTPRequest(username, h.id, h.price, 'Đã hoàn tiền (Hết thời gian)')
                    .catch(err => console.error('[Cleanup] Lỗi hoàn tiền OTP cũ:', err));
            }
        });
    },

    listenToOTPHistory: function () {
        if (!db || !this.appState.currentUser) return;
        const u = this.appState.currentUser.username;
        db.ref('users/' + u + '/otp_history').on('value', snapshot => {
            const data = snapshot.val();
            const historyList = [];
            if (data) {
                Object.keys(data).forEach(key => {
                    historyList.push({ ...data[key], id: key });
                });
                historyList.sort((a, b) => b.timestamp - a.timestamp);
            }

            // Phát hiện OTP vừa chuyển từ "Đang chờ mã" → resolved
            const prevPendingIds = new Set((this.appState.otpHistory || [])
                .filter(h => h.status === 'Đang chờ mã').map(h => h.id));

            this.appState.otpHistory = historyList;

            if (document.getElementById('view-dashboard').classList.contains('active')) {
                this.renderDashboard();
            }

            // Dọn OTP cũ bị kẹt "Đang chờ mã" — chỉ chạy 1 lần sau login
            if (!this._otpCleanupDone) {
                this._otpCleanupDone = true;
                this.cleanupStuckOTPs();
            }

            // Cập nhật _resolvedOTPs cho các số vừa giải quyết xong
            historyList.forEach(h => {
                if (!prevPendingIds.has(h.id)) return;
                if (h.status === 'Đang chờ mã') return;
                const isSuccess = h.status === 'Thành công';
                if (!this.otpState._resolvedOTPs) this.otpState._resolvedOTPs = {};
                this.otpState._resolvedOTPs[h.id] = {
                    appName: h.appName, phone: h.phone,
                    code: h.code || '', isSuccess,
                    resolvedAt: Date.now()
                };
                if (isSuccess) {
                    this.showToast('Mã OTP ' + this.escapeHtml(h.appName) + ': ' + h.code);
                } else {
                    this.showToast('Số ' + this.normalizeVietnamPhone(h.phone) + ' đã hủy / hoàn tiền.', 'warning');
                }
                // Tự xóa khỏi bar sau 35 giây
                setTimeout(() => {
                    if (this.otpState._resolvedOTPs) {
                        delete this.otpState._resolvedOTPs[h.id];
                        this.renderOTPPendingBar();
                    }
                }, 35000);
            });

            this.renderOTPPendingBar();
        });
    },

    listenToDeposits: function () {
        if (!db || !this.appState.currentUser) return;
        const isAdmin = this.appState.currentUser.username.trim().toLowerCase() === 'admin';

        db.ref('deposit_requests').on('value', snapshot => {
            const rawData = snapshot.val();
            const tempAll = [];
            if (rawData) {
                Object.keys(rawData).forEach(key => {
                    tempAll.push({ ...rawData[key], memo: key });
                });
                tempAll.sort((a, b) => b.timestamp - a.timestamp);
            }

            tempAll.forEach(d => {
                if (d.status === 'Chờ duyệt' && Date.now() >= this.getDepositExpiry(d)) {
                    this.expireDepositIfNeeded(d.memo);
                    d.status = 'Hết hạn';
                }
            });

            // Admin thấy tất cả, user thường chỉ thấy của mình
            if (isAdmin) {
                this.appState.allDeposits = tempAll;
            }
            // Luôn lọc lịch sử nạp tiền cho user hiện tại
            this.appState.depositHistory = tempAll.filter(d => d.username === this.appState.currentUser.username);

            if (isAdmin && document.getElementById('view-admin').classList.contains('active')) {
                this.renderAdmin();
            }
            if (document.getElementById('view-dashboard').classList.contains('active')) {
                this.renderDashboard();
            }
        });
    },

    listenToUsers: function () {
        if (!db) return;
        db.ref('users').on('value', snapshot => {
            const rawData = snapshot.val();
            const tempUsers = [];
            if (rawData) {
                Object.keys(rawData).forEach(key => {
                    tempUsers.push({ username: key, ...rawData[key] });
                });
            }
            this.appState.allUsers = tempUsers;
            if (document.getElementById('view-admin').classList.contains('active')) {
                this.renderAdminUsers();
                this.renderAdminStats();
            }
        });
    },

    listenToSettings: function () {
        if (!db) return;

        // Listen to Events (Khuyến mãi)
        db.ref('settings/events').on('value', snapshot => {
            if (snapshot.exists()) {
                this.appState.events = snapshot.val();
            } else {
                this.appState.events = { discountPercent: 0, depositBonusPercent: 0 };
            }
            this.renderProducts(); // Re-render to apply new discounts if any

        });

        // Listen to Maintenance Settings
        db.ref('settings/maintenance').on('value', snapshot => {
            const data = snapshot.val();
            appState.maintenanceSettings = data
                ? { mode: 'off', zalo: '', facebook: '', telegram: '', email: '', message: '', ...data }
                : { mode: 'off', zalo: '', facebook: '', telegram: '', email: '', message: '' };
            this.applyMaintenanceMode();
            this.renderAdminMaintenanceSettings();
        });

        // Listen to Telegram Bots
        db.ref('settings/telegramBots').on('value', snapshot => {
            const data = snapshot.val();
            if (data) {
                this.appState.telegramBots = Object.entries(data).map(([id, bot]) => ({ id, ...bot }));
            } else {
                this.appState.telegramBots = [];
            }
            this.renderAdminTelegramBots();
        });

        // Listen to Banners
        db.ref('settings/banners').on('value', snapshot => {
            const rawData = snapshot.val();
            const tempBanners = [];
            if (rawData) {
                Object.keys(rawData).forEach(key => {
                    tempBanners.push({ id: key, ...rawData[key] });
                });
            }
            this.appState.banners = tempBanners;
            this.renderBanners();

            if (document.getElementById('view-admin') && document.getElementById('view-admin').classList.contains('active')) {
                this.renderAdminBanners();
            }
        });
    },

    renderBanners: function () {
        const container = document.getElementById('promo-banners');
        if (!container) return;

        if (this.appState.banners.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        container.innerHTML = '';

        // Simple rendering, no complex slider for now to avoid breaking UI. Just stack them or show first one.
        // We will just show all of them stacked or use a simple CSS flex layout.
        const bannerWrapper = document.createElement('div');
        bannerWrapper.style.display = 'flex';
        bannerWrapper.style.overflowX = 'auto';
        bannerWrapper.style.gap = '15px';
        bannerWrapper.style.paddingBottom = '10px';

        this.appState.banners.forEach(b => {
            const a = document.createElement('a');
            if (b.link) {
                a.href = b.link;
                a.target = "_blank";
            } else {
                a.href = "javascript:void(0)";
            }
            a.style.minWidth = '300px';
            a.style.flex = '1';
            a.style.display = 'block';

            const img = document.createElement('img');
            img.src = b.imgUrl;
            img.loading = 'lazy';
            img.decoding = 'async';
            img.alt = b.title || 'Banner';
            img.style.width = '100%';
            img.style.height = 'auto';
            img.style.borderRadius = '12px';
            img.style.objectFit = 'cover';
            img.style.boxShadow = '0 4px 15px rgba(0,0,0,0.3)';

            a.appendChild(img);
            bannerWrapper.appendChild(a);
        });

        container.appendChild(bannerWrapper);
    },

    // Shopping & Checkout Flow
    setupCheckout: function (product) {
        const discount = this.appState.events ? (this.appState.events.discountPercent || 0) : 0;
        const unitPrice = discount > 0 ? product.price - (product.price * discount / 100) : product.price;
        const totalAmount = unitPrice * (product.buyQuantity || 1);

        const detailsContainer = document.getElementById('checkout-product-details');
        detailsContainer.innerHTML = `
            <div class="p-row">
                <span class="p-name">${product.name} <span style="color: var(--primary);">(x${product.buyQuantity || 1})</span></span>
                <span class="p-price">${this.formatMoney(totalAmount)}</span>
            </div>
            <div style="padding: 15px; color: var(--text-muted); font-size: 0.9rem;">
                Thời hạn: ${product.duration}
                <br>Đơn giá: ${this.formatMoney(unitPrice)} / 1 sản phẩm ${discount > 0 ? `(Đã giảm ${discount}%)` : ''}
            </div>
        `;

        const orderId = 'ACC' + Math.floor(Date.now() / 1000).toString().slice(-5) + Math.floor(Math.random() * 90 + 10);
        document.getElementById('checkout-price').innerText = this.formatMoney(totalAmount);

        const currentBal = this.appState.currentUser ? (this.appState.currentUser.balance || 0) : 0;
        document.getElementById('checkout-user-balance').innerText = this.formatMoney(currentBal);

        const btnPay = document.getElementById('btn-pay-balance');
        const warning = document.getElementById('checkout-warning');

        if (currentBal < totalAmount) {
            btnPay.disabled = true;
            warning.style.display = 'block';
        } else {
            btnPay.disabled = false;
            warning.style.display = 'none';
        }

        this.appState.cartItem.tempOrderId = orderId;
        this.appState.cartItem.totalAmount = totalAmount;
    },

    // Gửi thông báo Telegram đến tất cả bot đã cấu hình
    _sendToTelegramBots: function (msg) {
        const bots = (this.appState.telegramBots || []).filter(b => b.enabled !== false && b.token && b.chatId);
        bots.forEach(bot => {
            fetch(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: bot.chatId, text: msg, parse_mode: 'HTML' })
            }).catch(e => console.warn('Telegram notify failed:', e));
        });
    },

    sendTelegramOrderNotification: function (orderData) {
        const msg = [
            '🛒 <b>ĐƠN HÀNG MỚI!</b>',
            '━━━━━━━━━━━━━━━━━━━━',
            `👤 <b>Người dùng:</b> <code>${orderData.username}</code>`,
            `📦 <b>Sản phẩm:</b> ${orderData.productName}`,
            `🔢 <b>Số lượng:</b> ${orderData.quantity}`,
            `💰 <b>Tổng tiền:</b> ${orderData.priceDisplay}`,
            `🕐 <b>Thời gian:</b> ${orderData.date}`,
            '━━━━━━━━━━━━━━━━━━━━',
            `🆔 Mã đơn: <code>${orderData.orderId}</code>`,
        ].join('\n');
        this._sendToTelegramBots(msg);
    },

    sendTelegramDepositNotification: function (depositData) {
        const msg = [
            '💳 <b>YÊU CẦU NẠP TIỀN MỚI!</b>',
            '━━━━━━━━━━━━━━━━━━━━',
            `👤 <b>Người dùng:</b> <code>${depositData.username}</code>`,
            `💰 <b>Số tiền:</b> ${depositData.amountDisplay}`,
            `📋 <b>Nội dung CK:</b> <code>${depositData.memo}</code>`,
            `🕐 <b>Thời gian:</b> ${depositData.date}`,
            '━━━━━━━━━━━━━━━━━━━━',
            '⏳ Vui lòng kiểm tra và duyệt trong trang Admin.',
        ].join('\n');
        this._sendToTelegramBots(msg);
    },

    sendTelegramChatNotification: function (username, message) {
        const msg = [
            '💬 <b>TIN NHẮN MỚI TỪ KHÁCH HÀNG!</b>',
            '━━━━━━━━━━━━━━━━━━━━',
            `👤 <b>Khách hàng:</b> <code>${username}</code>`,
            `💬 <b>Nội dung:</b> ${message.substring(0, 200)}${message.length > 200 ? '...' : ''}`,
            `🕐 <b>Thời gian:</b> ${new Date().toLocaleString('vi-VN')}`,
            '━━━━━━━━━━━━━━━━━━━━',
            '👉 Vào Admin → Chat để trả lời.',
        ].join('\n');
        this._sendToTelegramBots(msg);
    },

    formatInventoryDelivery: function (accounts) {
        const cleanAccounts = (accounts || []).map(item => String(item || '').trim()).filter(Boolean);
        if (cleanAccounts.length <= 1) return cleanAccounts[0] || '';
        return cleanAccounts.map((item, index) => `[${index + 1}] ${item}`).join('\n');
    },

    fulfillInventoryOrder: async function ({ product, orderId, username, quantity }) {
        const inventoryRef = db.ref(`productInventory/${product.id}`);
        let allocatedAccounts = [];
        const transactionResult = await inventoryRef.transaction(current => {
            const allocation = this.prepareInventoryAllocation(current, orderId, username, quantity);
            allocatedAccounts = allocation.accounts;
            return allocation.state;
        });

        if (!transactionResult.committed) {
            const error = new Error('Kho thực tế không còn đủ tài khoản.');
            error.code = 'INSUFFICIENT_INVENTORY';
            throw error;
        }

        const inventoryState = transactionResult.snapshot.val() || {};
        const delivery = inventoryState.deliveries?.[orderId] || {};
        const deliveredAccounts = delivery.accounts
            ? this.normalizeDeliveredAccounts(delivery.accounts)
            : allocatedAccounts;
        if (deliveredAccounts.length < quantity) throw new Error('Phiếu giao hàng không đủ số lượng.');

        const accountDetails = this.formatInventoryDelivery(deliveredAccounts);
        const remainingCount = this.normalizeInventoryItems({ items: inventoryState.items }).length;
        await db.ref().update({
            [`orders/${orderId}/status`]: 'Hoàn thành',
            [`orders/${orderId}/accountDetails`]: accountDetails,
            [`orders/${orderId}/deliveredAccounts`]: deliveredAccounts,
            [`orders/${orderId}/autoFulfilled`]: true,
            [`orders/${orderId}/fulfillmentSource`]: 'inventory',
            [`orders/${orderId}/deliveredQuantity`]: deliveredAccounts.length,
            [`orders/${orderId}/fulfilledAt`]: firebase.database.ServerValue.TIMESTAMP,
            [`products/${product.id}/quantity`]: remainingCount
        });
        return { accountDetails, remainingCount, deliveredAccounts };
    },

    refundInventoryOrder: async function ({ orderId, username, amount, message, productId }) {
        const orderResult = await db.ref(`orders/${orderId}`).transaction(order => {
            if (!order || order.status === 'Hoàn thành' || order.refundedAt) return;
            return {
                ...order,
                status: 'Hủy - Đã hoàn tiền',
                accountDetails: message,
                refundedAt: Date.now(),
                refundedAmount: amount,
                refundedBy: 'inventory-fulfill'
            };
        });
        if (orderResult.committed) {
            await db.ref(`users/${username}/balance`).transaction(balance =>
                Number(balance || 0) + Number(amount || 0)
            );
        }

        if (orderResult.committed && productId) {
            try {
                await db.ref(`productInventory/${productId}`).transaction(current => {
                    if (!current?.deliveries?.[orderId]) return current;
                    const delivery = current.deliveries[orderId];
                    const returnedAccounts = this.normalizeDeliveredAccounts(delivery.accounts);
                    const existingItems = this.normalizeInventoryItems({ items: current.items });
                    const existingValues = new Set(existingItems.map(item => item.value));
                    const restoredItems = [...existingItems];

                    returnedAccounts.forEach((value, index) => {
                        if (!existingValues.has(value)) {
                            restoredItems.push({
                                key: '',
                                value,
                                createdAt: Date.now() + index
                            });
                            existingValues.add(value);
                        }
                    });

                    const deliveries = { ...(current.deliveries || {}) };
                    delete deliveries[orderId];
                    return {
                        ...current,
                        items: this.buildInventoryItemsMap(restoredItems),
                        deliveries: Object.keys(deliveries).length > 0 ? deliveries : null
                    };
                });
            } catch (restoreError) {
                console.error('Không thể hoàn tài khoản về kho:', restoreError);
            }
        }

        if (productId) {
            const inventorySnapshot = await db.ref(`productInventory/${productId}/items`).once('value');
            const remainingCount = this.normalizeInventoryItems({ items: inventorySnapshot.val() }).length;
            await db.ref(`products/${productId}/quantity`).set(remainingCount);
        }
        return orderResult.committed;
    },

    refundManualOrder: async function ({ orderId, username, amount, message }) {
        const orderResult = await db.ref(`orders/${orderId}`).transaction(order => {
            if (!order || order.status === 'Hoàn thành' || order.refundedAt) return;
            return {
                ...order,
                status: 'Hủy - Đã hoàn tiền',
                accountDetails: message,
                refundedAt: Date.now(),
                refundedAmount: amount,
                refundedBy: 'manual-stock-check'
            };
        });
        if (orderResult.committed) {
            await db.ref(`users/${username}/balance`).transaction(balance =>
                Number(balance || 0) + Number(amount || 0)
            );
        }
        return orderResult.committed;
    },

    payWithBalance: async function () {
        if (!db || !this.appState.currentUser) return;
        const product = this.appState.cartItem;
        const currentBal = this.appState.currentUser.balance || 0;
        const totalAmount = product.totalAmount || (product.price * (product.buyQuantity || 1));

        if (currentBal < totalAmount) {
            this.showToast(`Số dư không đủ! Cần thêm ${this.formatMoney(totalAmount - currentBal)}.`);
            return;
        }

        if (!confirm(`Thanh toán ${this.formatMoney(totalAmount)} bằng số dư? Số dư còn lại sẽ là ${this.formatMoney(currentBal - totalAmount)}.`)) return;

        const loading = document.getElementById('loading');
        loading.classList.remove('hidden');
        const orderId = product.tempOrderId;
        const username = this.appState.currentUser.username;
        const buyQty = product.buyQuantity || 1;
        const hasAutoFulfill = this.isAutoProduct(product);
        let balanceDebited = false;
        let orderCreated = false;
        let shouldNotifyOrder = true;

        try {
            const balanceResult = await db.ref('users/' + username + '/balance').transaction(balance => {
                const latestBalance = Number(balance || 0);
                if (latestBalance < totalAmount) return;
                return latestBalance - totalAmount;
            });
            if (!balanceResult.committed) throw new Error('Số dư vừa thay đổi và không còn đủ để thanh toán.');
            balanceDebited = true;

            const now = new Date();
            const dateStr = now.toLocaleDateString('vi-VN') + ' ' + now.toLocaleTimeString('vi-VN');
            const newOrder = {
                username,
                productId: product.id,
                productName: `${product.name} (x${buyQty})`,
                quantity: buyQty,
                duration: product.duration || '',
                productFormat: product.format || '',
                price: totalAmount,
                date: dateStr,
                timestamp: Date.now(),
                purchasedAt: Date.now(),
                purchasedAtDisplay: dateStr,
                warranty: this.getWarrantyText(product),
                warrantyDays: Number(product.warrantyDays || 0),
                deliveryMode: hasAutoFulfill ? 'inventory' : 'manual',
                status: hasAutoFulfill ? 'Đang xử lý tự động...' : 'Đang giao',
                accountDetails: hasAutoFulfill
                    ? 'Hệ thống đang lấy tài khoản từ kho nội bộ...'
                    : 'Đã thanh toán bằng ví. Đang chờ admin duyệt và cấp tài khoản thủ công...'
            };
            await db.ref('orders/' + orderId).set(newOrder);
            orderCreated = true;

            if (hasAutoFulfill) {
                try {
                    await this.fulfillInventoryOrder({ product, orderId, username, quantity: buyQty });
                    this.showToast('Giao hàng tự động thành công! Tài khoản đã có trong lịch sử đơn.', 'success');
                } catch (fulfillError) {
                    const message = fulfillError.code === 'INSUFFICIENT_INVENTORY'
                        ? 'Kho thực tế không đủ tài khoản. Đơn đã được hủy và hoàn tiền tự động.'
                        : 'Không thể giao tài khoản tự động. Đơn đã được hủy và hoàn tiền.';
                    await this.refundInventoryOrder({
                        orderId,
                        username,
                        amount: totalAmount,
                        message,
                        productId: product.id
                    });
                    shouldNotifyOrder = false;
                    this.showToast(message, 'warning');
                }
            } else {
                const stockResult = await db.ref(`products/${product.id}/quantity`).transaction(stock => {
                    const latestStock = Number(stock || 0);
                    if (latestStock < buyQty) return;
                    return latestStock - buyQty;
                });
                if (!stockResult.committed) {
                    const message = 'Sản phẩm vừa hết hàng. Đơn đã được hủy và hoàn tiền tự động.';
                    await this.refundManualOrder({
                        orderId,
                        username,
                        amount: totalAmount,
                        message
                    });
                    shouldNotifyOrder = false;
                    this.showToast(message, 'warning');
                } else {
                    this.showToast('Thanh toán thành công! Vui lòng chờ admin cấp tài khoản.');
                }
            }

            if (shouldNotifyOrder) {
                this.sendTelegramOrderNotification({
                    orderId,
                    username,
                    productName: product.name,
                    quantity: buyQty,
                    priceDisplay: this.formatMoney(totalAmount),
                    date: dateStr
                });
            }
            this.appState.cartItem = null;
            loading.classList.add('hidden');
            this.navigate('dashboard');
        } catch (error) {
            if (balanceDebited && !orderCreated) {
                await db.ref(`users/${username}/balance`).transaction(balance =>
                    Number(balance || 0) + Number(totalAmount || 0)
                );
            }
            loading.classList.add('hidden');
            this.showToast('Lỗi: ' + error.message, 'error');
        }
    },

    validateDepositAmount: function () {
        const amount = parseInt(document.getElementById('deposit-amount-input').value);
        const btn = document.getElementById('btn-confirm-deposit');
        const warn = document.getElementById('deposit-min-warning');
        document.querySelectorAll('.deposit-quick-btn').forEach(quickBtn => {
            quickBtn.classList.toggle('active', Number(quickBtn.dataset.amount) === Number(amount));
        });

        if (amount && amount < 10000) {
            if (warn) warn.style.display = 'block';
        } else {
            if (warn) warn.style.display = 'none';
        }

        if (!amount || amount < 10000) {
            btn.disabled = true;
        } else {
            btn.disabled = false;
        }
    },

    setDepositAmount: function (amount) {
        const input = document.getElementById('deposit-amount-input');
        if (!input) return;
        input.value = amount;
        document.querySelectorAll('.deposit-quick-btn').forEach(btn => {
            btn.classList.toggle('active', Number(btn.dataset.amount) === Number(amount));
        });
        this.validateDepositAmount();
    },

    getDepositExpiry: function (deposit) {
        return Number(deposit.expiresAt || 0) || (Number(deposit.timestamp || 0) + this.DEPOSIT_EXPIRE_MS);
    },

    formatDuration: function (ms) {
        const total = Math.max(0, Math.floor(ms / 1000));
        const minutes = Math.floor(total / 60).toString().padStart(2, '0');
        const seconds = (total % 60).toString().padStart(2, '0');
        return `${minutes}:${seconds}`;
    },

    startDepositCountdown: function (expiresAt, memo) {
        clearInterval(this.depositCountdownTimer);
        const box = document.getElementById('deposit-countdown-box');
        const value = document.getElementById('deposit-countdown-value');
        if (!box || !value || !expiresAt) return;

        box.classList.remove('hidden');
        const tick = () => {
            const left = expiresAt - Date.now();
            value.textContent = this.formatDuration(left);
            box.classList.toggle('is-expiring', left <= 2 * 60 * 1000);
            if (left <= 0) {
                clearInterval(this.depositCountdownTimer);
                value.textContent = '00:00';
                this.expireDepositIfNeeded(memo);
            }
        };
        tick();
        this.depositCountdownTimer = setInterval(tick, 1000);
    },

    expireDepositIfNeeded: function (memo) {
        if (!db || !memo) return;
        db.ref('deposit_requests/' + memo).once('value').then(snapshot => {
            const deposit = snapshot.val();
            if (!deposit || deposit.status !== 'Chờ duyệt') return null;
            const expiresAt = this.getDepositExpiry(deposit);
            if (Date.now() < expiresAt) return null;
            return db.ref('deposit_requests/' + memo).update({
                status: 'Hết hạn',
                expiredAt: Date.now()
            });
        }).then(result => {
            if (result !== null && this.appState.currentDepositMemo === memo) {
                this.showToast('Đơn nạp đã hết hạn. Vui lòng tạo yêu cầu mới.', 'warning');
                this.resetDeposit();
            }
        }).catch(err => console.warn('Expire deposit failed:', err));
    },

    createDepositRequest: function () {
        if (!db) {
            this.showToast("Lỗi: Không thể gửi yêu cầu do lỗi Firebase!", 'error');
            return;
        }

        const amount = parseInt(document.getElementById('deposit-amount-input').value);
        if (!amount || amount < 10000) return;

        const loading = document.getElementById('loading');
        loading.classList.remove('hidden');

        const orderId = 'NAP' + Math.floor(Date.now() / 1000).toString().slice(-5) + Math.floor(Math.random() * 90 + 10);

        this.appState.currentDepositMemo = orderId;
        this.appState.currentDepositAmount = amount;
        this.appState.currentDepositExpiresAt = Date.now() + this.DEPOSIT_EXPIRE_MS;

        const newReq = {
            username: this.appState.currentUser.username,
            amount: amount,
            memo: orderId,
            timestamp: Date.now(),
            expiresAt: this.appState.currentDepositExpiresAt,
            date: new Date().toLocaleDateString('vi-VN') + ' ' + new Date().toLocaleTimeString('vi-VN'),
            status: 'Chờ duyệt'
        };

        db.ref('deposit_requests/' + orderId).set(newReq).then(() => {
            loading.classList.add('hidden');
            this.sendTelegramDepositNotification({
                username: this.appState.currentUser.username,
                amountDisplay: this.formatMoney(amount),
                memo: orderId,
                date: newReq.date
            });
            document.getElementById('deposit-amount-input').value = '';
            this.updateDepositQR();
        }).catch(err => {
            loading.classList.add('hidden');
            this.showToast("Lỗi: " + err.message);
        });
    },

    updateDepositQR: function () {
        const orderId = this.appState.currentDepositMemo;
        const amount = this.appState.currentDepositAmount;
        if (!orderId || !amount) return;

        document.getElementById('deposit-input-group').style.display = 'none';
        document.getElementById('deposit-action-group').style.display = 'none';

        document.getElementById('deposit-memo-group').style.display = 'flex';
        document.getElementById('deposit-content').innerText = orderId;

        document.getElementById('deposit-amount-display-group').style.display = 'flex';
        document.getElementById('deposit-amount-display').innerText = this.formatMoney(amount);
        this.startDepositCountdown(this.appState.currentDepositExpiresAt, orderId);

        const qrContainer = document.getElementById('deposit-qr-container');
        const qrImg = document.getElementById('deposit-qr-img');
        const qrLoading = document.getElementById('deposit-qr-loading');
        const qrEmpty = document.getElementById('qr-empty-state');

        if (qrEmpty) qrEmpty.style.display = 'none';
        qrContainer.style.display = 'flex';
        qrImg.style.display = 'none';
        qrLoading.style.display = 'flex';

        const bankId = 'MB';
        const accountNo = '346641789567';
        const accountName = 'VU VAN CUONG';

        const qrUrl = `https://img.vietqr.io/image/${bankId}-${accountNo}-qr_only.png?amount=${amount}&addInfo=${orderId}&accountName=${encodeURIComponent(accountName)}`;

        qrImg.onload = () => {
            qrLoading.style.display = 'none';
            qrImg.style.display = 'block';
            this.initTiltEffects(qrContainer);
        };

        qrImg.onerror = () => {
            qrLoading.innerHTML = '<p style="color: red; background: rgba(0,0,0,0.7); padding: 5px; border-radius: 5px;">Lỗi tạo QR</p>';
        };

        qrImg.src = qrUrl;
    },

    resetDeposit: function () {
        this.appState.currentDepositMemo = null;
        this.appState.currentDepositAmount = 0;
        this.appState.currentDepositExpiresAt = 0;
        clearInterval(this.depositCountdownTimer);

        document.getElementById('deposit-input-group').style.display = 'block';
        document.getElementById('deposit-action-group').style.display = 'flex';
        document.getElementById('deposit-memo-group').style.display = 'none';
        document.getElementById('deposit-amount-display-group').style.display = 'none';
        document.getElementById('deposit-qr-container').style.display = 'none';
        document.getElementById('deposit-amount-input').value = '';
        const countdown = document.getElementById('deposit-countdown-box');
        if (countdown) countdown.classList.add('hidden');

        const qrEmpty = document.getElementById('qr-empty-state');
        if (qrEmpty) qrEmpty.style.display = 'flex';

        const btn = document.getElementById('btn-confirm-deposit');
        if (btn) btn.disabled = true;
        document.querySelectorAll('.deposit-quick-btn').forEach(quickBtn => quickBtn.classList.remove('active'));
    },

    // Dashboard
    renderDashboard: function () {

        // Cập nhật email
        const emailInput = document.getElementById('profile-email');
        if (emailInput && this.appState.currentUser) {
            emailInput.value = this.appState.currentUser.email || '';
        }

        // --- Orders (Lịch sử mua hàng) ---
        const list = document.getElementById('orders-list');
        const noMsg = document.getElementById('no-orders-msg');
        if (list && noMsg) {
            if (this.appState.orders.length === 0) {
                list.parentElement.parentElement.classList.add('hidden');
                noMsg.classList.remove('hidden');
            } else {
                list.parentElement.parentElement.classList.remove('hidden');
                noMsg.classList.add('hidden');
                this.renderPaginatedTable('orders-list', 'dash-orders', this.appState.orders, (o, idx) => {
                    const normalizedStatus = this.normalizeText(o.status || '');
                    const isPending = normalizedStatus.includes('cho duyet') || normalizedStatus.includes('dang');
                    const isRefunded = normalizedStatus.includes('hoan tien') || normalizedStatus.includes('huy');
                    const statusClass = isRefunded ? 'status-cancelled' : (isPending ? 'status-pending' : 'status-completed');
                    const statusIcon = isRefunded ? 'fas fa-rotate-left' : (isPending ? 'fas fa-clock' : 'fas fa-check');
                    const safeOrderId = encodeURIComponent(String(o.id || ''));
                    const deliveredCount = this.getOrderDeliveredAccounts(o).length;
                    const accountAction = deliveredCount > 0
                        ? `<button class="order-account-action has-account" onclick="app.openAccountDeliveryModal(decodeURIComponent('${safeOrderId}'))"><i class="fas fa-key"></i> Xem ${deliveredCount} tài khoản</button>`
                        : `<button class="order-account-action" onclick="app.openAccountDeliveryModal(decodeURIComponent('${safeOrderId}'))"><i class="fas fa-route"></i> Theo dõi đơn</button>`;
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td style="color:var(--text-muted);font-weight:600;">${idx}</td>
                        <td class="font-bold">#${o.id}</td>
                        <td>${this.escapeHtml(o.productName || '-')}</td>
                        <td><span class="order-duration"><i class="fas fa-clock"></i> ${this.escapeHtml(this.getOrderDurationText(o))}</span></td>
                        <td><span class="order-price">${this.formatMoney(o.price || 0)}</span></td>
                        <td>${o.purchasedAtDisplay || o.date || (o.timestamp ? new Date(o.timestamp).toLocaleString('vi-VN') : '-')}</td>
                        <td>${o.warranty || 'Không bảo hành'}</td>
                        <td><span class="status-badge ${statusClass}"><i class="${statusIcon}"></i> ${o.status}</span>${this.renderOrderTimeline(o, true)}</td>
                        <td>${accountAction}</td>
                    `;
                    return tr;
                }, 'pagbar-orders');
            }
        }

        // --- OTP History ---
        const otpList = document.getElementById('otp-history-list');
        const noOtpMsg = document.getElementById('no-otp-history-msg');
        if (otpList && noOtpMsg) {
            if (!this.appState.otpHistory || this.appState.otpHistory.length === 0) {
                otpList.parentElement.parentElement.classList.add('hidden');
                noOtpMsg.classList.remove('hidden');
            } else {
                otpList.parentElement.parentElement.classList.remove('hidden');
                noOtpMsg.classList.add('hidden');
                this.renderPaginatedTable('otp-history-list', 'dash-otp', this.appState.otpHistory, (h, idx) => {
                    const isSuccess = h.status.includes('Thành công');
                    const isRefunded = h.status.toLowerCase().includes('hoàn tiền') || h.status.toLowerCase().includes('hủy');
                    let statusClass = 'status-pending';
                    if (isSuccess) statusClass = 'status-completed';
                    if (isRefunded) statusClass = 'status-cancelled';
                    const dispPhone = this.normalizeVietnamPhone(h.phone);
                    const phoneClass = this.isValidVietnamPhone(dispPhone) ? 'text-gradient' : '';
                    const phoneStyle = phoneClass ? '' : ' style="color:var(--danger)"';
                    const isPendingStatus = h.status === 'Đang chờ mã';
                    const hasPhone = this.isValidVietnamPhone(this.normalizeVietnamPhone(h.phone));
                    let rebuyBtn;
                    if (isPendingStatus) {
                        rebuyBtn = `<button class="btn-outline btn-rebuy-otp" style="border-color:#6366f1;color:#6366f1;" onclick="app.rebuyOTP(${Number(h.appId)},'${String(h.appName).replace(/'/g,"\\'")}','${String(h.phone).replace(/'/g,"\\'")}','${String(h.id || '').replace(/'/g,"\\'")}')"><i class="fas fa-sync"></i> Xem</button>`;
                    } else if (hasPhone) {
                        rebuyBtn = `<button class="btn-outline btn-rebuy-otp" onclick="app.rebuyOTP(${Number(h.appId)},'${String(h.appName).replace(/'/g,"\\'")}','${String(h.phone).replace(/'/g,"\\'")}')"><i class="fas fa-redo"></i> Mua lại</button>`;
                    } else {
                        rebuyBtn = '<span style="color:var(--text-muted);">-</span>';
                    }
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td style="color:var(--text-muted);font-weight:600;">${idx}</td>
                        <td>${h.date}</td>
                        <td class="font-bold">${h.appName}</td>
                        <td><span class="${phoneClass}"${phoneStyle}>${dispPhone || '-'}</span></td>
                        <td>${this.formatMoney(h.price)}</td>
                        <td><span class="status-badge ${statusClass}">${h.status}</span></td>
                        <td><span class="font-bold" style="color:${isSuccess ? '#00ff00' : 'var(--text-muted)'}">${h.code || '-'}</span></td>
                        <td>${rebuyBtn}</td>
                    `;
                    return tr;
                }, 'pagbar-otp');
            }
        }

        // --- Deposit History ---
        const depList = document.getElementById('deposit-history-list');
        const noDepMsg = document.getElementById('no-deposit-history-msg');
        if (depList && noDepMsg) {
            if (!this.appState.depositHistory || this.appState.depositHistory.length === 0) {
                depList.parentElement.parentElement.classList.add('hidden');
                noDepMsg.classList.remove('hidden');
            } else {
                depList.parentElement.parentElement.classList.remove('hidden');
                noDepMsg.classList.add('hidden');
                this.renderPaginatedTable('deposit-history-list', 'dash-deposits', this.appState.depositHistory, (d, idx) => {
                    const isPending = d.status === 'Chờ duyệt';
                    const isCancelled = this.normalizeText(d.status).includes('huy');
                    const isExpired = this.normalizeText(d.status).includes('het han');
                    let statusClass = isPending ? 'status-pending' : 'status-completed';
                    if (isCancelled || isExpired) statusClass = 'status-cancelled';
                    let statusIcon = isPending ? 'fas fa-clock' : 'fas fa-check';
                    if (isCancelled || isExpired) statusIcon = 'fas fa-times-circle';
                    const memo = this.escapeHtml(d.memo || '');
                    const timeLeft = this.getDepositExpiry(d) - Date.now();
                    const expireInfo = isPending
                        ? `<br><small class="deposit-expire-note">Hết hạn sau ${this.formatDuration(timeLeft)}</small>`
                        : '';
                    const cancelAction = isPending
                        ? `<button class="btn-outline btn-cancel-deposit" onclick="app.cancelDepositRequest('${String(d.memo || '').replace(/'/g, "\\'")}')"><i class="fas fa-times"></i> Hủy</button>`
                        : '<span style="color:var(--text-muted);">-</span>';
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td style="color:var(--text-muted);font-weight:600;">${idx}</td>
                        <td>${d.date || '-'}</td>
                        <td class="font-bold text-gradient">${memo}</td>
                        <td>${this.formatMoney(d.amount)}</td>
                        <td><span class="status-badge ${statusClass}"><i class="${statusIcon}"></i> ${this.escapeHtml(d.status)}</span>${expireInfo}</td>
                        <td>${cancelAction}</td>
                    `;
                    return tr;
                }, 'pagbar-deposits');
            }
        }
    },

    cancelDepositRequest: function (memo) {
        if (!db || !this.appState.currentUser || !memo) return;
        const deposit = this.appState.depositHistory.find(d => d.memo === memo);
        if (!deposit) {
            this.showToast('Không tìm thấy đơn nạp này.', 'error');
            return;
        }
        if (deposit.username && deposit.username !== this.appState.currentUser.username) {
            this.showToast('Bạn không có quyền hủy đơn nạp này.', 'error');
            return;
        }
        if (deposit.status !== 'Chờ duyệt') {
            this.showToast('Chỉ có thể hủy đơn đang chờ duyệt.', 'warning');
            return;
        }
        if (!confirm(`Bạn có chắc muốn hủy đơn nạp ${memo}?`)) return;

        const loading = document.getElementById('loading');
        if (loading) loading.classList.remove('hidden');

        db.ref('deposit_requests/' + memo).update({
            status: 'Người dùng đã hủy',
            cancelledAt: Date.now(),
            cancelledBy: this.appState.currentUser.username
        }).then(() => {
            if (this.appState.currentDepositMemo === memo) {
                this.resetDeposit();
            }
            this.showToast('Đã hủy đơn nạp.');
        }).catch(error => {
            this.showToast('Lỗi hủy đơn nạp: ' + error.message, 'error');
        }).finally(() => {
            if (loading) loading.classList.add('hidden');
        });
    },

    updateProfileEmail: function () {
        if (!this.appState.currentUser || !db) return;

        const newEmail = document.getElementById('profile-email').value.trim();
        const username = this.appState.currentUser.username;

        if (!newEmail) {
            this.showToast("Vui lòng nhập địa chỉ email hợp lệ!", 'warning');
            return;
        }

        // Update Firebase
        db.ref('users/' + username).update({ email: newEmail }).then(() => {
            // Update local state
            this.appState.currentUser.email = newEmail;
            localStorage.setItem('accstore_user', JSON.stringify(this.appState.currentUser));
            this.updateHeaderUserIdentity(this.appState.currentUser);

            this.showToast("Đã cập nhật email bảo mật thành công!");
        }).catch(error => {
            this.showToast("Lỗi cập nhật email: " + error.message);
        });
    },

    // Admin
    renderAdmin: function () {
        if (this.isProviderDemoMode()) {
            const providerButton = document.querySelector('.admin-tab-btn[data-admin-tab="providers"]');
            this.switchAdminTab('providers', providerButton);
            return;
        }
        this.loadAdminChatUsers();
        this.renderAdminChart();
        this.renderAdminUsers();
        this.renderAdminProducts();
        this.renderAdminInventoryCenter();
        this.renderAdminStats();
        this.renderAdminFilterControls();

        const hasActivePanel = document.querySelector('.admin-tab-panel.active');
        if (!hasActivePanel) {
            const firstPanel = document.getElementById('admin-tab-overview');
            const firstBtn = document.querySelector('.admin-tab-btn');
            if (firstPanel) firstPanel.classList.add('active');
            if (firstBtn) firstBtn.classList.add('active');
        }

        const list = document.getElementById('admin-orders-list');
        const noMsg = document.getElementById('admin-no-orders-msg');
        if (!list || !noMsg) return;

        const filteredOrders = this.filterAdminOrders();
        if (filteredOrders.length === 0) {
            list.innerHTML = '';
            const pag = document.getElementById('pagbar-admin-orders');
            if (pag) pag.innerHTML = '';
            list.parentElement.parentElement.classList.remove('hidden');
            noMsg.classList.remove('hidden');
        } else {
            list.parentElement.parentElement.classList.remove('hidden');
            noMsg.classList.add('hidden');
            this.renderPaginatedTable('admin-orders-list', 'admin-orders', filteredOrders, (o) => {
                const normalizedStatus = this.normalizeText(o.status || '');
                const isPending = normalizedStatus.includes('cho duyet') || normalizedStatus.includes('dang');
                const isRefunded = normalizedStatus.includes('hoan tien') || normalizedStatus.includes('huy');
                const statusClass = isRefunded ? 'status-cancelled' : (isPending ? 'status-pending' : 'status-completed');
                const statusIcon = isRefunded ? 'fas fa-rotate-left' : (isPending ? 'fas fa-clock' : 'fas fa-check');
                const tr = document.createElement('tr');
                const safeId = String(o.id).replace(/'/g, "\\'");
                const safeUsername = String(o.username || '').replace(/'/g, "\\'");
                const safeStatus = this.escapeHtml(o.status || '');
                const note = this.escapeHtml(o.adminNote || '');
                tr.innerHTML = `
                    <td class="font-bold">#${o.id}</td>
                    <td style="color:var(--accent);font-weight:500;">${o.username}</td>
                    <td>${this.escapeHtml(o.productName || '-')}</td>
                        <td><span class="order-duration"><i class="fas fa-clock"></i> ${this.escapeHtml(this.getOrderDurationText(o))}</span></td>
                        <td><span class="order-price">${this.formatMoney(o.price || 0)}</span></td>
                        <td>${o.purchasedAtDisplay || o.date || (o.timestamp ? new Date(o.timestamp).toLocaleString('vi-VN') : '-')}</td>
                    <td>${o.warranty || 'Không bảo hành'}</td>
                    <td><span class="status-badge ${statusClass}"><i class="${statusIcon}"></i> ${o.status}</span></td>
                    <td>
                        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
                            <input type="text" id="admin-status-${o.id}" value="${safeStatus}" placeholder="Trạng thái đơn" style="flex:1;min-width:150px;padding:8px;border-radius:6px;background:rgba(0,0,0,0.3);border:1px solid var(--card-border);color:white;">
                            <button class="btn-outline" style="padding:8px 12px;" onclick="app.adminUpdateOrderStatus('${safeId}')">Lưu trạng thái</button>
                        </div>
                        <textarea id="admin-note-${o.id}" placeholder="Ghi chú nội bộ của admin" rows="2" style="width:100%;padding:8px;border-radius:6px;background:rgba(0,0,0,0.3);border:1px solid var(--card-border);color:white;margin-bottom:8px;">${note}</textarea>
                        <button class="btn-outline" style="padding:7px 12px;margin-bottom:8px;" onclick="app.adminSaveOrderNote('${safeId}')">Lưu ghi chú</button>
                        ${isPending ? `
                        <div style="display:flex;gap:10px;flex-wrap:wrap;">
                            <textarea id="admin-input-${o.id}" rows="3" placeholder="Mỗi dòng là một tài khoản, ví dụ: email | mật khẩu | mã khôi phục" style="flex-grow:1;min-width:180px;padding:8px;border-radius:6px;background:rgba(0,0,0,0.3);border:1px solid var(--card-border);color:white;"></textarea>
                            <button class="btn-primary" style="padding:8px 15px;" onclick="app.adminApproveOrder('${safeId}')">Gửi</button>
                            <button class="btn-outline" style="padding:8px 15px;border-color:var(--danger);color:var(--danger);" onclick="app.adminRefundOrder('${safeId}','${safeUsername}',${o.price || 0})">Hoàn tiền</button>
                        </div>` : `<button class="order-account-action has-account" onclick="app.openAccountDeliveryModal('${safeId}')"><i class="fas fa-key"></i> Xem tài khoản đã giao</button>`}
                    </td>
                `;
                return tr;
            }, 'pagbar-admin-orders');
        }

        // Render Deposits
        const depList = document.getElementById('admin-deposits-list');
        const noDepMsg = document.getElementById('admin-no-deposits-msg');
        if (depList && noDepMsg) {
            const pendingDeps = this.filterAdminDeposits(this.appState.allDeposits.filter(d => d.status === 'Chờ duyệt'));
            if (pendingDeps.length === 0) {
                depList.innerHTML = '';
                const pag = document.getElementById('pagbar-admin-deposits');
                if (pag) pag.innerHTML = '';
                depList.parentElement.parentElement.classList.remove('hidden');
                noDepMsg.classList.remove('hidden');
            } else {
                depList.parentElement.parentElement.classList.remove('hidden');
                noDepMsg.classList.add('hidden');
                this.renderPaginatedTable('admin-deposits-list', 'admin-deposits', pendingDeps, (d) => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td class="font-bold">#${d.memo}</td>
                        <td style="color:var(--accent);font-weight:500;">${d.username}</td>
                        <td class="text-price font-bold">${this.formatMoney(d.amount)}</td>
                        <td><code>${d.memo}</code></td>
                        <td>
                            <button class="btn-primary" style="padding:5px 10px;font-size:0.8rem;" onclick="app.adminApproveDeposit('${d.memo}','${d.username}',${d.amount})">Duyệt Cộng Tiền</button>
                            <button class="btn-outline" style="padding:5px 10px;font-size:0.8rem;margin-top:5px;" onclick="app.adminRejectDeposit('${d.memo}')">Hủy</button>
                        </td>
                    `;
                    return tr;
                }, 'pagbar-admin-deposits');
            }
        }
    },

    adminApproveOrder: async function (orderId) {
        if (!db) return;

        const inputVal = document.getElementById('admin-input-' + orderId)?.value || '';
        const deliveredAccounts = inputVal.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        if (deliveredAccounts.length === 0) {
            this.showToast('Vui lòng nhập thông tin tài khoản để cấp phát!');
            return;
        }

        const order = (this.appState.allOrders || []).find(item => String(item.id) === String(orderId));
        const expectedQuantity = Math.max(1, Number(order?.quantity || 1));
        if (deliveredAccounts.length !== expectedQuantity) {
            this.showToast(`Đơn cần đúng ${expectedQuantity} tài khoản, hiện đã nhập ${deliveredAccounts.length}.`, 'warning');
            return;
        }

        try {
            await db.ref('orders/' + orderId).update({
                status: 'Hoàn thành',
                accountDetails: this.formatInventoryDelivery(deliveredAccounts),
                deliveredAccounts,
                deliveredQuantity: deliveredAccounts.length,
                fulfilledAt: Date.now(),
                fulfillmentSource: 'admin'
            });
            this.showToast('Đã cấp phát tài khoản thành công!');
        } catch (error) {
            this.showToast("Lỗi: " + error.message);
        }
    },
    adminApproveDeposit: function (memo, username, amount) {
        if (!db) return;
        amount = Number(amount);
        if (!confirm(`Xác nhận cộng ${this.formatMoney(amount)} cho user ${username}?`)) return;

        const depositBonus = this.appState.events ? Number(this.appState.events.depositBonusPercent || 0) : 0;
        const extraAmount = Math.floor(amount * (depositBonus / 100));
        const finalAmountToUser = amount + extraAmount;

        db.ref('deposit_requests/' + memo).transaction(req => {
            if (!req || String(req.status || '').toLowerCase().includes('hoàn thành') || req.approvedAt) return;
            return {
                ...req,
                status: 'Hoàn thành',
                approvedAt: Date.now(),
                approvedBy: this.appState.currentUser ? this.appState.currentUser.username : 'admin'
            };
        }).then(result => {
            if (!result.committed) throw new Error('Đơn nạp này đã được duyệt hoặc không còn tồn tại.');

            return this.adjustUserBalanceBy(username, finalAmountToUser).then(() => {
                this.showToast(`Đã duyệt nạp tiền cho ${username} (Cộng ${this.formatMoney(finalAmountToUser)})`);
            });
        }).catch(error => {
            this.showToast('Lỗi: ' + error.message);
        });
    },

    // ---- KÉT API NHÀ CUNG CẤP (mã hóa tại Netlify, Firebase chỉ giữ ciphertext) ----
    isProviderDemoMode: function () {
        return this.providerAdminState.demoMode === true;
    },

    openProviderDemoPreview: function () {
        if (!this.isProviderDemoMode()) return;
        this.appState.currentUser = { username: 'admin', sessionVersion: 0, demoPreview: true };
        document.body.classList.add('provider-demo-active');
        this.navigate('admin', false);
    },

    getProviderDemoSources: function () {
        const now = Date.now();
        return [
            {
                id: 'demo_nnmshop',
                type: 'nnmshop',
                providerName: 'NNM Shop',
                label: 'NNM — nguồn chính',
                enabled: true,
                keyMask: '••••8K2M',
                balance: 1250000,
                balanceDisplay: '1.250.000đ',
                lastTestOk: true,
                lastTestAt: now - (4 * 60 * 1000),
                createdAt: now - 86400000,
                updatedAt: now - (4 * 60 * 1000)
            },
            {
                id: 'demo_nastele',
                type: 'nastele',
                providerName: 'Shop Hân Nguyễn',
                label: 'Hân Nguyễn — nguồn dự phòng',
                enabled: true,
                keyMask: '••••P7QX',
                balance: 845000,
                balanceDisplay: '845.000đ',
                lastTestOk: true,
                lastTestAt: now - (11 * 60 * 1000),
                createdAt: now - 43200000,
                updatedAt: now - (11 * 60 * 1000)
            },
            {
                id: 'demo_nanlux',
                type: 'nanlux',
                providerName: 'MMO NanLux',
                label: 'NanLux — nguồn bổ sung',
                enabled: true,
                keyMask: '••••NLUX',
                balance: 737000,
                balanceDisplay: '737.000đ',
                lastTestOk: true,
                lastTestAt: now - (7 * 60 * 1000),
                createdAt: now - 21600000,
                updatedAt: now - (7 * 60 * 1000)
            },
            {
                id: 'demo_tunvn',
                type: 'tunvn',
                providerName: 'TunVN PreHub',
                label: 'TunVN — nguồn bổ sung',
                enabled: true,
                keyMask: '••••TUNV',
                balance: 562000,
                balanceDisplay: '562.000đ',
                lastTestOk: true,
                lastTestAt: now - (9 * 60 * 1000),
                createdAt: now - 10800000,
                updatedAt: now - (9 * 60 * 1000)
            }
        ];
    },

    getProviderDemoProducts: function (providerType) {
        if (providerType === 'tunvn') {
            return [
                { id: '85', name: 'Telegram Việt Nam 2FA', price: 17000, stock: 118 },
                { id: '91', name: 'Gmail Việt Nam trust cao', price: 11500, stock: 204 },
                { id: '97', name: 'Facebook Việt Nam', price: 39000, stock: 35 },
                { id: '104', name: 'Outlook US', price: 14500, stock: 86 }
            ];
        }
        if (providerType === 'nanlux') {
            return [
                { id: '8', name: '[ SLOT ] Canva Edu 12M [ FW ]', price: 10000, stock: 47 },
                { id: '12', name: 'CapCut Pro 7 Day [ FW ]', price: 6000, stock: 26 },
                { id: '18', name: 'YouTube Premium 1 tháng', price: 29000, stock: 64 },
                { id: '23', name: 'Canva Pro chính chủ', price: 22000, stock: 31 }
            ];
        }
        if (providerType === 'nastele') {
            return [
                { id: '201', name: 'Telegram Việt Nam 2FA', price: 18500, stock: 126 },
                { id: '208', name: 'Gmail US tạo sẵn', price: 32000, stock: 48 },
                { id: '214', name: 'Facebook Việt Nam cổ', price: 45000, stock: 17 },
                { id: '221', name: 'Outlook trust cao', price: 12500, stock: 235 }
            ];
        }
        return [
            { id: '101', name: 'Telegram Việt Nam', price: 16500, stock: 342 },
            { id: '105', name: 'Telegram US', price: 28000, stock: 89 },
            { id: '112', name: 'Gmail Việt Nam', price: 9500, stock: 517 },
            { id: '118', name: 'Facebook BM', price: 67000, stock: 24 },
            { id: '125', name: 'Discord Email Verify', price: 14000, stock: 73 }
        ];
    },

    getProviderAdminToken: function () {
        try { return sessionStorage.getItem('accstore_provider_admin_token') || ''; }
        catch (e) { return ''; }
    },

    setProviderVaultMode: function (mode, message = '') {
        const status = document.getElementById('provider-vault-status');
        const setup = document.getElementById('provider-vault-setup');
        const auth = document.getElementById('provider-vault-auth');
        const manager = document.getElementById('provider-vault-manager');
        if (!status || !setup || !auth || !manager) return;

        setup.classList.toggle('hidden', mode !== 'setup');
        auth.classList.toggle('hidden', mode !== 'locked');
        manager.classList.toggle('hidden', mode !== 'unlocked');
        status.className = `provider-vault-status is-${mode}`;
        const defaults = {
            loading: 'Đang kiểm tra két khóa…',
            setup: 'Chưa có khóa mã hóa',
            locked: 'Két đang khóa',
            unlocked: 'Két đã mở an toàn',
            unavailable: 'Chưa kết nối backend'
        };
        status.textContent = message || defaults[mode] || defaults.unavailable;
    },

    adminGenerateProviderMasterKey: function () {
        if (!window.crypto?.getRandomValues) {
            this.showToast('Trình duyệt này không hỗ trợ tạo khóa an toàn.', 'error');
            return;
        }
        const bytes = new Uint8Array(48);
        window.crypto.getRandomValues(bytes);
        const value = btoa(String.fromCharCode(...bytes))
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
        const input = document.getElementById('provider-generated-key');
        const wrap = document.getElementById('provider-generated-key-wrap');
        if (input) input.value = value;
        wrap?.classList.remove('hidden');
        this.showToast('Đã tạo khóa mạnh. Hãy sao chép sang Netlify và giữ lại trong trình quản lý mật khẩu.', 'success');
    },

    adminCopyProviderMasterKey: async function () {
        const input = document.getElementById('provider-generated-key');
        const value = input?.value || '';
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            this.showToast('Đã sao chép PROVIDER_MASTER_KEY.', 'success');
        } catch (error) {
            input.type = 'text';
            input.select();
            document.execCommand('copy');
            input.type = 'password';
            this.showToast('Đã sao chép PROVIDER_MASTER_KEY.', 'success');
        }
    },

    providerAdminRequest: async function (path, options = {}) {
        const headers = { Accept: 'application/json', ...(options.headers || {}) };
        const token = this.getProviderAdminToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';

        let response;
        try {
            response = await fetch(`/api/admin${path}`, {
                method: options.method || 'GET',
                headers,
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                cache: 'no-store'
            });
        } catch (error) {
            throw new Error(window.location.protocol === 'file:'
                ? 'Bản xem trước trên máy không chạy Netlify Function. Hãy mở bản Netlify để sử dụng két API.'
                : 'Không thể kết nối backend Netlify.');
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            throw new Error('Backend chưa nhận được đường dẫn quản lý API. Hãy deploy phiên bản mới lên Netlify.');
        }
        const payload = await response.json();
        if (!response.ok || payload?.success === false) {
            if (response.status === 401) {
                sessionStorage.removeItem('accstore_provider_admin_token');
                this.setProviderVaultMode('locked', 'Phiên đã hết hạn — vui lòng xác minh lại');
            }
            const error = new Error(payload?.error || 'Không thể xử lý yêu cầu.');
            error.code = payload?.code || '';
            throw error;
        }
        return payload.data || {};
    },

    loadProviderVault: async function () {
        if (this.isProviderDemoMode()) {
            if (!this.providerAdminState.demoInitialized) {
                this.providerAdminState.providers = this.getProviderDemoSources();
                this.providerAdminState.demoInitialized = true;
            }
            this.providerAdminState.configured = true;
            this.appState.providerSources = this.providerAdminState.providers;
            this.setProviderVaultMode('unlocked', 'DEMO HTML — không lưu dữ liệu');
            const sessionLabel = document.getElementById('provider-session-label');
            const lockButton = document.getElementById('provider-lock-button');
            if (sessionLabel) sessionLabel.innerHTML = '<i class="fas fa-flask"></i> Chế độ demo cục bộ — không gọi API thật, không lưu key hoặc Firebase';
            lockButton?.classList.add('hidden');
            this.renderProviderSources();
            return;
        }

        const sessionLabel = document.getElementById('provider-session-label');
        const lockButton = document.getElementById('provider-lock-button');
        if (sessionLabel) sessionLabel.innerHTML = '<i class="fas fa-circle-check"></i> Phiên quản lý đang được bảo vệ';
        lockButton?.classList.remove('hidden');
        this.setProviderVaultMode('loading');
        try {
            const status = await this.providerAdminRequest('/status');
            this.providerAdminState.configured = status.configured === true;
            if (!this.providerAdminState.configured) {
                this.setProviderVaultMode('setup');
                this.renderProviderSources();
                return;
            }
            if (!this.getProviderAdminToken()) {
                this.setProviderVaultMode('locked');
                this.renderProviderSources();
                return;
            }

            this.setProviderVaultMode('unlocked');
            const data = await this.providerAdminRequest('/providers');
            this.providerAdminState.providers = Array.isArray(data.providers) ? data.providers : [];
            this.appState.providerSources = this.providerAdminState.providers;
            this.renderProviderSources();
        } catch (error) {
            if (error.code === 'VAULT_NOT_CONFIGURED') this.setProviderVaultMode('setup');
            else if (!this.getProviderAdminToken() && this.providerAdminState.configured) this.setProviderVaultMode('locked', error.message);
            else this.setProviderVaultMode('unavailable', error.message);
            this.renderProviderSources(error.message);
        }
    },

    adminUnlockProviderVault: async function (event) {
        event.preventDefault();
        const input = document.getElementById('provider-admin-password');
        const button = document.getElementById('provider-unlock-button');
        const errorEl = document.getElementById('provider-auth-error');
        const password = input?.value || '';
        if (!password) {
            if (errorEl) errorEl.textContent = 'Vui lòng nhập mật khẩu quản trị.';
            return;
        }

        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang xác minh';
        }
        if (errorEl) errorEl.textContent = '';
        try {
            const data = await this.providerAdminRequest('/session', {
                method: 'POST',
                body: { username: 'admin', password }
            });
            sessionStorage.setItem('accstore_provider_admin_token', data.token);
            if (input) input.value = '';
            this.showToast('Đã mở két API cho phiên làm việc này.', 'success');
            await this.loadProviderVault();
        } catch (error) {
            if (errorEl) errorEl.textContent = error.message;
        } finally {
            if (button) {
                button.disabled = false;
                button.innerHTML = '<i class="fas fa-lock-open"></i> Xác minh & mở két';
            }
        }
    },

    adminLockProviderVault: function () {
        if (this.isProviderDemoMode()) {
            this.showToast('Chế độ demo không tạo phiên thật và không cần khóa két.', 'warning');
            return;
        }
        sessionStorage.removeItem('accstore_provider_admin_token');
        this.providerAdminState.providers = [];
        this.providerAdminState.productsByProvider = {};
        this.appState.providerSources = [];
        this.setProviderVaultMode('locked');
        this.renderProviderSources();
    },

    adminSaveProvider: async function (event) {
        event.preventDefault();
        const id = document.getElementById('provider-source-id')?.value.trim() || '';
        const type = document.getElementById('provider-source-type')?.value || '';
        const label = document.getElementById('provider-source-label')?.value.trim() || '';
        const apiKey = document.getElementById('provider-source-key')?.value.trim() || '';
        const button = document.getElementById('provider-save-button');
        if (!type || !label || !apiKey) {
            this.showToast('Vui lòng nhập đủ tên nguồn, loại bot và API key.', 'warning');
            return;
        }

        if (this.isProviderDemoMode()) {
            const now = Date.now();
            const demoId = id || `demo_${type}_${now}`;
            const existingIndex = this.providerAdminState.providers.findIndex(item => item.id === demoId);
            const demoProviderInfo = {
                nnmshop: { name: 'NNM Shop', balance: 1250000 },
                nastele: { name: 'Shop Hân Nguyễn', balance: 845000 },
                nanlux: { name: 'MMO NanLux', balance: 737000 },
                tunvn: { name: 'TunVN PreHub', balance: 562000 }
            }[type] || { name: 'Nhà cung cấp', balance: 0 };
            const balance = demoProviderInfo.balance;
            const provider = {
                id: demoId,
                type,
                providerName: demoProviderInfo.name,
                label,
                enabled: true,
                keyMask: `••••${apiKey.slice(-4)}`,
                balance,
                balanceDisplay: this.formatMoney(balance),
                lastTestOk: true,
                lastTestAt: now,
                createdAt: existingIndex >= 0 ? this.providerAdminState.providers[existingIndex].createdAt : now,
                updatedAt: now
            };
            if (existingIndex >= 0) this.providerAdminState.providers.splice(existingIndex, 1, provider);
            else this.providerAdminState.providers.unshift(provider);
            this.appState.providerSources = this.providerAdminState.providers;
            this.adminCancelProviderEdit();
            this.renderProviderSources();
            this.showToast('Demo thành công: key chỉ được mô phỏng và không lưu ở đâu cả.', 'success');
            return;
        }

        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang kiểm tra API';
        }
        try {
            await this.providerAdminRequest('/providers', {
                method: 'POST',
                body: { id: id || undefined, type, label, apiKey }
            });
            this.showToast(id ? 'Đã kiểm tra và cập nhật nguồn API.' : 'Đã kiểm tra, mã hóa và lưu nguồn API.', 'success');
            this.adminCancelProviderEdit();
            await this.loadProviderVault();
        } catch (error) {
            this.showToast(error.message, 'error');
        } finally {
            if (button) {
                button.disabled = false;
                button.innerHTML = '<i class="fas fa-shield-halved"></i> Kiểm tra & lưu an toàn';
            }
        }
    },

    adminEditProvider: function (providerId) {
        const provider = this.providerAdminState.providers.find(item => item.id === providerId);
        if (!provider) return;
        this.providerAdminState.editingId = providerId;
        document.getElementById('provider-source-id').value = provider.id;
        document.getElementById('provider-source-type').value = provider.type;
        document.getElementById('provider-source-label').value = provider.label;
        const keyInput = document.getElementById('provider-source-key');
        keyInput.value = '';
        keyInput.placeholder = `Dán API key mới để thay ${provider.keyMask}`;
        document.getElementById('provider-form-title').textContent = 'Thay API key hoặc tên nguồn';
        document.getElementById('provider-cancel-edit').classList.remove('hidden');
        document.getElementById('provider-source-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        keyInput.focus();
    },

    adminCancelProviderEdit: function () {
        this.providerAdminState.editingId = '';
        const form = document.getElementById('provider-source-form');
        if (form) form.reset();
        const idInput = document.getElementById('provider-source-id');
        const keyInput = document.getElementById('provider-source-key');
        if (idInput) idInput.value = '';
        if (keyInput) keyInput.placeholder = 'Dán API key do bot nguồn cung cấp';
        const title = document.getElementById('provider-form-title');
        if (title) title.textContent = 'Thêm nguồn API mới';
        document.getElementById('provider-cancel-edit')?.classList.add('hidden');
    },

    adminTestProvider: async function (providerId) {
        if (this.isProviderDemoMode()) {
            const provider = this.providerAdminState.providers.find(item => item.id === providerId);
            if (!provider) return;
            provider.lastTestOk = true;
            provider.lastTestAt = Date.now();
            provider.updatedAt = provider.lastTestAt;
            this.renderProviderSources();
            this.showToast(`Demo kết nối thành công — ${provider.balanceDisplay}.`, 'success');
            return;
        }
        const button = document.querySelector(`[data-provider-test="${providerId}"]`);
        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang kiểm tra';
        }
        try {
            const data = await this.providerAdminRequest(`/providers/${encodeURIComponent(providerId)}/test`, { method: 'POST' });
            this.showToast(`Kết nối thành công — ${data.balanceDisplay || 'API hoạt động'}.`, 'success');
            await this.loadProviderVault();
        } catch (error) {
            this.showToast(error.message, 'error');
            await this.loadProviderVault();
        }
    },

    adminDeleteProvider: async function (providerId) {
        const provider = this.providerAdminState.providers.find(item => item.id === providerId);
        const confirmMessage = this.isProviderDemoMode()
            ? `Xóa nguồn “${provider?.label || ''}” khỏi bản demo?`
            : `Xóa nguồn “${provider?.label || ''}”? API key mã hóa cũng sẽ bị xóa khỏi Firebase.`;
        if (!provider || !confirm(confirmMessage)) return;
        if (this.isProviderDemoMode()) {
            this.providerAdminState.providers = this.providerAdminState.providers.filter(item => item.id !== providerId);
            delete this.providerAdminState.productsByProvider[providerId];
            this.appState.providerSources = this.providerAdminState.providers;
            this.renderProviderSources();
            this.showToast('Đã xóa nguồn khỏi bản demo. Firebase không bị thay đổi.', 'success');
            return;
        }
        try {
            await this.providerAdminRequest(`/providers/${encodeURIComponent(providerId)}`, { method: 'DELETE' });
            delete this.providerAdminState.productsByProvider[providerId];
            this.showToast('Đã xóa nguồn API và key mã hóa.', 'success');
            await this.loadProviderVault();
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    },

    adminLoadProviderProducts: async function (providerId) {
        if (this.isProviderDemoMode()) {
            const provider = this.providerAdminState.providers.find(item => item.id === providerId);
            if (!provider) return;
            const products = this.getProviderDemoProducts(provider.type);
            this.providerAdminState.productsByProvider[providerId] = {
                loading: false,
                products,
                total: products.length
            };
            this.renderProviderSources();
            return;
        }
        this.providerAdminState.productsByProvider[providerId] = { loading: true, products: [] };
        this.renderProviderSources();
        try {
            const data = await this.providerAdminRequest(`/providers/${encodeURIComponent(providerId)}/products`);
            this.providerAdminState.productsByProvider[providerId] = {
                loading: false,
                products: Array.isArray(data.products) ? data.products : [],
                total: Number(data.total || 0)
            };
        } catch (error) {
            this.providerAdminState.productsByProvider[providerId] = { loading: false, products: [], error: error.message };
        }
        this.renderProviderSources();
    },

    renderProviderSources: function (fallbackMessage = '') {
        const container = document.getElementById('provider-sources-list');
        if (!container) return;
        const providers = this.providerAdminState.providers || [];
        if (fallbackMessage && providers.length === 0) {
            container.innerHTML = `<div class="provider-empty-state"><i class="fas fa-circle-exclamation"></i><p>${this.escapeHtml(fallbackMessage)}</p></div>`;
            return;
        }
        if (providers.length === 0) {
            container.innerHTML = '<div class="provider-empty-state"><i class="fas fa-plug-circle-plus"></i><p>Chưa có nguồn API. Thêm nguồn đầu tiên ở biểu mẫu bên trên.</p></div>';
            return;
        }

        container.innerHTML = providers.map(provider => {
            const safeId = this.escapeHtml(provider.id);
            const productsState = this.providerAdminState.productsByProvider[provider.id];
            const checkedAt = provider.lastTestAt
                ? new Date(provider.lastTestAt).toLocaleString('vi-VN')
                : 'Chưa kiểm tra';
            let productsHtml = '';
            if (productsState?.loading) {
                productsHtml = '<div class="provider-products-panel"><i class="fas fa-spinner fa-spin"></i> Đang tải danh mục…</div>';
            } else if (productsState?.error) {
                productsHtml = `<div class="provider-products-panel is-error">${this.escapeHtml(productsState.error)}</div>`;
            } else if (Array.isArray(productsState?.products)) {
                const rows = productsState.products.slice(0, 60).map(product => `
                    <div class="provider-product-row">
                        <span><strong>${this.escapeHtml(product.name)}</strong><small>ID ${this.escapeHtml(product.id)}</small></span>
                        <span>${this.formatMoney(product.price)}<small>Kho ${Number(product.stock || 0).toLocaleString('vi-VN')}</small></span>
                    </div>`).join('');
                productsHtml = `<div class="provider-products-panel">
                    <div class="provider-products-title"><span>${Number(productsState.total || 0).toLocaleString('vi-VN')} sản phẩm từ nguồn</span><small>Hiển thị tối đa 60 dòng</small></div>
                    ${rows || '<p>Nhà cung cấp chưa có sản phẩm.</p>'}
                </div>`;
            }

            return `<article class="provider-source-card">
                <div class="provider-source-main">
                    <div class="provider-source-icon"><i class="fas fa-server"></i></div>
                    <div class="provider-source-copy">
                        <div class="provider-source-title">
                            <h4>${this.escapeHtml(provider.label)}</h4>
                            <span class="provider-connection ${provider.lastTestOk ? 'is-ok' : 'is-error'}">
                                <i class="fas ${provider.lastTestOk ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
                                ${provider.lastTestOk ? 'Đang kết nối' : 'Cần kiểm tra'}
                            </span>
                        </div>
                        <p>${this.escapeHtml(provider.providerName)} · Key ${this.escapeHtml(provider.keyMask)}</p>
                        <div class="provider-source-meta">
                            <span><i class="fas fa-wallet"></i> ${this.escapeHtml(provider.balanceDisplay || 'Chưa đọc số dư')}</span>
                            <span><i class="fas fa-clock"></i> ${this.escapeHtml(checkedAt)}</span>
                        </div>
                    </div>
                </div>
                <div class="provider-source-actions">
                    <button type="button" class="btn-outline" data-provider-test="${safeId}" onclick="app.adminTestProvider('${safeId}')"><i class="fas fa-signal"></i> Test</button>
                    <button type="button" class="btn-outline" onclick="app.adminLoadProviderProducts('${safeId}')"><i class="fas fa-list"></i> Xem sản phẩm</button>
                    <button type="button" class="btn-outline" onclick="app.adminEditProvider('${safeId}')"><i class="fas fa-key"></i> Đổi key</button>
                    <button type="button" class="btn-outline is-danger" onclick="app.adminDeleteProvider('${safeId}')"><i class="fas fa-trash"></i></button>
                </div>
                ${productsHtml}
            </article>`;
        }).join('');
    },

    // ---- OTP API CONFIG (đồng bộ web + bot + netlify qua Firebase settings/config) ----
    loadOTPConfigStatus: function () {
        if (!db) return;
        db.ref('settings/config/otpBaseUrl').once('value').then(snap => {
            const statusEl = document.getElementById('otpcfg-status');
            const urlEl = document.getElementById('admin-otp-baseurl-input');
            if (!statusEl || !urlEl) return;
            urlEl.value = snap.val() || 'https://chaycodeso3.com/api';
            statusEl.textContent = '🔒 Key ở Netlify';
            statusEl.style.background = 'rgba(16,185,129,0.2)';
            statusEl.style.color = '#10b981';
        });
    },

    adminSaveOTPConfig: function () {
        if (!db) return;
        const urlInput = document.getElementById('admin-otp-baseurl-input');
        const newUrl = urlInput.value.trim();
        if (newUrl && !/^https?:\/\//i.test(newUrl)) {
            this.showToast('Base URL phải bắt đầu bằng http(s)://', 'warning');
            return;
        }
        if (!newUrl) {
            this.showToast('Vui lòng nhập URL API OTP.', 'warning');
            return;
        }
        db.ref('settings/config').update({ otpBaseUrl: newUrl }).then(() => {
            this.showToast('✅ Đã lưu URL! OTP key vẫn được bảo vệ trên Netlify.', 'success');
            this.otpState.baseUrl = newUrl;
            this.loadOTPConfigStatus();
        }).catch(err => this.showToast('Lỗi: ' + err.message));
    },

    adminTestOTPConfig: async function () {
        const infoBox = document.getElementById('otpcfg-info');
        if (!infoBox) return;
        infoBox.style.display = 'block';
        infoBox.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang gọi API nguồn bằng cấu hình đã lưu...';
        try {
            const res = await fetch('/api/otp-raw?act=app&_t=' + Date.now());
            const data = await res.json();
            if (data.ResponseCode === 0 && Array.isArray(data.Result)) {
                infoBox.innerHTML = '<span style="color:#10b981;">✅ Kết nối OK! API trả về ' + data.Result.length + ' app — key đang hoạt động.</span>';
            } else {
                infoBox.innerHTML = '<span style="color:var(--danger);">❌ API báo lỗi: ' + (data.Msg || ('ResponseCode ' + data.ResponseCode)) + '. Hãy kiểm tra OTP_API_KEY trên Netlify.</span>';
            }
        } catch (e) {
            infoBox.innerHTML = '<span style="color:var(--danger);">❌ Lỗi kết nối: ' + e.message + '</span>';
        }
    },

    // ---- HỆ SỐ GIÁ BÁN (settings/config.priceMultiplier) ----
    loadPriceConfig: function () {
        if (!db) return;
        db.ref('settings/config/priceMultiplier').once('value').then(snap => {
            const input = document.getElementById('admin-pricemul-input');
            const statusEl = document.getElementById('pricemul-status');
            if (!input) return;
            const savedMul = Number(snap.val());
            const mul = savedMul > 0 ? savedMul : 3000;
            input.value = mul;
            if (statusEl) {
                const isSaved = savedMul > 0;
                statusEl.textContent = isSaved ? ('×' + mul.toLocaleString('vi-VN')) : '⚠️ Mặc định ×3000';
                statusEl.style.background = isSaved ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.08)';
                statusEl.style.color = isSaved ? '#10b981' : 'var(--text-muted)';
            }
            this.updatePriceMulPreview();
        });
    },

    updatePriceMulPreview: function () {
        const input = document.getElementById('admin-pricemul-input');
        const preview = document.getElementById('pricemul-preview');
        if (!input || !preview) return;
        const mul = Number(input.value);
        if (mul > 0) {
            preview.innerHTML = 'Ví dụ: giá gốc 1 → bán <b style="color:#22c55e;">' + mul.toLocaleString('vi-VN') + 'đ</b>  •  giá gốc 2 → <b style="color:#22c55e;">' + (mul * 2).toLocaleString('vi-VN') + 'đ</b>';
        } else {
            preview.innerHTML = '<span style="color:var(--danger);">Hệ số phải là số nguyên dương.</span>';
        }
    },

    adminSavePriceMultiplier: function () {
        if (!db) return;
        const input = document.getElementById('admin-pricemul-input');
        const mul = Math.floor(Number(input.value));
        if (!(mul > 0)) {
            this.showToast('Hệ số giá phải là số nguyên dương.', 'warning');
            return;
        }
        db.ref('settings/config').update({ priceMultiplier: mul }).then(() => {
            this.showToast('✅ Đã lưu hệ số giá ×' + mul.toLocaleString('vi-VN') + '! Web áp dụng ngay, bot ~1 phút.', 'success');
            this.otpState.priceMul = mul;
            this.loadPriceConfig();
        }).catch(err => this.showToast('Lỗi: ' + err.message));
    },

    // ---- TRẠNG THÁI BOT (đọc settings/botStatus do bot ghi heartbeat) ----
    loadBotStatus: function () {
        if (!db) return;
        // Re-render định kỳ để tự chuyển sang Offline khi heartbeat ngừng cập nhật.
        if (!this._botStatusTimer) {
            this._botStatusTimer = setInterval(() => this._renderBotStatus(), 30000);
        }
        db.ref('settings/botStatus').on('value', snap => {
            const st = snap.val() || {};
            this._botLastSeen = Number(st.lastSeen || 0);
            this._renderBotStatus();
        });
    },

    _renderBotStatus: function () {
        const el = document.getElementById('bot-status-badge');
        const detailEl = document.getElementById('bot-status-detail');
        if (!el) return;
        const lastSeen = Number(this._botLastSeen || 0);
        const ageMs = Date.now() - lastSeen;
        // Bot ghi heartbeat mỗi ~60s → coi là online nếu thấy trong 150s gần nhất.
        if (!lastSeen) {
            el.textContent = '❔ Chưa rõ';
            el.style.background = 'rgba(255,255,255,0.08)';
            el.style.color = 'var(--text-muted)';
            if (detailEl) detailEl.textContent = 'Bot chưa gửi heartbeat. Cần set FIREBASE_SECRET trên Railway để bật theo dõi trạng thái.';
        } else if (ageMs < 150000) {
            el.textContent = '🟢 Online';
            el.style.background = 'rgba(16,185,129,0.2)';
            el.style.color = '#10b981';
            if (detailEl) detailEl.textContent = 'Bot đang hoạt động — heartbeat ' + Math.round(ageMs / 1000) + 's trước.';
        } else {
            el.textContent = '🔴 Offline';
            el.style.background = 'rgba(239,68,68,0.2)';
            el.style.color = '#ef4444';
            const mins = Math.round(ageMs / 60000);
            if (detailEl) detailEl.textContent = 'Không thấy heartbeat ~' + mins + ' phút. Bot có thể đã tắt hoặc đang redeploy.';
        }
    },

    adminAddBanner: function (e) {
        e.preventDefault();
        if (!db) return;

        const imgUrl = document.getElementById('admin-banner-img').value.trim();
        const link = document.getElementById('admin-banner-link').value.trim();

        if (!imgUrl) {
            this.showToast("Vui lòng nhập Link Hình ảnh!", 'warning');
            return;
        }

        const newBanner = {
            imgUrl: imgUrl,
            link: link,
            timestamp: Date.now()
        };

        db.ref('settings/banners').push(newBanner).then(() => {
            this.showToast("Đã thêm banner quảng cáo!");
            e.target.reset();
        }).catch(err => {
            this.showToast("Lỗi: " + err.message);
        });
    },

    adminDeleteBanner: function (id) {
        if (!db) return;
        if (!confirm("Bạn có chắc muốn xóa banner này?")) return;

        db.ref('settings/banners/' + id).remove().then(() => {
            this.showToast("Đã xóa banner!");
        });
    },

    renderAdminBanners: function () {
        const list = document.getElementById('admin-banners-list');
        if (!list) return;

        list.innerHTML = '';
        if (this.appState.banners.length === 0) {
            list.innerHTML = '<p style="color: var(--text-muted); font-size: 0.9rem;">Chưa có banner nào.</p>';
            return;
        }

        this.appState.banners.forEach(b => {
            const div = document.createElement('div');
            div.style.display = 'flex';
            div.style.alignItems = 'center';
            div.style.justifyContent = 'space-between';
            div.style.background = 'rgba(0,0,0,0.3)';
            div.style.padding = '10px';
            div.style.borderRadius = '8px';
            div.style.border = '1px solid var(--card-border)';

            div.innerHTML = `
                <div style="display: flex; align-items: center; gap: 15px;">
                    <img src="${b.imgUrl}" alt="Banner" style="width: 80px; height: 40px; object-fit: cover; border-radius: 5px;">
                    <div style="font-size: 0.85rem; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        <strong>Link đích:</strong> <a href="${b.link || '#'}" target="_blank" style="color: var(--accent);">${b.link || 'Không có'}</a>
                    </div>
                </div>
                <button class="btn-outline" style="padding: 5px 10px; border-color: var(--danger); color: var(--danger);" onclick="app.adminDeleteBanner('${b.id}')"><i class="fas fa-trash"></i></button>
            `;
            list.appendChild(div);
        });
    },

    adminRejectDeposit: function (memo) {
        if (!db) return;
        if (!confirm('Bạn có chắc muốn hủy đơn nạp này?')) return;
        db.ref('deposit_requests/' + memo).update({ status: 'Bị hủy' }).then(() => {
            this.showToast('Đã hủy đơn nạp');
        });
    },

    renderAdminChart: function () {
        const ctx = document.getElementById('admin-revenue-chart');
        if (!ctx) return;

        // Prepare Data
        const last7Days = [];
        const depositsData = [];

        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toLocaleDateString('vi-VN');
            last7Days.push(dateStr);

            // Calculate total deposits for this day
            // Tính tổng nạp tiền (bao gồm: "Hoàn thành", "Đã duyệt (Auto SePay)", v.v.)
            let dailyTotal = 0;
            const COMPLETED_STATUSES = ['Hoàn thành', 'Đã duyệt (Auto SePay)', 'Đã duyệt'];
            this.appState.allDeposits.forEach(dep => {
                if (!dep.status || !dep.timestamp) return;
                const isCompleted = COMPLETED_STATUSES.some(s => dep.status.includes(s));
                if (isCompleted) {
                    const depDate = new Date(Number(dep.timestamp)).toLocaleDateString('vi-VN');
                    if (depDate === dateStr) {
                        dailyTotal += parseInt(dep.amount || 0);
                    }
                }
            });
            depositsData.push(dailyTotal);
        }

        if (this.adminChartInstance) {
            this.adminChartInstance.destroy();
        }

        const isLight = document.body.classList.contains('light-theme');
        const gridColor = isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)';
        const textColor = isLight ? '#1e293b' : '#f8fafc';

        this.adminChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: last7Days,
                datasets: [{
                    label: 'Doanh Thu Nạp Tiền (VNĐ)',
                    data: depositsData,
                    backgroundColor: 'rgba(255, 0, 127, 0.5)',
                    borderColor: 'rgba(255, 0, 127, 1)',
                    borderWidth: 1,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: gridColor },
                        ticks: { color: textColor }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { color: textColor }
                    }
                },
                plugins: {
                    legend: { labels: { color: textColor } }
                }
            }
        });
    },

    renderAdminProducts: function () {
        const list = document.getElementById('admin-products-list');
        if (!list) return;

        list.innerHTML = '';
        this.renderAdminCategoryManager();
        this.populateAdminCategoryFilter();
        this.filterAdminProducts().forEach(p => {
            const categoryId = this.getProductCategory(p);
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><img src="${this.escapeHtml(p.logoUrls && p.logoUrls.length > 0 ? p.logoUrls[0] : '')}" alt="logo" loading="lazy" decoding="async" style="width: 40px; height: 40px; object-fit: contain; background: rgba(255,255,255,0.1); border-radius: 5px;"></td>
                <td class="font-bold">${this.escapeHtml(p.name)}</td>
                <td>
                    <select class="admin-product-category-select" aria-label="Nhóm của ${this.escapeHtml(p.name)}"
                        onchange="app.adminChangeProductCategory('${this.escapeHtml(p.id)}', this.value)">
                        ${this.getProductCategories().map(category => `
                            <option value="${this.escapeHtml(category.id)}" ${category.id === categoryId ? 'selected' : ''}>
                                ${this.escapeHtml(category.name)}
                            </option>
                        `).join('')}
                    </select>
                </td>
                <td>${this.escapeHtml(p.duration)}</td>
                <td>${this.escapeHtml(this.getWarrantyText(p))}</td>
                <td class="text-price font-bold">${this.formatMoney(p.price)}</td>
                <td class="font-bold" style="color: ${p.quantity > 0 ? '#2ecc71' : 'var(--danger)'};">${p.quantity !== undefined ? p.quantity : 0}</td>
                <td>
                    <div style="font-size: 0.85rem; color: var(--text-muted); max-width: 250px;">
                        <strong>Giao hàng:</strong>
                        <span style="color:${this.isAutoProduct(p) ? '#10b981' : 'var(--text-muted)'};">
                            ${this.isAutoProduct(p) ? 'Tự động từ kho' : 'Admin cấp thủ công'}
                        </span>
                        <br>
                        <strong>Format:</strong> ${this.escapeHtml(p.format || '-')}
                        <br>
                        <strong>Note:</strong> ${this.escapeHtml(p.desc || '-')}
                    </div>
                </td>
                <td>
                    <button class="btn-primary" style="padding: 5px 10px; font-size: 0.8rem;" onclick="app.adminEditProduct('${p.id}')">
                        <i class="fas fa-edit"></i> ${this.isAutoProduct(p) ? 'Sửa & nhập kho' : 'Sửa'}
                    </button>
                    <button class="btn-outline" style="padding: 5px 10px; font-size: 0.8rem; margin-top: 5px; border-color: var(--danger); color: var(--danger);" onclick="app.adminDeleteProduct('${p.id}')">
                        <i class="fas fa-trash"></i> Xóa
                    </button>
                </td>
            `;
            list.appendChild(tr);
        });
    },

    listenToProductInventory: function () {
        if (!db || !this.appState.currentUser
            || this.appState.currentUser.username.trim().toLowerCase() !== 'admin') return;
        if (this._productInventoryRef && this._productInventoryListener) {
            this._productInventoryRef.off('value', this._productInventoryListener);
        }
        this._productInventoryRef = db.ref('productInventory');
        this._productInventoryListener = snapshot => {
            this.appState.productInventory = snapshot.val() || {};
            if (document.getElementById('view-admin')?.classList.contains('active')) {
                this.renderAdminInventoryCenter();
            }
        };
        this._productInventoryRef.on('value', this._productInventoryListener);
    },

    populateProductCategorySelect: function (selectedId) {
        const select = document.getElementById('product-category');
        if (!select) return;
        const categories = this.getProductCategories();
        const currentValue = selectedId || select.value || 'other';
        select.innerHTML = categories.map(category => `
            <option value="${this.escapeHtml(category.id)}">${this.escapeHtml(category.name)}</option>
        `).join('');
        select.value = categories.some(category => category.id === currentValue)
            ? currentValue
            : (categories.find(category => category.id === 'other')?.id || categories[0]?.id || '');
    },

    populateAdminCategoryFilter: function () {
        const select = document.getElementById('admin-products-category-filter');
        if (!select) return;
        const currentValue = this.adminFilters.productCategory || 'all';
        select.innerHTML = `
            <option value="all">Tất cả nhóm</option>
            ${this.getProductCategories().map(category => `
                <option value="${this.escapeHtml(category.id)}">${this.escapeHtml(category.name)}</option>
            `).join('')}
        `;
        if (currentValue !== 'all' && !this.getProductCategories().some(category => category.id === currentValue)) {
            this.adminFilters.productCategory = 'all';
        }
        select.value = this.adminFilters.productCategory;
    },

    renderAdminCategoryManager: function () {
        const container = document.getElementById('admin-category-list');
        if (!container) return;
        const categories = this.getProductCategories();
        const counts = {};
        (this.appState.products || []).forEach(product => {
            const categoryId = this.getProductCategory(product);
            counts[categoryId] = (counts[categoryId] || 0) + 1;
        });

        container.innerHTML = categories.map(category => `
            <div class="admin-category-item">
                <span class="admin-category-icon"><i class="fas fa-folder"></i></span>
                <span class="admin-category-copy">
                    <strong>${this.escapeHtml(category.name)}</strong>
                    <small>${counts[category.id] || 0} sản phẩm</small>
                </span>
                <span class="admin-category-actions">
                    <button type="button" class="btn-icon" title="Đổi tên nhóm"
                        onclick="app.adminRenameProductCategory('${this.escapeHtml(category.id)}')">
                        <i class="fas fa-pen"></i>
                    </button>
                    ${category.id !== 'other' ? `
                        <button type="button" class="btn-icon danger" title="Xóa nhóm"
                            onclick="app.adminDeleteProductCategory('${this.escapeHtml(category.id)}')">
                            <i class="fas fa-trash"></i>
                        </button>
                    ` : ''}
                </span>
            </div>
        `).join('');
    },

    createProductCategoryId: function (name) {
        const base = this.normalizeText(name)
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'nhom';
        const usedIds = new Set(this.getProductCategories().map(category => category.id));
        let id = base;
        let suffix = 2;
        while (usedIds.has(id) || id === 'all') {
            id = `${base}-${suffix++}`;
        }
        return id;
    },

    adminCreateProductCategory: function (event) {
        event.preventDefault();
        if (!db) return;
        const input = document.getElementById('admin-category-name');
        const name = String(input?.value || '').trim();
        if (name.length < 2) {
            this.showToast('Tên nhóm cần có ít nhất 2 ký tự.', 'warning');
            input?.focus();
            return;
        }
        if (this.getProductCategories().some(category => this.normalizeText(category.name) === this.normalizeText(name))) {
            this.showToast('Nhóm này đã tồn tại.', 'warning');
            input?.focus();
            return;
        }

        const id = this.createProductCategoryId(name);
        const order = Math.max(0, ...this.getProductCategories().map(category => Number(category.order || 0))) + 10;
        db.ref('productCategories/' + id).set({
            name,
            order,
            deleted: false,
            createdAt: firebase.database.ServerValue.TIMESTAMP,
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        }).then(() => {
            input.value = '';
            this.showToast(`Đã tạo nhóm “${name}”.`);
        }).catch(error => this.showToast('Không thể tạo nhóm: ' + error.message, 'error'));
    },

    adminRenameProductCategory: function (categoryId) {
        if (!db) return;
        const category = this.getProductCategories().find(item => item.id === categoryId);
        if (!category) return;
        const name = prompt('Tên mới cho nhóm sản phẩm:', category.name);
        if (name === null) return;
        const cleanName = name.trim();
        if (cleanName.length < 2) {
            this.showToast('Tên nhóm cần có ít nhất 2 ký tự.', 'warning');
            return;
        }
        const duplicate = this.getProductCategories().some(item =>
            item.id !== categoryId && this.normalizeText(item.name) === this.normalizeText(cleanName)
        );
        if (duplicate) {
            this.showToast('Tên nhóm này đã được sử dụng.', 'warning');
            return;
        }

        db.ref('productCategories/' + categoryId).update({
            name: cleanName,
            order: Number(category.order || 0),
            deleted: false,
            updatedAt: firebase.database.ServerValue.TIMESTAMP
        }).then(() => this.showToast('Đã đổi tên nhóm.'))
            .catch(error => this.showToast('Không thể đổi tên nhóm: ' + error.message, 'error'));
    },

    adminDeleteProductCategory: function (categoryId) {
        if (!db || categoryId === 'other') return;
        const category = this.getProductCategories().find(item => item.id === categoryId);
        if (!category) return;
        const affectedProducts = (this.appState.products || []).filter(product =>
            this.getProductCategory(product) === categoryId
        );
        const message = affectedProducts.length
            ? `Xóa nhóm “${category.name}”? ${affectedProducts.length} sản phẩm trong nhóm sẽ được chuyển sang “Khác”.`
            : `Xóa nhóm “${category.name}”?`;
        if (!confirm(message)) return;

        const updates = {
            [`productCategories/${categoryId}/name`]: category.name,
            [`productCategories/${categoryId}/order`]: Number(category.order || 0),
            [`productCategories/${categoryId}/deleted`]: true,
            [`productCategories/${categoryId}/updatedAt`]: firebase.database.ServerValue.TIMESTAMP
        };
        affectedProducts.forEach(product => {
            updates[`products/${product.id}/categoryId`] = 'other';
        });
        db.ref().update(updates)
            .then(() => this.showToast('Đã xóa nhóm và sắp xếp lại sản phẩm.'))
            .catch(error => this.showToast('Không thể xóa nhóm: ' + error.message, 'error'));
    },

    adminChangeProductCategory: function (productId, categoryId) {
        if (!db || !this.getProductCategories().some(category => category.id === categoryId)) return;
        db.ref(`products/${productId}/categoryId`).set(categoryId)
            .then(() => this.showToast(`Đã chuyển sản phẩm sang nhóm “${this.getProductCategoryName(categoryId)}”.`))
            .catch(error => this.showToast('Không thể đổi nhóm sản phẩm: ' + error.message, 'error'));
    },

    normalizeInventoryItems: function (rawInventory) {
        const isStructured = rawInventory
            && typeof rawInventory === 'object'
            && (
                Object.prototype.hasOwnProperty.call(rawInventory, 'items')
                || Object.prototype.hasOwnProperty.call(rawInventory, 'deliveries')
                || Object.prototype.hasOwnProperty.call(rawInventory, 'imports')
            );
        const source = isStructured ? (rawInventory.items || {}) : (rawInventory || {});
        return Object.entries(source)
            .map(([key, item], index) => {
                const value = typeof item === 'string' ? item : item?.value;
                return {
                    key,
                    value: String(value || '').trim(),
                    createdAt: Number(item?.createdAt || index)
                };
            })
            .filter(item => item.value)
            .sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
    },

    normalizeDeliveredAccounts: function (accounts) {
        const source = Array.isArray(accounts) ? accounts : Object.values(accounts || {});
        return source.map(item => String(item || '').trim()).filter(Boolean);
    },

    prepareInventoryAllocation: function (currentInventory, orderId, username, quantity) {
        const requestedQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
        const hasStructuredInventory = currentInventory
            && typeof currentInventory === 'object'
            && (
                Object.prototype.hasOwnProperty.call(currentInventory, 'items')
                || Object.prototype.hasOwnProperty.call(currentInventory, 'deliveries')
                || Object.prototype.hasOwnProperty.call(currentInventory, 'imports')
            );
        const state = hasStructuredInventory
            ? {
                ...currentInventory,
                items: currentInventory.items || {},
                deliveries: currentInventory.deliveries || {}
            }
            : { items: currentInventory || {}, deliveries: {} };

        const existingDelivery = state.deliveries?.[orderId];
        if (existingDelivery?.accounts) {
            return {
                state,
                accounts: this.normalizeDeliveredAccounts(existingDelivery.accounts),
                reused: true
            };
        }

        const availableItems = this.normalizeInventoryItems({ items: state.items });
        if (availableItems.length < requestedQuantity) {
            return { state: undefined, accounts: [], insufficient: true };
        }

        const selected = availableItems.slice(0, requestedQuantity);
        const accounts = selected.map(item => item.value);
        const remainingItems = { ...state.items };
        selected.forEach(item => delete remainingItems[item.key]);

        return {
            state: {
                ...state,
                items: Object.keys(remainingItems).length > 0 ? remainingItems : null,
                deliveries: {
                    ...state.deliveries,
                    [orderId]: {
                        username,
                        accounts,
                        quantity: requestedQuantity,
                        createdAt: Date.now()
                    }
                }
            },
            accounts,
            reused: false
        };
    },

    getInventoryDeliveryCount: function (inventory) {
        return Object.values(inventory?.deliveries || {}).reduce((total, delivery) => {
            return total + this.normalizeDeliveredAccounts(delivery?.accounts).length;
        }, 0);
    },

    renderAdminInventoryCenter: function (searchValue) {
        const summary = document.getElementById('admin-inventory-summary');
        const productList = document.getElementById('admin-inventory-products');
        const historyList = document.getElementById('admin-inventory-history');
        if (!summary || !productList || !historyList) return;

        const searchInput = document.getElementById('admin-inventory-search');
        const query = this.normalizeText(searchValue !== undefined ? searchValue : (searchInput?.value || ''));
        const inventoryData = this.appState.productInventory || {};
        const autoProducts = (this.appState.products || []).filter(product => this.isAutoProduct(product));
        const valueUsage = new Map();

        autoProducts.forEach(product => {
            this.normalizeInventoryItems(inventoryData[product.id]).forEach(item => {
                const locations = valueUsage.get(item.value) || new Set();
                locations.add(product.id);
                valueUsage.set(item.value, locations);
            });
        });

        const productStats = autoProducts.map(product => {
            const inventory = inventoryData[product.id] || {};
            const items = this.normalizeInventoryItems(inventory);
            const duplicateCount = items.filter(item => (valueUsage.get(item.value)?.size || 0) > 1).length;
            return {
                product,
                inventory,
                stock: items.length,
                duplicateCount,
                delivered: this.getInventoryDeliveryCount(inventory)
            };
        });

        const totalStock = productStats.reduce((sum, item) => sum + item.stock, 0);
        const totalDelivered = productStats.reduce((sum, item) => sum + item.delivered, 0);
        const lowStockCount = productStats.filter(item => item.stock <= 5).length;
        const duplicateTotal = [...valueUsage.values()].filter(locations => locations.size > 1).length;

        summary.innerHTML = `
            <div class="inventory-summary-item">
                <i class="fas fa-box-open"></i>
                <span><strong>${totalStock}</strong><small>Tài khoản sẵn sàng</small></span>
            </div>
            <div class="inventory-summary-item">
                <i class="fas fa-layer-group"></i>
                <span><strong>${autoProducts.length}</strong><small>Sản phẩm tự động</small></span>
            </div>
            <div class="inventory-summary-item ${lowStockCount > 0 ? 'is-warning' : ''}">
                <i class="fas fa-triangle-exclamation"></i>
                <span><strong>${lowStockCount}</strong><small>Sắp hết hàng</small></span>
            </div>
            <div class="inventory-summary-item ${duplicateTotal > 0 ? 'is-danger' : ''}">
                <i class="fas fa-clone"></i>
                <span><strong>${duplicateTotal}</strong><small>Tài khoản trùng</small></span>
            </div>
            <div class="inventory-summary-item">
                <i class="fas fa-paper-plane"></i>
                <span><strong>${totalDelivered}</strong><small>Đã giao tự động</small></span>
            </div>
        `;

        const filteredStats = productStats.filter(item => {
            if (!query) return true;
            return this.normalizeText(item.product.name || '').includes(query);
        });

        productList.innerHTML = filteredStats.length > 0
            ? filteredStats.map(item => {
                const statusClass = item.stock === 0 ? 'is-empty' : (item.stock <= 5 ? 'is-low' : 'is-ready');
                const statusLabel = item.stock === 0 ? 'Hết kho' : (item.stock <= 5 ? 'Sắp hết' : 'Sẵn sàng');
                const safeProductId = encodeURIComponent(String(item.product.id || ''));
                const logo = this.escapeHtml(item.product.logoUrls?.[0] || '');
                return `
                    <article class="inventory-product-row ${statusClass}">
                        <div class="inventory-product-identity">
                            <img src="${logo}" alt="" loading="lazy">
                            <span>
                                <strong>${this.escapeHtml(item.product.name || 'Sản phẩm')}</strong>
                                <small>${this.escapeHtml(item.product.duration || '')}</small>
                            </span>
                        </div>
                        <div class="inventory-product-metric">
                            <small>Tồn thực tế</small><strong>${item.stock}</strong>
                        </div>
                        <div class="inventory-product-metric">
                            <small>Đã giao</small><strong>${item.delivered}</strong>
                        </div>
                        <div class="inventory-product-metric ${item.duplicateCount > 0 ? 'has-duplicate' : ''}">
                            <small>Trùng kho khác</small><strong>${item.duplicateCount}</strong>
                        </div>
                        <span class="inventory-stock-state ${statusClass}">${statusLabel}</span>
                        <button type="button" class="btn-outline"
                            onclick="app.adminEditProduct(decodeURIComponent('${safeProductId}'))">
                            <i class="fas fa-file-import"></i> Nhập kho
                        </button>
                    </article>
                `;
            }).join('')
            : `<div class="inventory-empty-state"><i class="fas fa-box-open"></i><p>Không có sản phẩm kho tự động phù hợp.</p></div>`;

        const history = [];
        Object.entries(inventoryData).forEach(([productId, inventory]) => {
            const product = this.appState.products.find(item => String(item.id) === String(productId));
            Object.entries(inventory?.imports || {}).forEach(([id, record]) => {
                history.push({
                    id,
                    productName: product?.name || productId,
                    ...record
                });
            });
        });
        history.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

        historyList.innerHTML = history.length > 0
            ? history.slice(0, 20).map(record => `
                <div class="inventory-history-item">
                    <span class="inventory-history-icon"><i class="fas fa-file-excel"></i></span>
                    <span class="inventory-history-copy">
                        <strong>${this.escapeHtml(record.productName || 'Sản phẩm')}</strong>
                        <small>${this.escapeHtml(record.source || 'Dán thủ công')} · ${record.mode === 'replace' ? 'Thay toàn bộ kho' : 'Thêm vào kho'}</small>
                    </span>
                    <span class="inventory-history-count">+${Number(record.submittedCount || 0)}</span>
                    <time>${record.createdAt ? new Date(Number(record.createdAt)).toLocaleString('vi-VN') : '-'}</time>
                </div>
            `).join('')
            : `<div class="inventory-empty-state compact"><p>Chưa có lịch sử nhập kho mới.</p></div>`;
    },

    getInventoryDraftItems: function () {
        const textItems = String(document.getElementById('product-inventory-text')?.value || '')
            .split(/\r?\n/)
            .map(item => item.trim())
            .filter(Boolean);
        const allItems = [...(this._inventoryFileItems || []), ...textItems];
        return [...new Set(allItems.map(item => String(item || '').trim()).filter(Boolean))];
    },

    maskInventoryValue: function (value) {
        const text = String(value || '');
        if (text.length <= 8) return '••••••';
        return `${text.slice(0, 5)}••••${text.slice(-3)}`;
    },

    buildInventoryItemsMap: function (items) {
        const result = {};
        items.forEach((item, index) => {
            const key = item.key || db.ref('productInventory').push().key;
            result[key] = {
                value: item.value,
                createdAt: Number(item.createdAt || (Date.now() + index))
            };
        });
        return result;
    },

    resetInventoryEditor: function () {
        this._inventoryCurrentItems = [];
        this._inventoryFileItems = [];
        this._inventoryFileName = '';
        const fileInput = document.getElementById('product-inventory-file');
        const textInput = document.getElementById('product-inventory-text');
        const modeSelect = document.getElementById('product-inventory-mode');
        if (fileInput) fileInput.value = '';
        if (textInput) textInput.value = '';
        if (modeSelect) modeSelect.value = 'append';
        this.previewInventoryDraft();
    },

    loadProductInventoryEditor: async function (productId) {
        this._inventoryCurrentItems = [];
        if (db && productId) {
            const snapshot = await db.ref(`productInventory/${productId}`).once('value');
            this._inventoryCurrentItems = this.normalizeInventoryItems(snapshot.val());
        }
        this._inventoryFileItems = [];
        this._inventoryFileName = '';
        const fileInput = document.getElementById('product-inventory-file');
        const textInput = document.getElementById('product-inventory-text');
        if (fileInput) fileInput.value = '';
        if (textInput) textInput.value = '';
        this.previewInventoryDraft();
    },

    previewInventoryDraft: function () {
        const currentItems = this._inventoryCurrentItems || [];
        const draftItems = this.getInventoryDraftItems();
        const mode = document.getElementById('product-inventory-mode')?.value || 'append';
        const currentValues = new Set(currentItems.map(item => item.value));
        const appendedItems = draftItems.filter(value => !currentValues.has(value));
        const predictedCount = mode === 'replace' && draftItems.length > 0
            ? draftItems.length
            : currentItems.length + appendedItems.length;

        const currentCount = document.getElementById('inventory-current-count');
        const draftCount = document.getElementById('inventory-draft-count');
        const preview = document.getElementById('inventory-preview');
        const quantityInput = document.getElementById('product-quantity');
        if (currentCount) currentCount.textContent = currentItems.length;
        if (draftCount) draftCount.textContent = draftItems.length;
        if (quantityInput && document.getElementById('source-auto')?.checked) quantityInput.value = predictedCount;

        if (!preview) return;
        if (draftItems.length === 0) {
            preview.textContent = currentItems.length > 0
                ? `Kho đang có ${currentItems.length} tài khoản. Chưa thêm dữ liệu mới.`
                : 'Chưa có dữ liệu mới.';
            return;
        }
        const sample = draftItems.slice(0, 4).map((item, index) =>
            `<span><b>${index + 1}.</b> ${this.escapeHtml(this.maskInventoryValue(item))}</span>`
        ).join('');
        preview.innerHTML = `${sample}${draftItems.length > 4 ? `<small>Và ${draftItems.length - 4} tài khoản khác</small>` : ''}`;
    },

    handleInventoryFile: async function (file) {
        if (!file) return;
        const extension = String(file.name || '').split('.').pop().toLowerCase();
        try {
            let items = [];
            if (['xlsx', 'xls', 'csv'].includes(extension)) {
                if (typeof XLSX === 'undefined') throw new Error('Thư viện đọc Excel chưa tải xong.');
                const buffer = await file.arrayBuffer();
                const workbook = XLSX.read(buffer, { type: 'array', raw: false });
                workbook.SheetNames.forEach(sheetName => {
                    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
                        header: 1,
                        raw: false,
                        defval: ''
                    });
                    rows.forEach(row => row.forEach(cell => {
                        const value = String(cell || '').trim();
                        if (value) items.push(value);
                    }));
                });
            } else {
                items = String(await file.text()).split(/\r?\n/).map(item => item.trim()).filter(Boolean);
            }
            this._inventoryFileItems = [...new Set(items)];
            this._inventoryFileName = String(file.name || '').trim();
            this.previewInventoryDraft();
            this.showToast(`Đã đọc ${this._inventoryFileItems.length} tài khoản từ ${file.name}.`, 'success');
        } catch (error) {
            this._inventoryFileItems = [];
            this._inventoryFileName = '';
            this.previewInventoryDraft();
            this.showToast('Không thể đọc file: ' + error.message, 'error');
        }
    },

    adminAddProduct: function () {
        document.getElementById('product-modal-title').innerText = 'Thêm Sản Phẩm Mới';
        document.getElementById('product-form').reset();
        document.getElementById('product-id').value = '';
        this.populateProductCategorySelect('other');
        document.getElementById('product-warranty-enabled').checked = false;
        this.toggleProductWarranty(false);
        // Reset nguồn hàng về thủ công
        document.getElementById('source-manual').checked = true;
        this.toggleProductSourceMode('manual');
        this.resetInventoryEditor();
        document.getElementById('product-modal').classList.remove('hidden');
        document.getElementById('product-modal').style.display = 'flex';
    },

    adminEditProduct: async function (pid) {
        const product = this.appState.products.find(p => p.id === pid);
        if (!product) return;

        document.getElementById('product-modal-title').innerText = 'Sửa Sản Phẩm';
        document.getElementById('product-id').value = product.id;
        document.getElementById('product-name').value = product.name || '';
        this.populateProductCategorySelect(this.getProductCategory(product));
        document.getElementById('product-duration').value = product.duration || '';
        const warrantyEnabled = this.isWarrantyEnabled(product);
        document.getElementById('product-warranty-enabled').checked = warrantyEnabled;
        document.getElementById('product-warranty').value = warrantyEnabled ? (product.warranty || '') : '';
        this.toggleProductWarranty(warrantyEnabled);
        document.getElementById('product-price').value = product.price || '';
        document.getElementById('product-quantity').value = product.quantity !== undefined ? product.quantity : 0;
        document.getElementById('product-logo').value = product.logoUrls && product.logoUrls.length > 0 ? product.logoUrls[0] : '';
        document.getElementById('product-desc').value = product.desc || '';
        document.getElementById('product-format').value = product.format || '';
        await this.loadProductInventoryEditor(product.id);

        if (this.isAutoProduct(product)) {
            document.getElementById('source-auto').checked = true;
            this.toggleProductSourceMode('inventory');
        } else {
            document.getElementById('source-manual').checked = true;
            this.toggleProductSourceMode('manual');
        }

        document.getElementById('product-modal').classList.remove('hidden');
        document.getElementById('product-modal').style.display = 'flex';
    },

    // Toggle hiển thị Thủ công / Kho giao tự động
    toggleProductSourceMode: function (mode) {
        const section = document.getElementById('inventory-config-section');
        const manualLabel = document.getElementById('source-manual-label');
        const autoLabel = document.getElementById('source-auto-label');
        const quantityInput = document.getElementById('product-quantity');
        const quantityHelp = document.getElementById('product-quantity-help');

        if (mode === 'inventory') {
            section.style.display = 'block';
            autoLabel.style.border = '2px solid var(--accent)';
            autoLabel.style.background = 'rgba(0,240,255,0.1)';
            manualLabel.style.border = '2px solid var(--card-border)';
            manualLabel.style.background = 'transparent';
            quantityInput.readOnly = true;
            if (quantityHelp) quantityHelp.textContent = 'Kho tự động: số lượng được tính từ tài khoản đã nhập.';
            this.previewInventoryDraft();
        } else {
            section.style.display = 'none';
            manualLabel.style.border = '2px solid var(--primary)';
            manualLabel.style.background = 'rgba(255,0,127,0.1)';
            autoLabel.style.border = '2px solid var(--card-border)';
            autoLabel.style.background = 'transparent';
            quantityInput.readOnly = false;
            if (quantityHelp) quantityHelp.textContent = 'Sản phẩm thủ công: admin tự nhập số lượng.';
        }
    },

    toggleProductWarranty: function (enabled) {
        const input = document.getElementById('product-warranty');
        if (!input) return;
        input.disabled = !enabled;
        if (!enabled) input.value = '';
        input.placeholder = enabled ? 'VD: 24h hoặc 7 ngày' : 'Sản phẩm không bảo hành';
    },

    closeAdminProductModal: function () {
        document.getElementById('product-modal').classList.add('hidden');
        // Wait for transition if needed, or simply force display none
        setTimeout(() => {
            document.getElementById('product-modal').style.display = '';
        }, 100);
    },

    adminSaveProduct: async function (e) {
        e.preventDefault();
        if (!db) return;

        const pid = document.getElementById('product-id').value;
        const productId = pid || ('p' + Date.now());
        const name = document.getElementById('product-name').value.trim();
        const categoryId = document.getElementById('product-category').value;
        const duration = document.getElementById('product-duration').value.trim();
        const warrantyEnabled = document.getElementById('product-warranty-enabled').checked;
        const warrantyInput = document.getElementById('product-warranty').value.trim();
        const warranty = warrantyEnabled ? (warrantyInput || 'Bảo hành') : 'Không bảo hành';
        const price = parseInt(document.getElementById('product-price').value);
        const manualQuantity = parseInt(document.getElementById('product-quantity').value);
        const logoUrl = document.getElementById('product-logo').value.trim();
        const desc = document.getElementById('product-desc').value.trim();
        const format = document.getElementById('product-format').value.trim();
        const sourceMode = document.getElementById('source-auto').checked ? 'inventory' : 'manual';

        if (!name || !categoryId || !duration || isNaN(price) || !logoUrl
            || (sourceMode === 'manual' && (isNaN(manualQuantity) || manualQuantity < 0))) {
            this.showToast("Vui lòng điền đầy đủ thông tin hợp lệ!", 'warning');
            return;
        }

        const loading = document.getElementById('loading');
        loading.classList.remove('hidden');

        let quantity = manualQuantity;
        let finalInventoryItems = this._inventoryCurrentItems || [];
        let inventoryDraftValues = [];
        let inventoryUpdateMode = 'append';
        try {
            if (sourceMode === 'inventory') {
                const draftValues = this.getInventoryDraftItems();
                const updateMode = document.getElementById('product-inventory-mode')?.value || 'append';
                inventoryDraftValues = draftValues;
                inventoryUpdateMode = updateMode;
                const inventoryResult = await db.ref(`productInventory/${productId}`).transaction(current => {
                    const hasStructuredInventory = current
                        && typeof current === 'object'
                        && (
                            Object.prototype.hasOwnProperty.call(current, 'items')
                            || Object.prototype.hasOwnProperty.call(current, 'deliveries')
                            || Object.prototype.hasOwnProperty.call(current, 'imports')
                        );
                    const state = hasStructuredInventory
                        ? {
                            ...current,
                            items: current.items || {},
                            deliveries: current.deliveries || {}
                        }
                        : { items: current || {}, deliveries: {} };
                    const latestItems = this.normalizeInventoryItems({ items: state.items });
                    let nextItems = latestItems;

                    if (updateMode === 'replace' && draftValues.length > 0) {
                        nextItems = draftValues.map((value, index) => ({
                            key: '',
                            value,
                            createdAt: Date.now() + index
                        }));
                    } else {
                        const currentByValue = new Map(latestItems.map(item => [item.value, item]));
                        draftValues.forEach((value, index) => {
                            if (!currentByValue.has(value)) {
                                currentByValue.set(value, {
                                    key: '',
                                    value,
                                    createdAt: Date.now() + index
                                });
                            }
                        });
                        nextItems = [...currentByValue.values()];
                    }

                    const inventoryMap = this.buildInventoryItemsMap(nextItems);
                    return {
                        ...state,
                        items: Object.keys(inventoryMap).length > 0 ? inventoryMap : null
                    };
                });
                if (!inventoryResult.committed) throw new Error('Kho vừa thay đổi, vui lòng thử lưu lại.');
                finalInventoryItems = this.normalizeInventoryItems(inventoryResult.snapshot.val());
                quantity = finalInventoryItems.length;
            }

            const existingProduct = this.appState.products.find(product => product.id === productId);
            const productData = {
                id: productId,
                name,
                categoryId,
                duration,
                warranty: warranty || 'Không bảo hành',
                warrantyEnabled,
                price,
                quantity,
                logoUrls: [logoUrl],
                desc,
                format,
                sourceMode,
                deliveryMode: sourceMode,
                createdAt: existingProduct?.createdAt || firebase.database.ServerValue.TIMESTAMP,
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            };
            await db.ref(`products/${productId}`).set(productData);

            if (sourceMode === 'inventory') {
                const latestSnapshot = await db.ref(`productInventory/${productId}/items`).once('value');
                quantity = this.normalizeInventoryItems({ items: latestSnapshot.val() }).length;
                await db.ref(`products/${productId}/quantity`).set(quantity);
                if (inventoryDraftValues.length > 0) {
                    await db.ref(`productInventory/${productId}/imports`).push().set({
                        submittedCount: inventoryDraftValues.length,
                        finalCount: quantity,
                        mode: inventoryUpdateMode,
                        source: this._inventoryFileName || 'Dán thủ công',
                        createdAt: firebase.database.ServerValue.TIMESTAMP,
                        createdBy: this.appState.currentUser?.username || 'admin'
                    });
                }
            }

            this._inventoryCurrentItems = finalInventoryItems;
            loading.classList.add('hidden');
            this.showToast(sourceMode === 'inventory'
                ? `Đã lưu sản phẩm và ${quantity} tài khoản trong kho.`
                : (pid ? 'Cập nhật sản phẩm thành công!' : 'Thêm sản phẩm thành công!'), 'success');
            this.closeAdminProductModal();
        } catch (error) {
            loading.classList.add('hidden');
            this.showToast((pid ? 'Lỗi cập nhật: ' : 'Lỗi thêm sản phẩm: ') + error.message, 'error');
        }
    },

    adminDeleteProduct: function (pid) {
        if (!db) return;
        if (!confirm("Bạn có chắc chắn muốn xóa sản phẩm này không?")) return;

        const loading = document.getElementById('loading');
        loading.classList.remove('hidden');

        db.ref().update({
            [`products/${pid}`]: null,
            [`productInventory/${pid}`]: null
        }).then(() => {
            loading.classList.add('hidden');
            this.showToast("Đã xóa sản phẩm thành công!");
        }).catch(err => {
            loading.classList.add('hidden');
            this.showToast("Lỗi xóa sản phẩm: " + err.message);
        });
    },

    renderAdminUsers: function () {
        const list = document.getElementById('admin-users-list');
        if (!list) return;
        const users = this.filterAdminUsers();
        if (users.length === 0) {
            list.innerHTML = '';
            const pag = document.getElementById('pagbar-admin-users');
            if (pag) pag.innerHTML = '';
            return;
        }

        this.renderPaginatedTable('admin-users-list', 'admin-users', users, (u) => {
            const tr = document.createElement('tr');
            const safeUsernameArg = encodeURIComponent(String(u.username || ''));
            const safeBalance = Number(u.balance || 0);
            tr.innerHTML = `
                <td class="font-bold">${this.escapeHtml(u.username)}</td>
                <td>${this.escapeHtml(u.email || '-')}</td>
                <td class="text-success font-bold">${this.formatMoney(safeBalance)}</td>
                <td>
                    <div class="admin-user-actions">
                        <button class="btn-primary" onclick="app.adjustUserBalance(decodeURIComponent('${safeUsernameArg}'),${safeBalance})">
                            <i class="fas fa-edit"></i> Cộng/Trừ Tiền
                        </button>
                        <button class="btn-outline admin-login-history-btn"
                            onclick="app.openAdminLoginHistory(decodeURIComponent('${safeUsernameArg}'))">
                            <i class="fas fa-clock-rotate-left"></i> Lịch sử đăng nhập
                        </button>
                        <button class="btn-outline admin-kick-btn"
                            onclick="app.adminForceLogoutUser(decodeURIComponent('${safeUsernameArg}'))">
                            <i class="fas fa-right-from-bracket"></i> Buộc đăng xuất
                        </button>
                    </div>
                </td>
            `;
            return tr;
        }, 'pagbar-admin-users');
    },

    formatLoginLocation: function (record) {
        const parts = [record?.city, record?.regionName, record?.countryName]
            .map(value => String(value || '').trim())
            .filter(Boolean);
        return [...new Set(parts)].join(', ') || 'Không xác định';
    },

    openAdminLoginHistory: async function (username) {
        if (!db || !this.appState.currentUser
            || this.appState.currentUser.username.trim().toLowerCase() !== 'admin') {
            this.showToast('Bạn không có quyền xem lịch sử đăng nhập.', 'error');
            return;
        }

        const modal = document.getElementById('admin-login-history-modal');
        const summary = document.getElementById('login-history-summary');
        const list = document.getElementById('login-history-list');
        if (!modal || !summary || !list) return;

        document.getElementById('login-history-title').textContent = 'Lịch sử đăng nhập';
        document.getElementById('login-history-subtitle').textContent = `Tài khoản: ${username}`;
        summary.innerHTML = '';
        list.innerHTML = `
            <div class="login-history-loading">
                <span class="spinner"></span>
                <p>Đang tải lịch sử...</p>
            </div>
        `;
        modal.classList.remove('hidden');
        document.body.classList.add('login-history-open');

        try {
            const snapshot = await db.ref(`loginHistory/${username}`).once('value');
            const records = Object.entries(snapshot.val() || {})
                .map(([id, record]) => ({ id, ...record }))
                .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
                .slice(0, 100);
            this.renderAdminLoginHistory(records);
        } catch (error) {
            summary.innerHTML = '';
            list.innerHTML = `
                <div class="login-history-empty">
                    <i class="fas fa-triangle-exclamation"></i>
                    <strong>Không thể tải lịch sử</strong>
                    <span>${this.escapeHtml(error.message || 'Vui lòng thử lại.')}</span>
                </div>
            `;
        }
    },

    renderAdminLoginHistory: function (records) {
        const summary = document.getElementById('login-history-summary');
        const list = document.getElementById('login-history-list');
        if (!summary || !list) return;

        const uniqueIps = new Set(records.map(record => record.ip).filter(ip => ip && ip !== 'Không xác định'));
        const uniqueLocations = new Set(records.map(record => this.formatLoginLocation(record))
            .filter(location => location !== 'Không xác định'));
        const uniqueDevices = new Set(records.map(record =>
            [record.deviceType, record.os, record.browser].filter(Boolean).join('|')
        ).filter(Boolean));
        const latest = records[0];

        summary.innerHTML = `
            <div class="login-summary-item">
                <i class="fas fa-right-to-bracket"></i>
                <span><strong>${records.length}</strong><small>Lần đăng nhập</small></span>
            </div>
            <div class="login-summary-item">
                <i class="fas fa-network-wired"></i>
                <span><strong>${uniqueIps.size}</strong><small>Địa chỉ IP</small></span>
            </div>
            <div class="login-summary-item">
                <i class="fas fa-location-dot"></i>
                <span><strong>${uniqueLocations.size}</strong><small>Khu vực</small></span>
            </div>
            <div class="login-summary-item">
                <i class="fas fa-laptop"></i>
                <span><strong>${uniqueDevices.size}</strong><small>Thiết bị</small></span>
            </div>
            ${latest ? `
                <div class="login-summary-latest">
                    Gần nhất: <strong>${this.escapeHtml(latest.date || new Date(Number(latest.timestamp || 0)).toLocaleString('vi-VN'))}</strong>
                    tại ${this.escapeHtml(this.formatLoginLocation(latest))}
                </div>
            ` : ''}
        `;

        if (records.length === 0) {
            list.innerHTML = `
                <div class="login-history-empty">
                    <i class="fas fa-clock-rotate-left"></i>
                    <strong>Chưa có lịch sử đăng nhập</strong>
                    <span>Lịch sử sẽ xuất hiện từ lần đăng nhập thành công tiếp theo.</span>
                </div>
            `;
            return;
        }

        list.innerHTML = records.map((record, index) => {
            const location = this.formatLoginLocation(record);
            const safeIp = encodeURIComponent(String(record.ip || 'Không xác định'));
            const timeText = record.date
                || (record.timestamp ? new Date(Number(record.timestamp)).toLocaleString('vi-VN') : '-');
            const deviceText = [record.deviceType, record.os, record.browser].filter(Boolean).join(' • ') || 'Không xác định';
            const regionMeta = [
                record.regionCode,
                record.countryCode,
                record.timezone
            ].filter(Boolean).join(' • ');
            return `
                <article class="login-history-item ${index === 0 ? 'is-latest' : ''}">
                    <div class="login-history-item-icon">
                        <i class="fas ${record.deviceType === 'Điện thoại' ? 'fa-mobile-screen-button' : 'fa-display'}"></i>
                    </div>
                    <div class="login-history-main">
                        <div class="login-history-item-heading">
                            <strong>${this.escapeHtml(timeText)}</strong>
                            ${index === 0 ? '<span class="login-latest-badge">Mới nhất</span>' : ''}
                            ${record.environment === 'local' ? '<span class="login-local-badge">Localhost</span>' : ''}
                        </div>
                        <span class="login-device" title="${this.escapeHtml(record.userAgent || '')}">
                            ${this.escapeHtml(deviceText)}
                        </span>
                        <span class="login-location">
                            <i class="fas fa-location-dot"></i> ${this.escapeHtml(location)}
                            ${regionMeta ? `<small>${this.escapeHtml(regionMeta)}</small>` : ''}
                        </span>
                    </div>
                    <div class="login-history-ip">
                        <small>Địa chỉ IP</small>
                        <code>${this.escapeHtml(record.ip || 'Không xác định')}</code>
                        <button type="button" class="btn-icon" title="Sao chép IP"
                            onclick="app.copyText(decodeURIComponent('${safeIp}'))">
                            <i class="far fa-copy"></i>
                        </button>
                    </div>
                    <span class="login-source-badge">
                        ${record.source === 'register' ? 'Tạo tài khoản' : 'Đăng nhập'}
                    </span>
                </article>
            `;
        }).join('');
    },

    closeAdminLoginHistory: function (event) {
        if (event && event.target !== event.currentTarget) return;
        const modal = document.getElementById('admin-login-history-modal');
        if (modal) modal.classList.add('hidden');
        document.body.classList.remove('login-history-open');
    },

    adminForceLogoutUser: async function (username) {
        if (!db || !this.appState.currentUser
            || this.appState.currentUser.username.trim().toLowerCase() !== 'admin') {
            this.showToast('Bạn không có quyền thực hiện thao tác này.', 'error');
            return;
        }

        const isCurrentAdmin = username.trim().toLowerCase()
            === this.appState.currentUser.username.trim().toLowerCase();
        const confirmMessage = isCurrentAdmin
            ? 'Bạn đang chọn chính tài khoản admin. Tiếp tục sẽ đăng xuất phiên quản trị hiện tại và mọi phiên admin khác.'
            : `Buộc đăng xuất tài khoản “${username}” trên tất cả thiết bị?`;
        if (!confirm(confirmMessage)) return;

        const reason = prompt('Nhập lý do đăng xuất:', 'Admin kết thúc phiên đăng nhập');
        if (reason === null) return;

        const loading = document.getElementById('loading');
        loading?.classList.remove('hidden');
        try {
            const result = await db.ref(`users/${username}`).transaction(user => {
                if (!user) return;
                return {
                    ...user,
                    sessionVersion: Number(user.sessionVersion || 0) + 1,
                    forceLogoutAt: Date.now(),
                    forceLogoutReason: reason.trim() || 'Admin kết thúc phiên đăng nhập',
                    forceLogoutBy: this.appState.currentUser?.username || 'admin'
                };
            });
            if (!result.committed) throw new Error('Không tìm thấy tài khoản.');
            loading?.classList.add('hidden');
            if (!isCurrentAdmin) {
                this.showToast(`Đã buộc “${username}” đăng xuất trên tất cả thiết bị.`, 'success');
            }
        } catch (error) {
            loading?.classList.add('hidden');
            this.showToast('Không thể buộc đăng xuất: ' + error.message, 'error');
        }
    },


    adjustUserBalance: function (username, currentBalance) {
        const amountStr = prompt(`Người dùng: ${username}\nSố dư hiện tại: ${this.formatMoney(currentBalance)}\n\nNhập số tiền muốn cộng (nhập số âm nếu muốn trừ):`, '0');
        if (amountStr === null) return;

        const amount = parseInt(amountStr);
        if (isNaN(amount) || amount === 0) {
            this.showToast("Số tiền không hợp lệ!");
            return;
        }

        const note = prompt("Nhập lý do (Sẽ lưu vào lịch sử):", "Admin điều chỉnh số dư");
        if (note === null) return;

        const loading = document.getElementById('loading');
        loading.classList.remove('hidden');

        this.adjustUserBalanceBy(username, amount).then(() => {
            // Log transaction
            const logEntry = {
                type: amount > 0 ? 'Admin Cộng Tiền' : 'Admin Trừ Tiền',
                amount: amount,
                note: note,
                timestamp: Date.now(),
                date: new Date().toLocaleDateString('vi-VN') + ' ' + new Date().toLocaleTimeString('vi-VN')
            };
            db.ref('users/' + username + '/transaction_logs').push(logEntry);

            this.showToast(`Đã ${amount > 0 ? 'cộng' : 'trừ'} ${this.formatMoney(Math.abs(amount))} cho ${username} thành công!`);
            loading.classList.add('hidden');
        }).catch(err => {
            this.showToast("Lỗi cập nhật số dư: " + err.message);
            loading.classList.add('hidden');
        });
    },

    // --- OTP System ---
    otpState: {
        baseUrl: 'https://chaycodeso3.com/api',
        priceMul: 3000,   // hệ số giá bán = giá gốc × priceMul (đồng bộ từ settings/config)
        fixedApps: [
            { "Id": 1095, "Name": "Amazon" },
            { "Id": 1561, "Name": "Binance" },
            { "Id": 1869, "Name": "Claude" },
            { "Id": 1195, "Name": "Dịch Vụ Khác" },
            { "Id": 1001, "Name": "Facebook" },
            { "Id": 1160, "Name": "Garena" },
            { "Id": 1005, "Name": "Gmail/Google" },
            { "Id": 1021, "Name": "Grab" },
            { "Id": 1432, "Name": "Highlands" },
            { "Id": 1247, "Name": "Id Apple" },
            { "Id": 1010, "Name": "Instagram" },
            { "Id": 1656, "Name": "Katinat" },
            { "Id": 1007, "Name": "Lazada" },
            { "Id": 1034, "Name": "Momo" },
            { "Id": 1102, "Name": "My Viettel" },
            { "Id": 1301, "Name": "MY VNPT/ DIGILIFE/MYTV/VNPT Money" },
            { "Id": 1289, "Name": "Netflix" },
            { "Id": 1090, "Name": "Paypal" },
            { "Id": 1136, "Name": "Roblox" },
            { "Id": 1002, "Name": "Shopee/shopee pay" },
            { "Id": 1472, "Name": "Shopee Food" },
            { "Id": 1006, "Name": "Telegram" },
            { "Id": 1097, "Name": "Tiki" },
            { "Id": 1032, "Name": "TikTok" },
            { "Id": 1030, "Name": "Twitter" },
            { "Id": 1477, "Name": "VNPAY" },
            { "Id": 1022, "Name": "wechat" },
            { "Id": 1024, "Name": "WhatsApp" },
            { "Id": 1425, "Name": "Youtube" },
            { "Id": 1176, "Name": "ZaloPay" }
        ],
        currentReqId: null,
        backgroundPollTimer: null,
        _resolvedOTPs: {},
        appPrices: {},
        appNotes: {},
        _pendingNoteRent: null,
        _pendingSpecificRent: null,
        activeCategory: 'all',
        pageSize: 36,
        filteredApps: [],
        renderedCount: 0,
        priceFetchedAt: 0,
        priceFetchPromise: null,
        searchTimer: null,
        priceCacheTtlMs: 2 * 60 * 1000,
        adminCatalogApps: [],
        adminSelectedAppIds: new Set(),
        adminAppQuery: '',
        adminAppRenderLimit: 120,
        adminAppSearchTimer: null,
        popularIds: [1001, 1005, 1006, 1002, 1032, 1024, 1034, 1176],
        categoryMap: {
            social: [1001, 1010, 1006, 1032, 1030, 1022, 1024, 1425],
            shopping: [1095, 1007, 1002, 1472, 1097],
            finance: [1561, 1034, 1090, 1477, 1176],
            local: [1021, 1432, 1656, 1102, 1301],
            ai: [1869],
            game: [1160, 1136]
        }
    },

    fetchWithProxy: function (targetUrl) {
        // Trình duyệt chỉ gửi tham số nghiệp vụ. OTP key luôn nằm trong Netlify Function.
        const sourceUrl = new URL(targetUrl, window.location.origin);
        const allowedParams = ['act', 'appId', 'number', 'carrier', 'prefix', 'id', 'scope'];
        const safeParams = new URLSearchParams();
        allowedParams.forEach(key => {
            const value = sourceUrl.searchParams.get(key);
            if (value !== null && value !== '') safeParams.set(key, value);
        });
        safeParams.set('_t', String(Date.now()));

        return fetch(`/api/otp-raw?${safeParams.toString()}`)
            .then(res => {
                if (!res.ok) throw new Error("Backend proxy lỗi (" + res.status + ")");
                return res.json();
            })
            .catch(err => {
                console.error("Backend OTP không khả dụng.", err);
                throw new Error('Không thể kết nối máy chủ OTP an toàn. Vui lòng thử lại sau.');
            });
    },

    startBackgroundOTPPoller: function () {
        if (this.otpState.backgroundPollTimer) {
            clearInterval(this.otpState.backgroundPollTimer);
        }
        this.pollPendingOTPs();
        this.otpState.backgroundPollTimer = setInterval(() => {
            this.pollPendingOTPs();
        }, 5000);
    },

    stopBackgroundOTPPoller: function () {
        if (this.otpState.backgroundPollTimer) {
            clearInterval(this.otpState.backgroundPollTimer);
            this.otpState.backgroundPollTimer = null;
        }
    },

    renderOTPPendingBar: function () {
        const bar = document.getElementById('otp-active-request');
        if (!bar) return;

        const now = Date.now();
        const pending = (this.appState.otpHistory || []).filter(h => h.status === 'Đang chờ mã');
        const resolved = Object.values(this.otpState._resolvedOTPs || {}).filter(r => (now - r.resolvedAt) < 35000);

        if (pending.length === 0 && resolved.length === 0) {
            bar.classList.add('hidden');
            bar.innerHTML = '';
            return;
        }

        bar.classList.remove('hidden');

        const rows = [
            ...pending.map(h => ({ appName: h.appName, phone: h.phone, _type: 'pending', code: '' })),
            ...resolved.map(r => ({ appName: r.appName, phone: r.phone, _type: r.isSuccess ? 'success' : 'cancelled', code: r.code || '' }))
        ];

        bar.innerHTML = `
            <div class="otp-pending-header"><i class="fas fa-clock"></i> Đơn đang chờ mã OTP</div>
            <div class="otp-pending-list">
                ${rows.map(h => {
                    const phone = this.normalizeVietnamPhone(h.phone || '');
                    const phoneSafe = phone.replace(/\s/g, '');
                    let statusHtml;
                    if (h._type === 'pending') {
                        statusHtml = `<span style="color:var(--text-muted)"><i class="fas fa-spinner fa-spin"></i> Đang chờ...</span>`;
                    } else if (h._type === 'success') {
                        statusHtml = `<span class="otp-pending-code">${this.escapeHtml(h.code)}</span>`;
                    } else {
                        statusHtml = `<span style="color:var(--danger)"><i class="fas fa-times-circle"></i> Đã hủy</span>`;
                    }
                    return `<div class="otp-pending-item ${h._type === 'success' ? 'is-success' : h._type === 'cancelled' ? 'is-cancelled' : ''}">
                        <span class="otp-pending-app">${this.escapeHtml(h.appName || '')}</span>
                        <span class="otp-pending-phone">${phone}</span>
                        <button class="btn-outline" style="padding:3px 10px;font-size:0.8rem;flex-shrink:0"
                            onclick="app.copyText('${phoneSafe}')"><i class="far fa-copy"></i></button>
                        <span class="otp-pending-status">${statusHtml}</span>
                    </div>`;
                }).join('')}
            </div>`;
    },

    pollPendingOTPs: function () {
        if (!this.appState.currentUser || !db) return;
        if (!this.otpState._pollingInProgress) this.otpState._pollingInProgress = new Set();

        const now = Date.now();
        const pendingOTPs = (this.appState.otpHistory || []).filter(h =>
            h.status === 'Đang chờ mã' && !h.refundedAt && (now - h.timestamp) < 310000
        );

        if (pendingOTPs.length === 0) return;

        pendingOTPs.forEach(otpRecord => {
            const reqId = otpRecord.id;
            if (this.otpState._pollingInProgress.has(reqId)) return;
            this.otpState._pollingInProgress.add(reqId);

            const price = otpRecord.price;
            const username = this.appState.currentUser.username;
            const elapsed = now - otpRecord.timestamp;

            if (elapsed >= 300000) {
                this.refundOTPRequest(username, reqId, price, 'Đã hoàn tiền (Hết thời gian)')
                    .finally(() => this.otpState._pollingInProgress.delete(reqId));
                return;
            }

            const targetUrl = `${this.otpState.baseUrl}?act=code&id=${reqId}`;
            this.fetchWithProxy(targetUrl)
                .then(data => {
                    if (!this.appState.currentUser) return;
                    if (data.ResponseCode === 0 && data.Result && data.Result.Code) {
                        db.ref('users/' + username + '/otp_history/' + reqId).update({
                            status: 'Thành công',
                            code: data.Result.Code
                        });
                        // Bar & toast được xử lý bởi listenToOTPHistory
                    } else if (data.ResponseCode === 2) {
                        this.refundOTPRequest(username, reqId, price, 'Đã hoàn tiền (Số bị hủy)');
                    }
                })
                .catch(err => console.error(`[BgPoll] OTP ${reqId}:`, err))
                .finally(() => this.otpState._pollingInProgress.delete(reqId));
        });
    },

    getOTPAppLogo: function (appId, appName, appEntry = null) {
        // Ưu tiên URL ảnh admin đã nhập thủ công (lưu trong Firebase/fixedApps)
        const configuredApp = appEntry || this.otpState.fixedApps.find(a => a.Id == appId);
        if (configuredApp && configuredApp.imageUrl) {
            return {
                initial: (appName || '?').trim().charAt(0).toUpperCase() || '?',
                url: configuredApp.imageUrl,
                isCustom: true
            };
        }

        const logoMap = {
            1095: 'amazon.com',
            1561: 'binance.com',
            1869: 'claude.ai',
            1001: 'facebook.com',
            1160: 'garena.vn',
            1005: 'google.com',
            1021: 'grab.com',
            1432: 'highlandscoffee.com.vn',
            1247: 'apple.com',
            1010: 'instagram.com',
            1656: 'katinat.vn',
            1007: 'lazada.vn',
            1034: 'momo.vn',
            1102: 'viettel.vn',
            1301: 'vnpt.com.vn',
            1289: 'netflix.com',
            1090: 'paypal.com',
            1136: 'roblox.com',
            1002: 'shopee.vn',
            1472: 'shopee.vn',
            1006: 'telegram.org',
            1097: 'tiki.vn',
            1032: 'tiktok.com',
            1030: 'x.com',
            1477: 'vnpay.vn',
            1022: 'wechat.com',
            1024: 'whatsapp.com',
            1425: 'youtube.com',
            1176: 'zalopay.vn'
        };

        const domain = logoMap[appId];
        const initial = (appName || '?').trim().charAt(0).toUpperCase();
        return {
            initial: initial || '?',
            url: domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=96` : ''
        };
    },

    renderOTPAppLogo: function (appId, appName, appEntry = null) {
        const logo = this.getOTPAppLogo(appId, appName, appEntry);
        const safeInitial = this.escapeHtml(logo.initial);
        const fallback = `<span class="otp-app-logo-fallback">${safeInitial}</span>`;
        if (!logo.url) return fallback;
        return `
            <span class="otp-app-logo-wrap">
                <img class="otp-app-logo" src="${this.escapeHtml(logo.url)}" alt="" loading="lazy"
                    onerror="app.handleOTPLogoError(this, '${logo.initial.replace(/'/g, "\\'")}')">
            </span>
        `;
    },

    handleOTPLogoError: function (img, initial) {
        const wrap = img ? img.closest('.otp-app-logo-wrap') : null;
        if (wrap) {
            wrap.outerHTML = `<span class="otp-app-logo-fallback">${initial || '?'}</span>`;
        }
    },

    getOTPCategory: function (appId, appEntry = null) {
        // Ưu tiên category do admin gán (lưu trong Firebase/fixedApps)
        const configuredApp = appEntry || this.otpState.fixedApps.find(a => a.Id == appId);
        if (configuredApp && configuredApp.category) return configuredApp.category;
        // Fallback về categoryMap hardcode
        for (const [category, ids] of Object.entries(this.otpState.categoryMap)) {
            if (ids.includes(Number(appId))) return category;
        }
        return 'other';
    },

    renderOTPFilters: function () {
        const container = document.getElementById('otp-apps-container');
        if (!container || document.getElementById('otp-filter-bar')) return;
        const bar = document.createElement('div');
        bar.id = 'otp-filter-bar';
        bar.className = 'otp-filter-bar';
        const filters = [
            ['all', 'Tất cả'],
            ['popular', 'Phổ biến'],
            ['social', 'Mạng xã hội'],
            ['shopping', 'Mua sắm'],
            ['finance', 'Ví tiền'],
            ['local', 'Việt Nam'],
            ['ai', 'AI'],
            ['game', 'Game']
        ];
        bar.innerHTML = filters.map(([key, label]) => `
            <button class="otp-filter-btn ${key === this.otpState.activeCategory ? 'active' : ''}"
                data-otp-filter="${key}" onclick="app.setOTPFilter('${key}', this)">${label}</button>
        `).join('');
        container.parentNode.insertBefore(bar, container);
    },

    setOTPFilter: function (category, btn) {
        this.otpState.activeCategory = category || 'all';
        document.querySelectorAll('.otp-filter-btn').forEach(b => b.classList.toggle('active', b === btn || b.dataset.otpFilter === this.otpState.activeCategory));
        this.applyOTPFilters();
    },

    applyOTPFilters: function () {
        const input = document.getElementById('otp-search-input');
        const query = this.normalizeText(input ? input.value : '');
        const active = this.otpState.activeCategory || 'all';
        const seenIds = new Set();

        this.otpState.filteredApps = (this.otpState.fixedApps || []).filter(fixedApp => {
            const appId = Number(fixedApp && fixedApp.Id);
            if (!Number.isFinite(appId) || seenIds.has(appId)) return false;
            seenIds.add(appId);

            const name = this.normalizeText(fixedApp.Name || '');
            const category = this.getOTPCategory(appId, fixedApp);
            const popular = this.otpState.popularIds.includes(appId);
            const matchesSearch = !query || name.includes(query);
            const matchesCategory = active === 'all' || (active === 'popular' ? popular : category === active);
            return matchesSearch && matchesCategory;
        });

        this.otpState.renderedCount = Math.min(this.otpState.pageSize, this.otpState.filteredApps.length);
        this.renderOTPAppPage();
    },

    bindOTPAppActions: function (container) {
        if (!container || container.dataset.otpActionsBound === '1') return;
        container.dataset.otpActionsBound = '1';
        container.addEventListener('click', event => {
            const button = event.target.closest('[data-otp-action]');
            if (!button || !container.contains(button)) return;
            event.stopPropagation();

            const action = button.dataset.otpAction;
            if (action === 'load-more') {
                this.loadMoreOTPApps();
                return;
            }

            const appId = Number(button.dataset.otpAppId);
            const fixedApp = this.otpState.fixedApps.find(item => Number(item.Id) === appId);
            if (!fixedApp) return;
            if (action === 'rent-random') this.rentOTP(appId, String(fixedApp.Name || ''));
            if (action === 'rent-specific') this.rentSpecificOTP(appId, String(fixedApp.Name || ''));
        });
    },

    createOTPAppCard: function (fixedApp) {
        const appId = Number(fixedApp.Id);
        const appName = String(fixedApp.Name || 'Ứng dụng');
        const safeName = this.escapeHtml(appName);
        const baseCost = Number(this.otpState.appPrices[appId]) || 1;
        const sellPrice = baseCost * this.otpState.priceMul;
        const hasNote = !!this.otpState.appNotes[appId];
        const card = document.createElement('div');

        card.className = 'otp-app-card' + (hasNote ? ' has-note' : '');
        card.id = `otp-app-card-${appId}`;
        card.dataset.otpName = appName;
        card.dataset.otpCategory = this.getOTPCategory(appId, fixedApp);
        card.dataset.otpPopular = this.otpState.popularIds.includes(appId) ? '1' : '0';
        const noteBadge = hasNote ? '<span class="otp-app-note-badge" title="Có ghi chú từ Admin"><i class="fas fa-exclamation"></i></span>' : '';

        card.innerHTML = `
            ${noteBadge}
            <div>
                ${this.renderOTPAppLogo(appId, appName, fixedApp)}
                <div class="otp-app-name" title="${safeName}">${safeName}</div>
            </div>
            <div class="otp-card-actions">
                <div class="otp-app-price" id="otp-price-disp-${appId}">${this.formatMoney(sellPrice)}</div>
                <button type="button" class="btn-primary btn-full otp-app-btn"
                    data-otp-action="rent-random" data-otp-app-id="${appId}">Thuê Ngẫu Nhiên</button>
                <button type="button" class="btn-outline btn-full otp-specific-btn"
                    data-otp-action="rent-specific" data-otp-app-id="${appId}"><i class="fas fa-mobile-alt"></i> Nhập Số</button>
            </div>
        `;
        return card;
    },

    renderOTPAppFooter: function () {
        const container = document.getElementById('otp-apps-container');
        if (!container) return;
        const oldFooter = container.querySelector('.otp-list-footer');
        if (oldFooter) oldFooter.remove();

        const total = this.otpState.filteredApps.length;
        const visible = Math.min(this.otpState.renderedCount, total);
        const footer = document.createElement('div');
        footer.className = 'otp-list-footer';

        if (total === 0) {
            footer.classList.add('is-empty');
            footer.innerHTML = '<i class="fas fa-search"></i><strong>Không tìm thấy ứng dụng</strong><span>Thử từ khóa hoặc nhóm khác.</span>';
        } else if (visible < total) {
            footer.innerHTML = `
                <span>Đang hiển thị <strong>${visible}</strong> / ${total} ứng dụng</span>
                <button type="button" class="btn-outline" data-otp-action="load-more">Xem thêm ${Math.min(this.otpState.pageSize, total - visible)} app</button>
            `;
        } else {
            footer.innerHTML = `<span>Đã hiển thị đủ <strong>${total}</strong> ứng dụng</span>`;
        }
        container.appendChild(footer);
    },

    renderOTPAppPage: function () {
        const container = document.getElementById('otp-apps-container');
        if (!container) return;
        const fragment = document.createDocumentFragment();
        this.otpState.filteredApps.slice(0, this.otpState.renderedCount).forEach(fixedApp => {
            fragment.appendChild(this.createOTPAppCard(fixedApp));
        });

        container.replaceChildren(fragment);
        this.renderOTPAppFooter();
        this.initTiltEffects(container);
    },

    loadMoreOTPApps: function () {
        const container = document.getElementById('otp-apps-container');
        if (!container) return;
        const start = this.otpState.renderedCount;
        const end = Math.min(start + this.otpState.pageSize, this.otpState.filteredApps.length);
        if (end <= start) return;

        const footer = container.querySelector('.otp-list-footer');
        const fragment = document.createDocumentFragment();
        this.otpState.filteredApps.slice(start, end).forEach(fixedApp => {
            fragment.appendChild(this.createOTPAppCard(fixedApp));
        });
        container.insertBefore(fragment, footer || null);
        this.otpState.renderedCount = end;
        this.renderOTPAppFooter();
        this.initTiltEffects(container);
    },

    hydrateOTPPriceCache: function () {
        if (this.otpState.priceCacheHydrated) return;
        this.otpState.priceCacheHydrated = true;
        try {
            const cachedPrices = localStorage.getItem('otp_app_prices');
            const cachedAt = Number(localStorage.getItem('otp_app_prices_updated_at')) || 0;
            if (cachedPrices) Object.assign(this.otpState.appPrices, JSON.parse(cachedPrices));
            if (cachedAt > 0) this.otpState.priceFetchedAt = cachedAt;
        } catch (e) { /* ignore cache errors */ }
    },

    updateVisibleOTPPrices: function () {
        document.querySelectorAll('#otp-apps-container .otp-app-card').forEach(card => {
            const appId = Number(card.id.replace('otp-app-card-', ''));
            const baseCost = Number(this.otpState.appPrices[appId]) || 1;
            const priceElem = card.querySelector('.otp-app-price');
            if (priceElem) priceElem.innerText = this.formatMoney(baseCost * this.otpState.priceMul);
        });
    },

    refreshOTPAppPrices: function () {
        const now = Date.now();
        if (this.otpState.priceFetchPromise) return this.otpState.priceFetchPromise;
        if (this.otpState.priceFetchedAt && now - this.otpState.priceFetchedAt < this.otpState.priceCacheTtlMs) {
            this.updateVisibleOTPPrices();
            return Promise.resolve();
        }

        // scope=selected để backend chỉ trả catalog đang bán thay vì toàn bộ app của web mẹ.
        const targetUrl = `${this.otpState.baseUrl}?act=app&scope=selected`;
        this.otpState.priceFetchPromise = this.fetchWithProxy(targetUrl)
            .then(data => {
                if (data.ResponseCode !== 0 || !Array.isArray(data.Result)) return;
                data.Result.forEach(apiApp => {
                    const appId = Number(apiApp.Id);
                    const baseCost = Number(apiApp.Cost);
                    if (Number.isFinite(appId) && Number.isFinite(baseCost)) {
                        this.otpState.appPrices[appId] = baseCost;
                    }
                });
                this.otpState.priceFetchedAt = Date.now();
                this.updateVisibleOTPPrices();
                try {
                    localStorage.setItem('otp_app_prices', JSON.stringify(this.otpState.appPrices));
                    localStorage.setItem('otp_app_prices_updated_at', String(this.otpState.priceFetchedAt));
                } catch (e) { /* ignore cache errors */ }
            })
            .catch(err => console.error('Background Load Apps Error:', err))
            .finally(() => { this.otpState.priceFetchPromise = null; });
        return this.otpState.priceFetchPromise;
    },

    loadOTPApps: function () {
        const container = document.getElementById('otp-apps-container');
        if (!container) return;
        this.renderOTPFilters();
        this.bindOTPAppActions(container);
        this.hydrateOTPPriceCache();
        this.applyOTPFilters();
        this.refreshOTPAppPrices();

        // Fetch OTP app notes from Firebase
        this.loadOTPAppNotes();
    },

    loadSelectedAppsFromFirebase: function () {
        // Load từ localStorage cache trước để có ngay lập tức
        try {
            const cached = localStorage.getItem('otp_selected_apps');
            if (cached) {
                const list = JSON.parse(cached);
                if (Array.isArray(list) && list.length > 0) this.otpState.fixedApps = list;
            }
        } catch (e) { /* ignore */ }
        if (!db) return;
        db.ref('settings/selectedApps').once('value').then(snap => {
            const data = snap.val();
            if (Array.isArray(data) && data.length > 0) {
                const previousIds = this.otpState.fixedApps.map(item => Number(item.Id)).join(',');
                const nextIds = data.map(item => Number(item.Id)).join(',');
                this.otpState.fixedApps = data;
                if (previousIds !== nextIds) this.otpState.priceFetchedAt = 0;
                try { localStorage.setItem('otp_selected_apps', JSON.stringify(data)); } catch (e) {}
                const otpView = document.getElementById('view-otp');
                if (otpView && otpView.classList.contains('active')) this.loadOTPApps();
            }
        });
    },

    // Chỉ đồng bộ URL và hệ số công khai. OTP key chỉ tồn tại phía server.
    loadOTPConfigFromFirebase: function () {
        if (!db) return;
        db.ref('settings/config/otpBaseUrl').on('value', snap => {
            if (snap.val()) this.otpState.baseUrl = snap.val();
        });
        db.ref('settings/config/priceMultiplier').on('value', snap => {
            if (Number(snap.val()) > 0) this.otpState.priceMul = Number(snap.val());
        });
    },

    loadOTPAppNotes: function () {
        if (!db) return;
        db.ref('otp_app_notes').once('value').then(snap => {
            const raw = snap.val() || {};
            const notes = {};
            Object.keys(raw).forEach(k => { notes[k] = typeof raw[k] === 'string' ? raw[k] : ''; });
            this.otpState.appNotes = notes;
            // Update card badges
            this.otpState.fixedApps.forEach(fixedApp => {
                const card = document.getElementById(`otp-app-card-${fixedApp.Id}`);
                if (!card) return;
                const hasNote = !!(notes[fixedApp.Id]);
                const existingBadge = card.querySelector('.otp-app-note-badge');
                if (hasNote && !existingBadge) {
                    card.classList.add('has-note');
                    const badge = document.createElement('span');
                    badge.className = 'otp-app-note-badge';
                    badge.title = 'Có ghi chú từ Admin';
                    badge.innerHTML = '<i class="fas fa-exclamation"></i>';
                    card.insertBefore(badge, card.firstChild);
                } else if (!hasNote && existingBadge) {
                    card.classList.remove('has-note');
                    existingBadge.remove();
                }
            });
        }).catch(err => console.error('Load OTP notes error:', err));
    },

    rentOTP: function (appId, appName) {
        const baseCost = this.otpState.appPrices[appId] || 1;
        const price = baseCost * this.otpState.priceMul;
        if (!this.appState.currentUser) {
            this.showToast("Vui lòng đăng nhập để thuê OTP.", 'warning');
            this.navigate('login');
            return;
        }

        const currentBal = this.appState.currentUser.balance || 0;
        if (currentBal < price) {
            this.showToast(`Số dư không đủ! Bạn cần nạp thêm ${this.formatMoney(price - currentBal)}.`);
            this.navigate('deposit');
            return;
        }

        // Check if app has admin note - show modal first
        const appNote = this.otpState.appNotes[appId];
        if (appNote && appNote.trim()) {
            this.showOTPNoteModal(appId, appName, price, appNote);
            return;
        }

        if (!confirm(`Thuê số OTP cho ${appName} với giá ${this.formatMoney(price)}? Hệ thống sẽ tự động hoàn tiền nếu không có mã.`)) return;

        this._proceedRentOTP(appId, appName, price);
    },

    rebuyOTP: function (appId, appName, phone, reqId) {
        if (!this.appState.currentUser) {
            this.showToast("Vui lòng đăng nhập để thuê OTP.", 'warning');
            this.navigate('login');
            return;
        }

        const dispPhone = this.normalizeVietnamPhone(phone) || phone;

        // Nếu reqId được truyền vào, kiểm tra xem session có đang pending không
        if (reqId) {
            const existingRecord = (this.appState.otpHistory || []).find(h => h.id === reqId);
            if (existingRecord && existingRecord.status === 'Đang chờ mã') {
                this.showToast(`Số ${dispPhone} đang chờ OTP. Xem thanh trạng thái bên trên.`, 'info');
                this.navigate('otp');
                return;
            }
        }

        const baseCost = this.otpState.appPrices[appId] || 1;
        const price = baseCost * this.otpState.priceMul;
        const currentBal = this.appState.currentUser.balance || 0;
        if (currentBal < price) {
            this.showToast(`Số dư không đủ! Bạn cần nạp thêm ${this.formatMoney(price - currentBal)}.`);
            this.navigate('deposit');
            return;
        }

        if (!confirm(`Mua lại số ${dispPhone} cho ${appName} với giá ${this.formatMoney(price)}?\nHệ thống sẽ tự động hoàn tiền nếu số hết hoặc không nhận được mã.`)) return;

        this._proceedRentWithPhone(appId, appName, price, phone, dispPhone);
    },

    showOTPWaitScreen: function (appName, phoneNumber, reqId, price) {
        this.otpState.currentReqId = reqId;
        // Bar được render tự động bởi listenToOTPHistory → renderOTPPendingBar
    },

    // --- OTP App Notes System ---
    showOTPNoteModal: function (appId, appName, price, noteText) {
        // Preserve extra fields (e.g. specificPhone) if already set by caller before this is invoked
        this.otpState._pendingNoteRent = { ...(this.otpState._pendingNoteRent || {}), appId, appName, price };
        const modal = document.getElementById('otp-note-modal');
        const nameEl = document.getElementById('otp-note-modal-app-name');
        const bodyEl = document.getElementById('otp-note-modal-body');
        if (!modal || !bodyEl) return;

        if (nameEl) nameEl.textContent = `Lưu ý khi thuê ${appName}`;
        bodyEl.innerHTML = `
            <div class="otp-note-content-block">${this.escapeHtml(noteText)}</div>
            <div style="margin-top:14px;padding:10px 14px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);border-radius:10px;font-size:0.88rem;color:var(--text-muted);">
                <i class="fas fa-coins" style="color:var(--accent);margin-right:6px;"></i>
                Giá thuê: <strong style="color:var(--accent);">${this.formatMoney(price)}</strong>
                &bull; Hệ thống tự động hoàn tiền nếu không có mã.
            </div>
        `;
        modal.classList.remove('hidden');
    },

    closeOTPNoteModal: function (event) {
        if (event && event.target !== event.currentTarget) return;
        const modal = document.getElementById('otp-note-modal');
        if (modal) modal.classList.add('hidden');
        this.otpState._pendingNoteRent = null;
    },

    confirmRentAfterNote: function () {
        const pending = this.otpState._pendingNoteRent;
        if (!pending) return;
        const { appId, appName, price, specificPhone } = pending;

        const modal = document.getElementById('otp-note-modal');
        if (modal) modal.classList.add('hidden');
        this.otpState._pendingNoteRent = null;

        if (specificPhone) {
            if (!confirm(`Thuê số ${specificPhone} cho ${appName} với giá ${this.formatMoney(price)}?\nHệ thống tự động hoàn tiền nếu số không có trong kho hoặc không có OTP.`)) return;
            this._proceedRentWithPhone(appId, appName, price, specificPhone);
        } else {
            if (!confirm(`Thuê số OTP cho ${appName} với giá ${this.formatMoney(price)}? Hệ thống sẽ tự động hoàn tiền nếu không có mã.`)) return;
            this._proceedRentOTP(appId, appName, price);
        }
    },

    rentSpecificOTP: function (appId, appName) {
        if (!this.appState.currentUser) {
            this.showToast("Vui lòng đăng nhập để thuê OTP.", 'warning');
            this.navigate('login');
            return;
        }
        const baseCost = this.otpState.appPrices[appId] || 1;
        const price = baseCost * this.otpState.priceMul;
        const currentBal = this.appState.currentUser.balance || 0;
        if (currentBal < price) {
            this.showToast(`Số dư không đủ! Bạn cần nạp thêm ${this.formatMoney(price - currentBal)}.`);
            this.navigate('deposit');
            return;
        }

        this.otpState._pendingSpecificRent = { appId, appName, price };
        const modal = document.getElementById('otp-specific-modal');
        const titleEl = document.getElementById('otp-specific-modal-title');
        const priceEl = document.getElementById('otp-specific-modal-price');
        const inputEl = document.getElementById('otp-specific-phone-input');
        if (!modal) return;
        if (titleEl) titleEl.textContent = appName;
        if (priceEl) priceEl.textContent = this.formatMoney(price);
        if (inputEl) inputEl.value = '';
        modal.classList.remove('hidden');
        if (inputEl) setTimeout(() => inputEl.focus(), 80);
    },

    closeSpecificPhoneModal: function (event) {
        if (event && event.target !== event.currentTarget) return;
        const modal = document.getElementById('otp-specific-modal');
        if (modal) modal.classList.add('hidden');
        this.otpState._pendingSpecificRent = null;
    },

    confirmSpecificPhone: function () {
        const pending = this.otpState._pendingSpecificRent;
        if (!pending) return;

        const inputEl = document.getElementById('otp-specific-phone-input');
        const phoneRaw = inputEl ? inputEl.value.trim() : '';
        const phone = this.normalizeVietnamPhone(phoneRaw);

        if (!this.isValidVietnamPhone(phone)) {
            this.showToast('Số điện thoại không hợp lệ! Nhập dạng 0xxxxxxxxx (10 chữ số)', 'warning');
            if (inputEl) inputEl.focus();
            return;
        }

        const modal = document.getElementById('otp-specific-modal');
        if (modal) modal.classList.add('hidden');

        const { appId, appName, price } = pending;
        this.otpState._pendingSpecificRent = null;

        // Kiểm tra admin note trước
        const appNote = this.otpState.appNotes[appId];
        if (appNote && appNote.trim()) {
            this.otpState._pendingNoteRent = { appId, appName, price, specificPhone: phone };
            this.showOTPNoteModal(appId, appName, price, appNote);
            return;
        }

        if (!confirm(`Thuê số ${phone} cho ${appName} với giá ${this.formatMoney(price)}?\nHệ thống tự động hoàn tiền nếu số không có trong kho hoặc không có OTP.`)) return;
        this._proceedRentWithPhone(appId, appName, price, phone);
    },

    _proceedRentWithPhone: function (appId, appName, price, phone, dispPhone) {
        dispPhone = dispPhone || this.normalizeVietnamPhone(phone) || phone;
        const loading = document.getElementById('loading');
        loading.classList.remove('hidden');

        // API dùng param &number= (không phải &phone=), dạng 9 chữ số như bot to_api_phone()
        const apiPhone = this.toApiPhone(phone);
        const targetUrl = `${this.otpState.baseUrl}?act=number&appId=${appId}&number=${encodeURIComponent(apiPhone)}`;

        console.log('[NhậpSố] Yêu cầu số:', phone, '→ API:', apiPhone);
        console.log('[NhậpSố] URL:', targetUrl);

        this.fetchWithProxy(targetUrl)
            .then(data => {
                loading.classList.add('hidden');
                console.log('[NhậpSố] API trả về RC:', data.ResponseCode, '| Msg:', data.Msg);
                console.log('[NhậpSố] Result:', JSON.stringify(data.Result));
                if (data.ResponseCode === 0) {
                    const phoneInfo = data.Result;
                    const normalizedPhone = this.getOTPPhoneNumber(phoneInfo);
                    console.log('[NhậpSố] Số trả về (normalized):', normalizedPhone);
                    console.log('[NhậpSố] toApiPhone(trả về):', this.toApiPhone(normalizedPhone), '| toApiPhone(yêu cầu):', this.toApiPhone(phone));
                    if (!this.isValidVietnamPhone(normalizedPhone)) {
                        console.log('[NhậpSố] ❌ Số không hợp lệ');
                        this.showToast("Kho hết số " + dispPhone + ". Vui lòng thử số khác.", 'warning');
                        return;
                    }
                    // So sánh bằng format 9 số như bot: tránh nhầm 0xxx vs xxx vs 84xxx
                    if (this.toApiPhone(normalizedPhone) !== this.toApiPhone(phone)) {
                        console.log('[NhậpSố] ❌ Số trả về KHÁC số yêu cầu → không trừ tiền');
                        this.showToast(`Số ${dispPhone} không có trong kho. Hệ thống không trừ tiền.`, 'warning');
                        return;
                    }
                    console.log('[NhậpSố] ✓ Đúng số → tiến hành trừ tiền');

                    const username = this.appState.currentUser.username;
                    return db.ref('users/' + username + '/balance').transaction(balance => {
                        const latestBalance = Number(balance || 0);
                        if (latestBalance < price) return;
                        return latestBalance - price;
                    }).then(result => {
                        if (!result.committed) {
                            this.showToast('Số dư vừa thay đổi và không còn đủ để thuê OTP. Hệ thống không trừ tiền.', 'warning');
                            return;
                        }
                        const historyRecord = {
                            appId: appId,
                            appName: appName,
                            phone: normalizedPhone,
                            rawPhone: phoneInfo.Number || '',
                            price: price,
                            date: new Date().toLocaleDateString('vi-VN') + ' ' + new Date().toLocaleTimeString('vi-VN'),
                            timestamp: Date.now(),
                            debitedAt: Date.now(),
                            status: 'Đang chờ mã',
                            code: ''
                        };
                        return db.ref('users/' + username + '/otp_history/' + phoneInfo.Id).set(historyRecord).then(() => {
                            this.showOTPWaitScreen(appName, normalizedPhone, phoneInfo.Id, price);
                        });
                    });
                } else if (data.ResponseCode === 2) {
                    this.showToast(`Kho hết số ${dispPhone} cho ${appName}. Vui lòng chọn số khác.`, 'warning');
                } else if (data.ResponseCode === 3) {
                    this.showToast(`Số ${dispPhone} vừa được người khác thuê mất. Thử lại sau ít phút hoặc chọn số khác.`, 'warning');
                } else {
                    this.showToast("Lỗi từ server OTP: " + (data.Msg || 'Không xác định'), 'error');
                }
            })
            .catch(err => {
                loading.classList.add('hidden');
                this.showToast("Lỗi kết nối đến API OTP: " + err.message);
            });
    },

    _proceedRentOTP: function (appId, appName, price) {
        const loading = document.getElementById('loading');
        loading.classList.remove('hidden');

        const networkSelect = document.getElementById('otp-network-select');
        const network = networkSelect ? networkSelect.value : '';

        const prefixInput = document.getElementById('otp-prefix-input');
        const selectedPrefix = prefixInput ? prefixInput.value.trim() : '';

        let targetUrl = `${this.otpState.baseUrl}?act=number&appId=${appId}`;
        if (network) targetUrl += `&carrier=${network}`;
        if (selectedPrefix) targetUrl += `&prefix=${selectedPrefix}`;

        this.fetchWithProxy(targetUrl)
            .then(data => {
                loading.classList.add('hidden');
                if (data.ResponseCode === 0) {
                    const phoneInfo = data.Result;
                    const normalizedPhone = this.getOTPPhoneNumber(phoneInfo);
                    if (!this.isValidVietnamPhone(normalizedPhone)) {
                        this.showToast("API trả về số điện thoại không đủ 10 số. Hệ thống đã dừng đơn và không trừ tiền.", 'warning');
                        return;
                    }

                    if (selectedPrefix && !normalizedPhone.startsWith(selectedPrefix)) {
                        this.showToast(`Hết số đầu ${selectedPrefix}x cho ${appName}. Vui lòng chọn đầu số khác hoặc chọn "Bất kỳ".`, 'warning');
                        return;
                    }

                    const username = this.appState.currentUser.username;
                    return db.ref('users/' + username + '/balance').transaction(balance => {
                        const latestBalance = Number(balance || 0);
                        if (latestBalance < price) return;
                        return latestBalance - price;
                    }).then(result => {
                        if (!result.committed) {
                            this.showToast('Số dư vừa thay đổi và không còn đủ để thuê OTP. Hệ thống không trừ tiền.', 'warning');
                            return;
                        }

                        const historyRecord = {
                            appId: appId,
                            appName: appName,
                            phone: normalizedPhone,
                            rawPhone: phoneInfo.Number || '',
                            price: price,
                            date: new Date().toLocaleDateString('vi-VN') + ' ' + new Date().toLocaleTimeString('vi-VN'),
                            timestamp: Date.now(),
                            debitedAt: Date.now(),
                            status: 'Đang chờ mã',
                            code: ''
                        };
                        return db.ref('users/' + username + '/otp_history/' + phoneInfo.Id).set(historyRecord).then(() => {
                            this.showOTPWaitScreen(appName, normalizedPhone, phoneInfo.Id, price);
                        });
                    });
                } else {
                    this.showToast("Lỗi từ server OTP: " + data.Msg);
                }
            })
            .catch(err => {
                loading.classList.add('hidden');
                this.showToast("Lỗi kết nối đến API OTP: " + err.message);
            });
    },

    // --- Admin OTP Notes Management ---
    adminPopulateOTPNoteSelect: function () {
        const select = document.getElementById('admin-otp-note-app-select');
        if (!select) return;
        select.innerHTML = this.otpState.fixedApps.map(app => {
            // Check both number and string keys since Firebase returns string keys
            const hasNote = !!(this.otpState.appNotes[app.Id] || this.otpState.appNotes[String(app.Id)]);
            return `<option value="${app.Id}">${app.Name}${hasNote ? ' ✏️' : ''}</option>`;
        }).join('');
    },

    adminLoadOTPNote: function () {
        const select = document.getElementById('admin-otp-note-app-select');
        const editor = document.getElementById('admin-otp-note-editor');
        const label = document.getElementById('admin-otp-note-app-label');
        const status = document.getElementById('admin-otp-note-status');
        const textarea = document.getElementById('admin-otp-note-content');
        if (!select || !editor || !textarea) return;

        // Defensively re-populate if select is empty
        if (!select.options.length) this.adminPopulateOTPNoteSelect();

        const appId = select.value;
        if (!appId) {
            this.showToast('Danh sách app đang tải, vui lòng thử lại!', 'warning');
            return;
        }
        const appName = this.otpState.fixedApps.find(a => a.Id == appId)?.Name || 'App';

        // Fetch latest from Firebase
        if (!db) return;
        db.ref('otp_app_notes/' + appId).once('value').then(snap => {
            const raw = snap.val();
            // Guard: nếu Firebase trả object thay vì string thì lấy trường text hoặc bỏ qua
            const note = (raw && typeof raw === 'string') ? raw : (raw && typeof raw === 'object' ? (raw.text || raw.note || JSON.stringify(raw)) : '');
            this.otpState.appNotes[appId] = note;

            if (label) label.innerHTML = `<i class="fas fa-sticky-note" style="color:var(--warning);margin-right:6px;"></i>${this.escapeHtml(appName)}`;
            if (status) {
                if (note) {
                    status.textContent = 'Đã có ghi chú';
                    status.style.background = 'rgba(16,185,129,0.15)';
                    status.style.color = '#10b981';
                } else {
                    status.textContent = 'Chưa có ghi chú';
                    status.style.background = 'rgba(255,255,255,0.08)';
                    status.style.color = 'var(--text-muted)';
                }
            }
            textarea.value = note;
            editor.style.display = 'block';
        });
    },

    adminSaveOTPNote: function () {
        if (!db) return;
        const select = document.getElementById('admin-otp-note-app-select');
        const textarea = document.getElementById('admin-otp-note-content');
        if (!select || !textarea) return;

        const appId = select.value;
        const noteText = textarea.value.trim();
        const appName = this.otpState.fixedApps.find(a => a.Id == appId)?.Name || 'App';

        if (!noteText) {
            this.showToast('Vui lòng nhập nội dung ghi chú!', 'warning');
            return;
        }

        db.ref('otp_app_notes/' + appId).set(noteText).then(() => {
            this.otpState.appNotes[appId] = noteText;
            this.showToast(`✅ Đã lưu ghi chú cho ${appName}!`);
            this.adminLoadOTPNote();
            try { this.adminRenderOTPNotesSummary(); } catch(e) { console.warn('OTP notes render error:', e); }
            this.adminPopulateOTPNoteSelect();
            this.loadOTPAppNotes();
        }).catch(err => this.showToast('Lỗi lưu ghi chú: ' + err.message, 'error'));
    },

    adminDeleteOTPNote: function () {
        if (!db) return;
        const select = document.getElementById('admin-otp-note-app-select');
        if (!select) return;

        const appId = select.value;
        const appName = this.otpState.fixedApps.find(a => a.Id == appId)?.Name || 'App';

        if (!confirm(`Xóa ghi chú cho ${appName}?`)) return;

        db.ref('otp_app_notes/' + appId).remove().then(() => {
            delete this.otpState.appNotes[appId];
            this.showToast(`Đã xóa ghi chú cho ${appName}.`);
            const textarea = document.getElementById('admin-otp-note-content');
            if (textarea) textarea.value = '';
            this.adminLoadOTPNote();
            try { this.adminRenderOTPNotesSummary(); } catch(e) { console.warn('OTP notes render error:', e); }
            this.adminPopulateOTPNoteSelect();
            this.loadOTPAppNotes();
        }).catch(err => this.showToast('Lỗi xóa ghi chú: ' + err.message, 'error'));
    },

    adminRenderOTPNotesSummary: function () {
        const container = document.getElementById('admin-otp-notes-summary');
        if (!container) return;

        const notesEntries = Object.entries(this.otpState.appNotes).filter(([id, note]) => note && typeof note === 'string' && note.trim());
        if (notesEntries.length === 0) {
            container.innerHTML = `<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:12px;">Chưa có ghi chú nào cho các app OTP.</p>`;
            return;
        }

        container.innerHTML = `
            <div style="font-size:0.85rem;color:var(--text-muted);margin-bottom:8px;"><i class="fas fa-list"></i> Danh sách app đã có ghi chú (${notesEntries.length})</div>
            <div class="admin-otp-notes-list">
                ${notesEntries.map(([appId, note]) => {
                    const appObj = this.otpState.fixedApps.find(a => a.Id == appId);
                    const name = appObj ? appObj.Name : `App #${appId}`;
                    const preview = note.length > 60 ? note.substring(0, 60) + '...' : note;
                    return `<div class="admin-otp-note-item">
                        <span class="note-app-name"><i class="fas fa-sticky-note" style="color:var(--warning);margin-right:6px;"></i>${this.escapeHtml(name)}</span>
                        <span class="note-preview">${this.escapeHtml(preview)}</span>
                        <span class="note-actions">
                            <button class="btn-outline" style="padding:4px 10px;font-size:0.78rem;border-color:var(--primary);color:var(--primary);" onclick="document.getElementById('admin-otp-note-app-select').value='${appId}';app.adminLoadOTPNote();">
                                <i class="fas fa-edit"></i>
                            </button>
                        </span>
                    </div>`;
                }).join('')}
            </div>
        `;
    },

    // --- Admin: Quản lý App OTP hiển thị từ web mẹ ---
    adminLoadAllOTPAppsForSelector: function () {
        const container = document.getElementById('admin-otp-app-selector');
        if (!container) return;
        container.innerHTML = '<div style="color:var(--text-muted);padding:12px;"><i class="fas fa-spinner fa-spin"></i> Đang tải danh sách từ chaycodeso3.com...</div>';

        const targetUrl = `${this.otpState.baseUrl}?act=app`;
        this.fetchWithProxy(targetUrl).then(data => {
            if (data.ResponseCode !== 0 || !Array.isArray(data.Result)) {
                container.innerHTML = '<div style="color:var(--danger);padding:12px;"><i class="fas fa-times-circle"></i> Lỗi tải danh sách từ web mẹ.</div>';
                return;
            }
            const allApps = data.Result.slice().sort((a, b) => a.Name.localeCompare(b.Name, 'vi'));
            this.otpState.adminCatalogApps = allApps;
            this.otpState.adminSelectedAppIds = new Set(this.otpState.fixedApps.map(a => Number(a.Id)));
            this.otpState.adminAppQuery = '';
            this.otpState.adminAppRenderLimit = 120;

            container.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
                    <span id="admin-app-sel-count" style="font-size:0.82rem;color:var(--text-muted);"></span>
                    <button onclick="app.adminSelectAllOTPApps()" class="btn-outline" style="padding:4px 12px;font-size:0.78rem;">Chọn tất cả</button>
                    <button onclick="app.adminClearAllOTPApps()" class="btn-outline" style="padding:4px 12px;font-size:0.78rem;border-color:var(--danger);color:var(--danger);">Bỏ chọn tất cả</button>
                </div>
                <div class="admin-otp-catalog-search">
                    <i class="fas fa-search"></i>
                    <input type="search" placeholder="Tìm app trong danh sách web mẹ..." oninput="app.adminSearchOTPApps(this.value)">
                </div>
                <div id="admin-otp-app-match-count"></div>
                <div id="admin-otp-app-checkbox-list" class="admin-otp-app-checkbox-list"></div>
                <div id="admin-otp-app-load-more"></div>
            `;
            this.adminRenderOTPAppRows();
        }).catch(() => {
            container.innerHTML = '<div style="color:var(--danger);padding:12px;"><i class="fas fa-wifi"></i> Không kết nối được chaycodeso3.com. Thử lại sau.</div>';
        });
    },

    adminRenderOTPAppRows: function () {
        const list = document.getElementById('admin-otp-app-checkbox-list');
        const footer = document.getElementById('admin-otp-app-load-more');
        const matchCount = document.getElementById('admin-otp-app-match-count');
        if (!list || !footer) return;

        const query = this.normalizeText(this.otpState.adminAppQuery || '');
        const filtered = this.otpState.adminCatalogApps.filter(item =>
            !query || this.normalizeText(item.Name || '').includes(query)
        );
        const visible = filtered.slice(0, this.otpState.adminAppRenderLimit);

        list.innerHTML = visible.map(item => {
            const appId = Number(item.Id);
            const safeName = this.escapeHtml(String(item.Name || 'Ứng dụng'));
            const price = (Number(item.Cost || 0) * this.otpState.priceMul).toLocaleString('vi-VN');
            return `
                <label class="admin-otp-app-option">
                    <input type="checkbox" value="${appId}" ${this.otpState.adminSelectedAppIds.has(appId) ? 'checked' : ''}
                        onchange="app.adminToggleOTPApp(${appId}, this.checked)">
                    <span title="${safeName}">${safeName}</span>
                    <small>${price}đ</small>
                </label>
            `;
        }).join('');

        if (matchCount) {
            matchCount.textContent = query
                ? `Tìm thấy ${filtered.length} / ${this.otpState.adminCatalogApps.length} app`
                : `Hiển thị ${visible.length} / ${filtered.length} app`;
        }
        footer.innerHTML = visible.length < filtered.length
            ? `<button type="button" class="btn-outline" onclick="app.adminLoadMoreOTPApps()">Xem thêm ${Math.min(120, filtered.length - visible.length)} app</button>`
            : '';
        this._updateAppSelCount();
    },

    adminSearchOTPApps: function (query) {
        this.otpState.adminAppQuery = query || '';
        clearTimeout(this.otpState.adminAppSearchTimer);
        this.otpState.adminAppSearchTimer = setTimeout(() => {
            this.otpState.adminAppRenderLimit = 120;
            this.adminRenderOTPAppRows();
        }, 120);
    },

    adminLoadMoreOTPApps: function () {
        this.otpState.adminAppRenderLimit += 120;
        this.adminRenderOTPAppRows();
    },

    adminToggleOTPApp: function (appId, checked) {
        const numericId = Number(appId);
        if (checked) this.otpState.adminSelectedAppIds.add(numericId);
        else this.otpState.adminSelectedAppIds.delete(numericId);
        this._updateAppSelCount();
    },

    _updateAppSelCount: function () {
        const el = document.getElementById('admin-app-sel-count');
        if (el) el.innerHTML = `${this.otpState.adminCatalogApps.length} app — đang chọn <strong>${this.otpState.adminSelectedAppIds.size}</strong>`;
    },

    adminSelectAllOTPApps: function () {
        this.otpState.adminSelectedAppIds = new Set(this.otpState.adminCatalogApps.map(item => Number(item.Id)));
        this.adminRenderOTPAppRows();
    },

    adminClearAllOTPApps: function () {
        this.otpState.adminSelectedAppIds.clear();
        this.adminRenderOTPAppRows();
    },

    adminSaveSelectedApps: function () {
        if (!db) return;
        if (this.otpState.adminSelectedAppIds.size === 0) {
            this.showToast('Vui lòng chọn ít nhất 1 app!', 'warning');
            return;
        }
        // Giữ lại category và imageUrl đã có, tránh bị mất khi lưu cơ bản
        const existingMap = {};
        (this.otpState.fixedApps || []).forEach(a => { existingMap[String(a.Id)] = a; });
        const selected = this.otpState.adminCatalogApps
            .filter(item => this.otpState.adminSelectedAppIds.has(Number(item.Id)))
            .map(item => {
            const appId = Number(item.Id);
            const existing = existingMap[String(appId)] || {};
            return {
                Id: appId,
                Name: String(item.Name || 'Ứng dụng'),
                category: existing.category || 'other',
                imageUrl: existing.imageUrl || '',
            };
        });
        db.ref('settings/selectedApps').set(selected).then(() => {
            this.otpState.fixedApps = selected;
            this.otpState.priceFetchedAt = 0;
            try { localStorage.setItem('otp_selected_apps', JSON.stringify(selected)); } catch (e) {}
            this.showToast(`✅ Đã lưu ${selected.length} app OTP!`, 'success');
            this.adminPopulateOTPNoteSelect();
        }).catch(err => this.showToast('Lỗi lưu: ' + err.message, 'error'));
    },

    // --- Admin: Hình ảnh & Phân Nhóm App OTP ---
    _CATEGORY_OPTIONS: [
        { value: 'other',    label: '📦 Khác' },
        { value: 'social',   label: '💬 Mạng xã hội' },
        { value: 'shopping', label: '🛍️ Mua sắm' },
        { value: 'finance',  label: '💰 Ví & Crypto' },
        { value: 'local',    label: '🇻🇳 Việt Nam' },
        { value: 'ai',       label: '🤖 AI' },
        { value: 'game',     label: '🎮 Game' },
    ],

    adminLoadImageManager: function () {
        const container = document.getElementById('admin-otp-image-manager');
        if (!container) return;
        const apps = this.otpState.fixedApps;
        if (!apps || apps.length === 0) {
            container.innerHTML = '<p style="color:var(--warning);font-size:0.85rem;padding:8px 0;"><i class="fas fa-exclamation-triangle"></i> Chưa có app nào. Hãy vào "Quản Lý App OTP Hiển Thị" chọn app trước.</p>';
            return;
        }
        const catOpts = this._CATEGORY_OPTIONS.map(o =>
            `<option value="${o.value}">${o.label}</option>`
        ).join('');
        container.innerHTML = `
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:4px 0 6px;font-size:0.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em;">
                <span style="padding-left:50px;">Tên App</span><span>Nhóm</span><span>URL Hình Ảnh</span>
            </div>
            <div style="display:grid;gap:6px;max-height:480px;overflow-y:auto;padding:2px;">
                ${apps.map(app => {
                    const cat = app.category || this._inferCategory(app.Id) || 'other';
                    const initial = this.escapeHtml((app.Name||'?').charAt(0).toUpperCase());
                    const previewHtml = app.imageUrl
                        ? `<img src="${this.escapeHtml(app.imageUrl)}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none';this.nextSibling.style.display='flex'" alt=""><span style="display:none;align-items:center;justify-content:center;width:100%;height:100%;font-weight:700;font-size:.95rem;">${initial}</span>`
                        : `<span style="font-weight:700;font-size:.95rem;">${initial}</span>`;
                    const opts = this._CATEGORY_OPTIONS.map(o =>
                        `<option value="${o.value}"${cat===o.value?' selected':''}>${o.label}</option>`
                    ).join('');
                    return `
                    <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:9px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);">
                        <div style="width:32px;height:32px;border-radius:7px;overflow:hidden;flex-shrink:0;background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;">${previewHtml}</div>
                        <span style="width:130px;min-width:80px;font-size:0.84rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${this.escapeHtml(app.Name)}">${this.escapeHtml(app.Name)}</span>
                        <select data-cat-id="${app.Id}" style="width:148px;flex-shrink:0;padding:6px 8px;border-radius:7px;background:rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.12);color:white;font-size:0.8rem;">${opts}</select>
                        <input type="url" data-app-id="${app.Id}" placeholder="https://..." value="${this.escapeHtml(app.imageUrl || '')}"
                            style="flex:1;padding:6px 10px;border-radius:7px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.12);color:white;font-size:0.8rem;min-width:0;"
                            oninput="app._previewAppImage(this)">
                    </div>`;
                }).join('')}
            </div>
        `;
    },

    _inferCategory: function (appId) {
        for (const [cat, ids] of Object.entries(this.otpState.categoryMap)) {
            if (ids.includes(Number(appId))) return cat;
        }
        return 'other';
    },

    _previewAppImage: function (input) {
        const row = input.closest('div[style*="border-radius:10px"]');
        if (!row) return;
        const preview = row.querySelector('div[style*="width:36px"] img, div[style*="width:36px"] span:first-child');
        const url = input.value.trim();
        const container = row.querySelector('div[style*="width:36px"]');
        if (!container) return;
        const initial = input.dataset.appId
            ? (this.otpState.fixedApps.find(a => a.Id == input.dataset.appId)?.Name || '?').charAt(0).toUpperCase()
            : '?';
        if (url) {
            container.innerHTML = `<img src="${this.escapeHtml(url)}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<span style=\\'display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-weight:700;font-size:1rem;\\'>${initial}</span>')" alt="">`;
        } else {
            container.innerHTML = `<span style="font-weight:700;font-size:1rem;">${initial}</span>`;
        }
    },

    adminSaveAppImages: function () {
        if (!db) return;
        const inputs = document.querySelectorAll('#admin-otp-image-manager input[data-app-id]');
        if (!inputs.length) {
            this.showToast('Hãy nhấn "Tải danh sách" trước!', 'warning');
            return;
        }
        const urlMap = {}, catMap = {};
        inputs.forEach(inp => { urlMap[inp.dataset.appId] = inp.value.trim(); });
        document.querySelectorAll('#admin-otp-image-manager select[data-cat-id]').forEach(sel => {
            catMap[sel.dataset.catId] = sel.value;
        });
        const updated = this.otpState.fixedApps.map(app => ({
            ...app,
            imageUrl: urlMap[String(app.Id)] ?? (app.imageUrl || ''),
            category: catMap[String(app.Id)] ?? (app.category || 'other')
        }));
        db.ref('settings/selectedApps').set(updated).then(() => {
            this.otpState.fixedApps = updated;
            try { localStorage.setItem('otp_selected_apps', JSON.stringify(updated)); } catch (e) {}
            this.showToast(`✅ Đã lưu hình ảnh & nhóm cho ${inputs.length} app!`, 'success');
        }).catch(err => this.showToast('Lỗi: ' + err.message, 'error'));
    },

    // --- Chat System ---

    // --- Chat System ---
    toggleChat: function () {
        if (!this.appState.currentUser) {
            this.showToast("Vui lòng đăng nhập để chat với Admin!", 'warning');
            this.navigate('login');
            return;
        }
        const cw = document.getElementById('chat-window');
        cw.classList.toggle('hidden');
        const isOpen = !cw.classList.contains('hidden');
        const toggle = document.querySelector('.chat-toggle');
        if (toggle) toggle.setAttribute('aria-expanded', String(isOpen));
        if (isOpen) {
            document.getElementById('chat-badge').classList.add('hidden');
            this.listenToCustomerChat();
            requestAnimationFrame(() => document.getElementById('customer-chat-input')?.focus());
        }
    },

    sendMessage: function () {
        if (!this.appState.currentUser) return;
        const input = document.getElementById('customer-chat-input');
        const text = input.value.trim();
        if (!text) return;

        const username = this.appState.currentUser.username;
        const msgRef = db.ref('chats/' + username + '/messages').push();
        msgRef.set({
            sender: 'user',
            text: text,
            timestamp: Date.now(),
            date: new Date().toLocaleString('vi-VN')
        });

        db.ref('chats/' + username).update({
            lastUpdated: Date.now(),
            lastMessage: text.substring(0, 50),
            lastSender: 'user',
            hasUnreadAdmin: true
        });

        this.sendTelegramChatNotification(username, text);
        input.value = '';
    },

    listenToCustomerChat: function () {
        if (!this.appState.currentUser || !db) return;
        const username = this.appState.currentUser.username;
        db.ref('chats/' + username + '/messages').on('value', snapshot => {
            const messages = snapshot.val() || {};
            const container = document.getElementById('customer-chat-messages');
            if (!container) return;
            container.innerHTML = '';
            let hasNewAdminMsg = false;

            Object.values(messages).forEach(msg => {
                const div = document.createElement('div');
                div.className = 'chat-msg ' + (msg.sender === 'user' ? 'msg-user' : 'msg-admin');
                const time = msg.date || (msg.timestamp ? new Date(msg.timestamp).toLocaleString('vi-VN') : '');
                div.innerHTML = `${msg.text}${time ? `<span class="chat-msg-time">${time}</span>` : ''}`;
                container.appendChild(div);

                // If window is closed and admin sent a message
                if (msg.sender === 'admin' && document.getElementById('chat-window').classList.contains('hidden')) {
                    hasNewAdminMsg = true;
                }
            });
            container.scrollTop = container.scrollHeight;

            if (hasNewAdminMsg) {
                document.getElementById('chat-badge').classList.remove('hidden');
            }
        });
    },

    // --- Admin Chat ---
    adminChatState: {
        selectedUser: null,
        mode: 'active',   // 'active' = chỉ user đã chat | 'all' = tất cả users
        searchKeyword: '',
        _activeChats: {},
        _lastSeenUserMessageAt: {},
        _chatSnapshotReady: false,
    },

    loadAdminChatUsers: function () {
        if (!db) return;
        // Listen to chats node
        db.ref('chats').on('value', snapshot => {
            const chats = snapshot.val() || {};
            let shouldRing = false;
            Object.entries(chats).forEach(([username, chat]) => {
                const lastUpdated = Number(chat.lastUpdated || 0);
                const previous = this.adminChatState._lastSeenUserMessageAt[username] || 0;
                this.adminChatState._lastSeenUserMessageAt[username] = Math.max(previous, lastUpdated);
                if (this.adminChatState._chatSnapshotReady &&
                    chat.lastSender === 'user' &&
                    chat.hasUnreadAdmin &&
                    lastUpdated > previous) {
                    shouldRing = true;
                }
            });
            this.adminChatState._activeChats = chats;
            this.adminChatState._chatSnapshotReady = true;
            this._renderAdminUserList();
            if (shouldRing) this.playChatRing();
        });
    },

    switchAdminChatMode: function (mode, btnEl) {
        this.adminChatState.mode = mode;
        document.querySelectorAll('.admin-chat-mode-btn').forEach(b => b.classList.remove('active'));
        if (btnEl) btnEl.classList.add('active');
        this._renderAdminUserList();
    },

    filterAdminChatUsers: function (keyword) {
        this.adminChatState.searchKeyword = (keyword || '').trim().toLowerCase();
        this._renderAdminUserList();
    },

    _renderAdminUserList: function () {
        const container = document.getElementById('admin-chat-users');
        if (!container) return;
        container.innerHTML = '';

        const { mode, searchKeyword, _activeChats, selectedUser } = this.adminChatState;

        if (mode === 'active') {
            // Chỉ hiện user đã từng chat
            const chatArr = Object.keys(_activeChats).map(username => ({
                username,
                ..._activeChats[username]
            })).sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));

            const filtered = searchKeyword
                ? chatArr.filter(c => c.username.toLowerCase().includes(searchKeyword))
                : chatArr;

            if (filtered.length === 0) {
                container.innerHTML = `<div class="admin-chat-empty-hint"><i class="fas fa-inbox"></i><span>${searchKeyword ? 'Không tìm thấy' : 'Chưa có cuộc trò chuyện nào'}</span></div>`;
                return;
            }

            filtered.forEach(chat => {
                const div = document.createElement('div');
                div.className = 'admin-chat-user-item' + (chat.hasUnreadAdmin ? ' unread' : '') + (selectedUser === chat.username ? ' active' : '');
                const lastMsg = chat.lastMessage ? `<span class="acu-last-msg">${chat.lastMessage}</span>` : '';
                div.innerHTML = `
                    <div class="acu-info">
                        <div class="acu-avatar">${chat.username.charAt(0).toUpperCase()}</div>
                        <div class="acu-text">
                            <span class="acu-name">${chat.username}</span>
                            ${lastMsg}
                        </div>
                    </div>
                    ${chat.hasUnreadAdmin ? '<span class="acu-badge-new">Mới</span>' : ''}
                `;
                div.onclick = () => this.selectUserChat(chat.username);
                container.appendChild(div);
            });

        } else {
            // Hiện tất cả users từ appState.allUsers
            const allUsers = this.appState.allUsers || [];
            const filtered = searchKeyword
                ? allUsers.filter(u => u.username.toLowerCase().includes(searchKeyword))
                : allUsers;

            if (filtered.length === 0) {
                container.innerHTML = `<div class="admin-chat-empty-hint"><i class="fas fa-users"></i><span>${searchKeyword ? 'Không tìm thấy khách hàng' : 'Chưa có khách hàng nào'}</span></div>`;
                return;
            }

            filtered.forEach(user => {
                const chatData = _activeChats[user.username] || {};
                const hasChat = !!_activeChats[user.username];
                const div = document.createElement('div');
                div.className = 'admin-chat-user-item' + (chatData.hasUnreadAdmin ? ' unread' : '') + (selectedUser === user.username ? ' active' : '');
                div.innerHTML = `
                    <div class="acu-info">
                        <div class="acu-avatar">${user.username.charAt(0).toUpperCase()}</div>
                        <div class="acu-text">
                            <span class="acu-name">${user.username}</span>
                            <span class="acu-last-msg" style="color:${hasChat ? 'var(--text-muted)' : 'var(--accent)'}">
                                ${hasChat ? 'Có lịch sử chat' : '✦ Bắt đầu chat mới'}
                            </span>
                        </div>
                    </div>
                    ${chatData.hasUnreadAdmin ? '<span class="acu-badge-new">Mới</span>' : ''}
                `;
                div.onclick = () => this.selectUserChat(user.username);
                container.appendChild(div);
            });
        }
    },

    selectUserChat: function (username) {
        this.adminChatState.selectedUser = username;

        // Update active state in list
        document.querySelectorAll('.admin-chat-user-item').forEach(el => el.classList.remove('active'));
        const headerEl = document.getElementById('admin-chat-header');
        if (headerEl) headerEl.innerHTML = `<i class="fas fa-user-circle" style="color:var(--primary);margin-right:8px;"></i> ${username}`;
        document.getElementById('admin-chat-input-area').classList.remove('hidden');

        if (db) db.ref('chats/' + username).update({ hasUnreadAdmin: false });

        if (this.adminChatListener) {
            this.adminChatListener.off();
        }

        this.adminChatListener = db.ref('chats/' + username + '/messages');
        this.adminChatListener.on('value', snapshot => {
            const messages = snapshot.val() || {};
            const container = document.getElementById('admin-chat-messages');
            if (!container) return;
            container.innerHTML = '';

            const msgArr = Object.values(messages).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

            if (msgArr.length === 0) {
                container.innerHTML = `<div class="admin-chat-empty-hint" style="margin-top:40px;"><i class="fas fa-comment-dots"></i><span>Chưa có tin nhắn. Hãy bắt đầu cuộc trò chuyện!</span></div>`;
                return;
            }

            msgArr.forEach(msg => {
                const div = document.createElement('div');
                div.className = 'chat-msg ' + (msg.sender === 'admin' ? 'msg-user' : 'msg-admin');
                const time = msg.date || (msg.timestamp ? new Date(msg.timestamp).toLocaleString('vi-VN') : '');
                div.innerHTML = `${msg.text}${time ? `<span class="chat-msg-time">${time}</span>` : ''}`;
                container.appendChild(div);
            });
            container.scrollTop = container.scrollHeight;
        });

        // Re-render list to show active state
        this._renderAdminUserList();
    },

    sendAdminMessage: function () {
        const username = this.adminChatState.selectedUser;
        if (!username) return;

        const input = document.getElementById('admin-chat-input');
        const text = input.value.trim();
        if (!text) return;

        db.ref('chats/' + username + '/messages').push().set({
            sender: 'admin',
            text: text,
            timestamp: Date.now(),
            date: new Date().toLocaleString('vi-VN')
        });
        db.ref('chats/' + username).update({
            lastUpdated: Date.now(),
            lastMessage: text.substring(0, 50),
            lastSender: 'admin'
        });

        input.value = '';
    },

    adjustUserBalanceBy: function (username, amount) {
        amount = Number(amount || 0);
        return db.ref('users/' + username + '/balance').transaction(balance => {
            return Number(balance || 0) + amount;
        });
    },

    getWarrantyText: function (product) {
        if (!product) return 'Không bảo hành';
        if (!this.isWarrantyEnabled(product)) return 'Không bảo hành';
        if (product.warranty) {
            const value = String(product.warranty).trim();
            if (/^bảo hành/i.test(value)) return value;
            return `Bảo hành ${value}`;
        }
        if (product.warrantyDays !== undefined && product.warrantyDays !== null && product.warrantyDays !== '') {
            const days = Number(product.warrantyDays || 0);
            return days > 0 ? `Bảo hành ${days} ngày` : 'Không bảo hành';
        }
        const desc = String(product.desc || '');
        const match = desc.match(/bảo hành\s*[:\-]?\s*([^.,;\n]+)/i);
        return match ? match[0].trim() : 'Không bảo hành';
    },

    refundOTPRequest: function (username, reqId, price, statusText) {
        if (!db || !username || !reqId) return Promise.resolve({ committed: false });
        const refundAmount = Number(price || 0);
        const histRef = db.ref('users/' + username + '/otp_history/' + reqId);
        const now = Date.now();
        return histRef.transaction(current => {
            if (!current || current.refundedAt || String(current.status || '').toLowerCase().includes('hoàn tiền')) return;
            if (String(current.status || '').toLowerCase().includes('thành công')) return;
            return {
                ...current,
                status: statusText || 'Đã hoàn tiền',
                refundedAt: now,
                refundedAmount: refundAmount
            };
        }).then(result => {
            if (!result.committed) return result;
            return this.adjustUserBalanceBy(username, refundAmount).then(() => result);
        });
    },

    getOrderDeliveredAccounts: function (order) {
        if (!order) return [];
        const structured = this.normalizeDeliveredAccounts(order.deliveredAccounts);
        if (structured.length > 0) return structured;

        const details = String(order.accountDetails || '').trim();
        if (!details) return [];
        const normalized = this.normalizeText(details);
        const isPlaceholder = normalized.includes('dang cho')
            || normalized.includes('dang lay tai khoan')
            || normalized.includes('dang xu ly')
            || normalized.includes('da hoan tien')
            || normalized.includes('khong du tai khoan');
        if (isPlaceholder) return [];

        const numberedLines = details.split(/\r?\n/)
            .map(line => line.replace(/^\s*\[\d+\]\s*/, '').trim())
            .filter(Boolean);
        return numberedLines.length > 0 ? numberedLines : [details];
    },

    parseDeliveredAccount: function (rawValue, accountIndex) {
        const raw = String(rawValue || '').trim();
        let parts = raw.split(/\s*\|\s*|\t+|\r?\n/).map(value => value.trim()).filter(Boolean);
        if (parts.length === 1 && raw.includes(':')) {
            const colonParts = raw.split(':').map(value => value.trim()).filter(Boolean);
            if (colonParts.length >= 2 && colonParts.length <= 4) parts = colonParts;
        }

        const fallbackLabels = ['Tài khoản / Email', 'Mật khẩu', 'Mã khôi phục', 'Ghi chú'];
        const fields = parts.map((part, fieldIndex) => {
            const explicit = part.match(/^([^:=]{2,24})\s*[:=]\s*(.+)$/);
            let label = fallbackLabels[Math.min(fieldIndex, fallbackLabels.length - 1)];
            let value = part;
            if (explicit) {
                const key = this.normalizeText(explicit[1]);
                value = explicit[2].trim();
                if (/pass|mat khau|password/.test(key)) label = 'Mật khẩu';
                else if (/recovery|backup|khoi phuc|2fa|secret|ma du phong/.test(key)) label = 'Mã khôi phục';
                else if (/email|tai khoan|username|user|login|id/.test(key)) label = 'Tài khoản / Email';
                else label = explicit[1].trim();
            }
            const sensitive = label === 'Mật khẩu' || label === 'Mã khôi phục';
            return {
                id: `delivery-field-${accountIndex}-${fieldIndex}`,
                label,
                value,
                sensitive
            };
        });

        if (fields.length === 0) {
            fields.push({
                id: `delivery-field-${accountIndex}-0`,
                label: 'Tài khoản / Email',
                value: raw,
                sensitive: false
            });
        }
        return { raw, fields };
    },

    getOrderTimelineState: function (order) {
        const status = this.normalizeText(order?.status || '');
        const refunded = status.includes('hoan tien') || status.includes('huy');
        const delivered = !refunded && (
            status.includes('hoan thanh')
            || status.includes('da giao')
            || Boolean(order?.fulfilledAt)
            || Boolean(order?.autoFulfilled)
        );
        const warrantyText = this.normalizeText(order?.warranty || '');
        const hasWarranty = delivered && warrantyText
            && !warrantyText.includes('khong bao hanh')
            && warrantyText !== '-';

        return {
            refunded,
            delivered,
            steps: [
                { label: 'Đã thanh toán', icon: 'fa-wallet', state: 'complete' },
                { label: 'Đang xử lý', icon: 'fa-gears', state: delivered ? 'complete' : (refunded ? 'cancelled' : 'active') },
                { label: 'Đã giao', icon: 'fa-box-open', state: delivered ? 'complete' : (refunded ? 'cancelled' : 'upcoming') },
                { label: 'Bảo hành', icon: 'fa-shield-halved', state: hasWarranty ? 'active' : (delivered ? 'disabled' : 'upcoming') }
            ]
        };
    },

    renderOrderTimeline: function (order, compact = false) {
        const timeline = this.getOrderTimelineState(order);
        return `
            <div class="order-timeline-track ${compact ? 'is-compact' : ''}">
                ${timeline.steps.map(step => `
                    <div class="order-timeline-step ${step.state}">
                        <span class="order-timeline-dot"><i class="fas ${step.icon}"></i></span>
                        <span class="order-timeline-label">${step.label}</span>
                    </div>
                `).join('')}
            </div>
        `;
    },

    openAccountDeliveryModal: function (orderId) {
        const order = [...(this.appState.orders || []), ...(this.appState.allOrders || [])]
            .find(item => String(item.id) === String(orderId));
        const modal = document.getElementById('account-delivery-modal');
        if (!order || !modal) {
            this.showToast('Không tìm thấy đơn hàng.', 'warning');
            return;
        }

        const accounts = this.getOrderDeliveredAccounts(order)
            .map((value, index) => this.parseDeliveredAccount(value, index));
        this._activeDeliveryAccounts = accounts;
        document.getElementById('account-delivery-title').textContent = order.productName || 'Tài khoản của bạn';
        document.getElementById('account-delivery-subtitle').textContent =
            `Đơn #${order.id} • ${order.purchasedAtDisplay || order.date || ''}`;
        const timelineElement = document.getElementById('account-delivery-timeline');
        timelineElement.innerHTML = this.renderOrderTimeline(order);
        timelineElement.classList.toggle('is-delivered', accounts.length > 0);
        modal.classList.toggle('has-delivered-accounts', accounts.length > 0);

        const content = document.getElementById('account-delivery-content');
        if (accounts.length === 0) {
            content.innerHTML = `
                <div class="account-delivery-empty">
                    <i class="fas fa-clock"></i>
                    <strong>${this.escapeHtml(order.status || 'Đang xử lý')}</strong>
                    <span>Thông tin tài khoản sẽ xuất hiện tại đây sau khi đơn được giao.</span>
                </div>
            `;
        } else {
            content.innerHTML = accounts.map((account, accountIndex) => `
                <article class="delivered-account-card">
                    <div class="delivered-account-heading">
                        <strong>Tài khoản ${accountIndex + 1}</strong>
                        <button type="button" class="btn-outline delivery-copy-account"
                            onclick="app.copyDeliveryAccount(${accountIndex})">
                            <i class="far fa-copy"></i> Sao chép tài khoản
                        </button>
                    </div>
                    <div class="delivered-account-fields">
                        ${account.fields.map((field, fieldIndex) => `
                            <label class="delivered-account-field">
                                <span>${this.escapeHtml(field.label)}</span>
                                <div class="delivery-input-wrap">
                                    <input id="${field.id}" type="${field.sensitive ? 'password' : 'text'}"
                                        readonly value="${this.escapeHtml(field.value)}">
                                    ${field.sensitive ? `
                                        <button type="button" class="btn-icon" title="Hiện hoặc ẩn"
                                            onclick="app.toggleDeliveryField('${field.id}',this)">
                                            <i class="far fa-eye"></i>
                                        </button>
                                    ` : ''}
                                    <button type="button" class="btn-icon" title="Sao chép"
                                        onclick="app.copyDeliveryField(${accountIndex},${fieldIndex})">
                                        <i class="far fa-copy"></i>
                                    </button>
                                </div>
                            </label>
                        `).join('')}
                    </div>
                </article>
            `).join('');
        }

        const copyAll = document.getElementById('account-delivery-copy-all');
        if (copyAll) {
            copyAll.disabled = accounts.length === 0;
            copyAll.onclick = () => {
                if (accounts.length > 0) this.copyText(accounts.map(account => account.raw).join('\n'));
            };
        }
        modal.classList.remove('hidden');
        document.body.classList.add('delivery-modal-open');
    },

    closeAccountDeliveryModal: function (event) {
        if (event && event.target !== event.currentTarget) return;
        const modal = document.getElementById('account-delivery-modal');
        if (modal) modal.classList.add('hidden');
        document.body.classList.remove('delivery-modal-open');
    },

    toggleDeliveryField: function (fieldId, button) {
        const input = document.getElementById(fieldId);
        if (!input) return;
        input.type = input.type === 'password' ? 'text' : 'password';
        const icon = button?.querySelector('i');
        if (icon) icon.className = input.type === 'password' ? 'far fa-eye' : 'far fa-eye-slash';
    },

    copyDeliveryField: function (accountIndex, fieldIndex) {
        const field = this._activeDeliveryAccounts?.[accountIndex]?.fields?.[fieldIndex];
        if (field) this.copyText(field.value);
    },

    copyDeliveryAccount: function (accountIndex) {
        const account = this._activeDeliveryAccounts?.[accountIndex];
        if (account) this.copyText(account.raw);
    },

    // Utils
    copyText: function (text) {
        const sourceButton = document.activeElement?.closest?.('button');
        navigator.clipboard.writeText(text).then(() => {
            if (sourceButton) {
                const icon = sourceButton.querySelector('i');
                const originalIcon = icon?.className || '';
                clearTimeout(sourceButton._copyMotionTimer);
                sourceButton.classList.add('copy-confirmed');
                if (icon) icon.className = 'fas fa-check';
                sourceButton._copyMotionTimer = setTimeout(() => {
                    sourceButton.classList.remove('copy-confirmed');
                    if (icon && originalIcon) icon.className = originalIcon;
                }, 900);
            }
            this.showToast("Đã sao chép vào khay nhớ tạm!");
        }).catch(() => {
            this.showToast('Không thể sao chép. Vui lòng thử lại.', 'error');
        });
    },

    showToast: function (msg, type = 'success') {
        const toast = document.getElementById('toast');
        const toastIcon = toast.querySelector('i');
        document.getElementById('toast-msg').innerText = msg;

        // Remove all type classes
        toast.classList.remove('toast-success', 'toast-error', 'toast-warning', 'toast-info');
        toast.classList.add('toast-' + type);

        // Update icon
        const iconMap = {
            success: 'fas fa-check-circle',
            error: 'fas fa-times-circle',
            warning: 'fas fa-exclamation-triangle',
            info: 'fas fa-info-circle'
        };
        if (toastIcon) toastIcon.className = iconMap[type] || iconMap.success;

        toast.classList.remove('hidden');
        toast.style.animation = 'none';
        toast.offsetHeight;
        toast.style.animation = null;

        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => {
            toast.classList.add('hidden');
        }, 3500);
    },

    get appState() {
        return appState;
    },

    exportDatabaseBackup: function () {
        if (!this.appState.currentUser || this.appState.currentUser.username.trim().toLowerCase() !== 'admin') {
            this.showToast("Từ chối truy cập. Bạn không phải là admin.");
            return;
        }

        const loading = document.getElementById('loading');
        loading.classList.remove('hidden');
        loading.querySelector('p').innerText = "Đang tạo bản sao lưu dữ liệu...";

        db.ref('/').once('value')
            .then(snapshot => {
                const data = snapshot.val();
                if (!data) {
                    this.showToast("Không có dữ liệu nào để sao lưu!");
                    return;
                }

                // Chuyển đổi dữ liệu sang định dạng JSON string
                const jsonStr = JSON.stringify(data, null, 2);

                // Tạo một Blob để chứa file JSON
                const blob = new Blob([jsonStr], { type: "application/json" });
                const url = URL.createObjectURL(blob);

                // Tạo thẻ a ảo để trigger download
                const downloadAnchorNode = document.createElement('a');
                downloadAnchorNode.href = url;

                // Lấy ngày tháng hiện tại làm tên file
                const dateStr = new Date().toISOString().replace(/T/, '_').replace(/:/g, '-').split('.')[0];
                downloadAnchorNode.download = `AccStore_DB_Backup_${dateStr}.json`;

                document.body.appendChild(downloadAnchorNode);
                downloadAnchorNode.click();

                // Dọn dẹp
                downloadAnchorNode.remove();
                URL.revokeObjectURL(url);

                this.showToast("Đã tải tệp sao lưu thành công!");
            })
            .catch(err => {
                console.error("Lỗi sao lưu database:", err);
                this.showToast("Có lỗi xảy ra khi lấy dữ liệu từ máy chủ.", 'error');
            })
            .finally(() => {
                loading.classList.add('hidden');
                loading.querySelector('p').innerText = "Đang xử lý giao dịch...";
            });
    },

    searchOTP: function () {
        clearTimeout(this.otpState.searchTimer);
        this.otpState.searchTimer = setTimeout(() => this.applyOTPFilters(), 120);
    },

    uploadAndSendImage: function (file, senderType) {
        const loading = document.getElementById('loading');
        if (loading) {
            loading.classList.remove('hidden');
            loading.querySelector('p').innerText = "Đang xử lý ảnh...";
        }

        const username = senderType === 'user' ? (this.appState.currentUser ? this.appState.currentUser.username : null) : this.adminChatState.selectedUser;
        if (!username) {
            this.showToast("Lỗi: Không xác định được người dùng.", 'error');
            if (loading) loading.classList.add('hidden');
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                const MAX_SIZE = 800;
                if (width > height && width > MAX_SIZE) {
                    height *= MAX_SIZE / width;
                    width = MAX_SIZE;
                } else if (height > MAX_SIZE) {
                    width *= MAX_SIZE / height;
                    height = MAX_SIZE;
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                const base64Data = canvas.toDataURL('image/jpeg', 0.8);
                const imgHtml = `<img src="${base64Data}" alt="image" style="max-width: 100%; border-radius: 8px; margin-top: 5px;">`;

                db.ref('chats/' + username + '/messages').push().set({
                    sender: senderType,
                    text: "Đã gửi một hình ảnh:<br>" + imgHtml,
                    timestamp: Date.now(),
                    date: new Date().toLocaleString('vi-VN')
                }).then(() => {
                    if (senderType === 'user') {
                        return db.ref('chats/' + username).update({
                            lastUpdated: Date.now(),
                            lastMessage: 'Đã gửi một hình ảnh',
                            lastSender: 'user',
                            hasUnreadAdmin: true
                        });
                    } else {
                        return db.ref('chats/' + username).update({
                            lastUpdated: Date.now(),
                            lastMessage: 'Đã gửi một hình ảnh',
                            lastSender: 'admin'
                        });
                    }
                }).then(() => {
                    if (loading) {
                        loading.classList.add('hidden');
                        loading.querySelector('p').innerText = "Đang xử lý giao dịch...";
                    }
                }).catch(err => {
                    this.showToast("Lỗi gửi ảnh: " + err.message);
                    if (loading) loading.classList.add('hidden');
                });
            };
            img.onerror = () => {
                this.showToast("Lỗi: File ảnh không hợp lệ.", 'error');
                if (loading) loading.classList.add('hidden');
            };
            img.src = e.target.result;
        };

        reader.onerror = () => {
            this.showToast("Lỗi đọc file từ thiết bị.", 'error');
            if (loading) loading.classList.add('hidden');
        };

        reader.readAsDataURL(file);
    },

    sendImagePrompt: function (senderType) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) this.uploadAndSendImage(file, senderType);
        };
        input.click();
    },

    handleChatPaste: function (e, senderType) {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') !== -1) {
                e.preventDefault();
                const file = items[i].getAsFile();
                if (file) {
                    this.uploadAndSendImage(file, senderType);
                }
                break;
            }
        }
    },

    listenToNotifications: function () {
        if (!db) return;
        db.ref('notifications').on('value', snapshot => {
            const notifs = snapshot.val() || {};
            const arr = Object.keys(notifs).map(k => ({ id: k, ...notifs[k] })).sort((a, b) => b.timestamp - a.timestamp);
            this.appState.notifications = arr;
            this.renderNotifications();

            // Notification Badge logic
            if (this.appState.currentUser) {
                const lastRead = localStorage.getItem('lastReadNotif_' + this.appState.currentUser.username) || 0;
                const unreadCount = arr.filter(n => n.timestamp > lastRead).length;
                const badge = document.getElementById('nav-notification-badge');
                if (badge) {
                    if (unreadCount > 0) {
                        badge.innerText = unreadCount > 99 ? '99+' : unreadCount;
                        badge.classList.remove('hidden');
                    } else {
                        badge.classList.add('hidden');
                    }
                }
            }
        });
    },

    renderNotifications: function () {
        const list = document.getElementById('notifications-list');
        const noMsg = document.getElementById('no-notifications-msg');
        if (list && noMsg) {
            list.innerHTML = '';
            if (!this.appState.notifications || this.appState.notifications.length === 0) {
                noMsg.classList.remove('hidden');
            } else {
                noMsg.classList.add('hidden');
                this.appState.notifications.forEach(n => {
                    const div = document.createElement('div');
                    let icon = 'fa-info-circle text-gradient';
                    let type = 'info';
                    if (n.type === 'success') { icon = 'fa-check-circle text-success'; type = 'success'; }
                    if (n.type === 'warning') { icon = 'fa-exclamation-triangle text-warning'; type = 'warning'; }

                    div.className = `notification-card notification-card-${type}`;
                    const date = new Date(n.timestamp).toLocaleString('vi-VN');
                    div.innerHTML = `
                        <div class="notification-card-header">
                            <i class="fas ${icon}" style="font-size: 1.2rem;"></i>
                            <strong class="notification-card-title">${n.title}</strong>
                            <span class="notification-card-date">${date}</span>
                        </div>
                        <div class="notification-card-content">${n.content}</div>
                    `;
                    list.appendChild(div);
                });
            }
        }

        const adminList = document.getElementById('admin-notifications-list');
        if (adminList) {
            adminList.innerHTML = '';
            (this.appState.notifications || []).forEach(n => {
                const div = document.createElement('div');
                div.className = 'admin-notification-row';
                div.innerHTML = `
                    <div>
                        <strong class="admin-notification-title">${n.title}</strong> <span class="admin-notification-date">(${new Date(n.timestamp).toLocaleDateString('vi-VN')})</span>
                    </div>
                    <button class="btn-outline" style="padding: 5px 10px; border-color: var(--danger); color: var(--danger);" onclick="app.adminDeleteNotification('${n.id}')"><i class="fas fa-trash"></i></button>
                `;
                adminList.appendChild(div);
            });
        }
    },

    adminAddNotification: function (e) {
        e.preventDefault();
        const title = document.getElementById('admin-notif-title').value.trim();
        const content = document.getElementById('admin-notif-content').value.trim();
        const type = document.getElementById('admin-notif-type').value;
        if (!title || !content || !db) return;

        db.ref('notifications').push().set({
            title: title,
            content: content,
            type: type,
            timestamp: Date.now()
        }).then(() => {
            this.showToast('Đã gửi thông báo!');
            document.getElementById('admin-add-notification-form').reset();
        });
    },

    adminDeleteNotification: function (id) {
        if (!confirm('Xóa thông báo này?')) return;
        db.ref('notifications/' + id).remove().then(() => this.showToast('Đã xóa thông báo'));
    },

    adminUpdateOrderStatus: function (orderId) {
        if (!db || !orderId) return;
        const input = document.getElementById('admin-status-' + orderId);
        const status = input ? input.value.trim() : '';
        if (!status) {
            this.showToast('Vui lòng nhập trạng thái đơn hàng.', 'warning');
            return;
        }
        db.ref('orders/' + orderId).update({
            status,
            statusUpdatedAt: Date.now(),
            statusUpdatedBy: this.appState.currentUser ? this.appState.currentUser.username : 'admin'
        }).then(() => this.showToast('Đã cập nhật trạng thái đơn hàng.'));
    },

    adminSaveOrderNote: function (orderId) {
        if (!db || !orderId) return;
        const input = document.getElementById('admin-note-' + orderId);
        const note = input ? input.value.trim() : '';
        db.ref('orders/' + orderId).update({
            adminNote: note,
            adminNoteUpdatedAt: Date.now(),
            adminNoteUpdatedBy: this.appState.currentUser ? this.appState.currentUser.username : 'admin'
        }).then(() => this.showToast('Đã lưu ghi chú nội bộ.'));
    },

    adminRefundOrder: function (orderId, username, price) {
        if (!db) return;
        if (!orderId || orderId === 'undefined') {
            this.showToast('Mã đơn hàng không hợp lệ!', 'error');
            return;
        }
        if (!confirm(`Bạn có chắc muốn hoàn tiền ${this.formatMoney(price)} cho đơn hàng #${orderId} của khách ${username}?`)) return;

        const loading = document.getElementById('loading');
        loading.classList.remove('hidden');

        db.ref('orders/' + orderId).transaction(order => {
            if (!order || order.refundedAt) return;
            return {
                ...order,
                status: 'Đã hoàn tiền',
                accountDetails: "Đơn hàng có vấn đề, đã được admin hoàn tiền.",
                refundedAt: Date.now(),
                refundedAmount: Number(price || 0),
                refundedBy: this.appState.currentUser ? this.appState.currentUser.username : 'admin'
            };
        }).then(result => {
            if (!result.committed) throw new Error('Đơn hàng này đã được hoàn tiền hoặc không còn tồn tại.');
            return this.adjustUserBalanceBy(username, Number(price || 0));
        }).then(() => {
            const logEntry = {
                type: 'Hoàn Tiền Đơn Hàng',
                amount: price,
                note: `Hoàn tiền đơn hàng #${orderId}`,
                timestamp: Date.now(),
                date: new Date().toLocaleDateString('vi-VN') + ' ' + new Date().toLocaleTimeString('vi-VN')
            };
            return db.ref('users/' + username + '/transaction_logs').push(logEntry);
        }).then(() => {
            loading.classList.add('hidden');
            this.showToast("Đã hoàn tiền thành công!");
        }).catch(err => {
            loading.classList.add('hidden');
            this.showToast("Lỗi hoàn tiền: " + err.message);
        });
    },

    // ---- MAINTENANCE MODE ----

    _showView: function (viewId, pushState) {
        return this.navigate(viewId, pushState);
    },

    applyMaintenanceMode: function () {
        const mode = appState.maintenanceSettings.mode;
        const userRaw = this.appState.currentUser || (() => { try { return JSON.parse(localStorage.getItem('accstore_user') || 'null'); } catch(e) { return null; } })();
        const isAdmin = userRaw && userRaw.username && userRaw.username.trim().toLowerCase() === 'admin';

        const activeView = document.querySelector('.view.active');
        const onMaintenance = activeView && activeView.id === 'view-maintenance';
        const onAdmin = activeView && activeView.id === 'view-admin';

        const onLogin = activeView && (activeView.id === 'view-login' || activeView.id === 'view-register');
        if (mode === 'full' && !isAdmin) {
            if (!onMaintenance && !onLogin) this._showView('maintenance', false);
        } else if (onMaintenance && (mode !== 'full' || isAdmin)) {
            this._showView('home', false);
        } else if (onAdmin && isAdmin) {
            this.renderAdminMaintenanceSettings();
        }

        this.applyAccountOnlyUI();
    },

    applyAccountOnlyUI: function () {
        const mode = appState.maintenanceSettings.mode;
        const isAdmin = this.appState.currentUser && this.appState.currentUser.username.trim().toLowerCase() === 'admin';
        const hideAccount = mode === 'account_only' && !isAdmin;

        const productsSection = document.getElementById('products-section');
        if (productsSection) productsSection.style.display = hideAccount ? 'none' : '';
    },

    renderMaintenancePage: function () {
        const s = appState.maintenanceSettings;
        const msgEl = document.getElementById('maintenance-message');
        if (msgEl) msgEl.textContent = s.message || 'Chúng tôi đang nâng cấp hệ thống để mang lại trải nghiệm tốt hơn. Vui lòng quay lại sau ít phút.';

        const grid = document.getElementById('maintenance-contact-grid');
        const section = document.getElementById('maintenance-contact-section');
        if (!grid || !section) return;

        const contacts = [
            { key: 'zalo', label: 'Zalo', icon: 'fas fa-comment-dots', color: '#00b0ff', makeUrl: v => `https://zalo.me/${v.replace(/\D/g, '')}` },
            { key: 'facebook', label: 'Facebook', icon: 'fab fa-facebook', color: '#1877f2', makeUrl: v => v.startsWith('http') ? v : `https://facebook.com/${v}` },
            { key: 'telegram', label: 'Telegram', icon: 'fab fa-telegram', color: '#26a5e4', makeUrl: v => v.startsWith('http') ? v : `https://t.me/${v.replace('@', '')}` },
            { key: 'email', label: 'Email', icon: 'fas fa-envelope', color: '#ea4335', makeUrl: v => `mailto:${v}` }
        ];

        const activeContacts = contacts.filter(c => s[c.key] && s[c.key].trim());
        section.style.display = activeContacts.length ? '' : 'none';

        grid.innerHTML = activeContacts.map(c => `
            <a href="${c.makeUrl(s[c.key].trim())}" target="_blank" rel="noopener noreferrer" class="maint-contact-btn" style="--contact-color:${c.color};">
                <i class="${c.icon}"></i> ${c.label}
            </a>
        `).join('');
    },

    renderAdminMaintenanceSettings: function () {
        const s = appState.maintenanceSettings;
        const mode = s.mode || 'off';
        this._applyMaintBtnState(mode);

        const msgEl = document.getElementById('admin-maint-message');
        if (msgEl && document.activeElement !== msgEl) msgEl.value = s.message || '';

        const fields = ['zalo', 'facebook', 'telegram', 'email'];
        fields.forEach(f => {
            const el = document.getElementById('admin-maint-' + f);
            if (el && document.activeElement !== el) el.value = s[f] || '';
        });
    },

    _applyMaintBtnState: function (mode) {
        const labels = { off: 'Đang hoạt động bình thường', full: 'Đang bảo trì toàn bộ', account_only: 'Đang ẩn dịch vụ tài khoản' };
        const badge = document.getElementById('maintenance-mode-badge');
        if (badge) {
            const colors = {
                off:  'background:rgba(34,197,94,0.15);color:#22c55e;border:1px solid rgba(34,197,94,0.4);',
                full: 'background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.4);',
                account_only: 'background:rgba(245,158,11,0.15);color:#f59e0b;border:1px solid rgba(245,158,11,0.4);'
            };
            badge.textContent = labels[mode] || labels.off;
            badge.style.cssText = 'font-size:0.72rem;padding:3px 10px;border-radius:20px;font-weight:700;' + (colors[mode] || colors.off);
        }
        const btnCfg = {
            off: {
                active:   'flex:1;min-width:140px;background:linear-gradient(135deg,#16a34a,#22c55e);color:#fff;border:2px solid #16a34a;box-shadow:0 4px 18px rgba(34,197,94,0.45);transform:scale(1.05);font-weight:700;',
                inactive: 'flex:1;min-width:140px;background:transparent;color:#22c55e;border:1px solid #22c55e;box-shadow:none;transform:none;font-weight:600;'
            },
            full: {
                active:   'flex:1;min-width:140px;background:linear-gradient(135deg,#b91c1c,#ef4444);color:#fff;border:2px solid #b91c1c;box-shadow:0 4px 18px rgba(239,68,68,0.45);transform:scale(1.05);font-weight:700;',
                inactive: 'flex:1;min-width:140px;background:transparent;color:#ef4444;border:1px solid #ef4444;box-shadow:none;transform:none;font-weight:600;'
            },
            account_only: {
                active:   'flex:1;min-width:140px;background:linear-gradient(135deg,#b45309,#f59e0b);color:#fff;border:2px solid #b45309;box-shadow:0 4px 18px rgba(245,158,11,0.45);transform:scale(1.05);font-weight:700;',
                inactive: 'flex:1;min-width:140px;background:transparent;color:#f59e0b;border:1px solid #f59e0b;box-shadow:none;transform:none;font-weight:600;'
            }
        };
        ['off', 'full', 'account_only'].forEach(m => {
            const btn = document.getElementById('maint-btn-' + m);
            if (!btn) return;
            const isActive = m === mode;
            btn.style.cssText = (btnCfg[m] || btnCfg.off)[isActive ? 'active' : 'inactive'];
            btn.classList.toggle('active-maint-btn', isActive);
        });
    },

    adminSetMaintenanceMode: function (mode) {
        console.log('[Maintenance] adminSetMaintenanceMode called, mode=', mode);
        appState.maintenanceSettings.mode = mode;
        this._applyMaintBtnState(mode);
        const lbl = { off: 'Hoạt động bình thường', full: 'Bảo trì toàn bộ', account_only: 'Ẩn dịch vụ tài khoản' };
        if (!db) {
            this.showToast('⚠️ Không có kết nối Firebase!', 'warning');
            return;
        }
        db.ref('settings/maintenance').update({ mode })
            .then(() => this.showToast('✅ Đã bật: ' + (lbl[mode] || mode), 'success'))
            .catch(err => this.showToast('❌ Lỗi lưu Firebase: ' + err.message, 'error'));
    },

    adminSaveMaintenance: function () {
        if (!db) { this.showToast('Không có kết nối Firebase!', 'warning'); return; }
        const mode = appState.maintenanceSettings.mode;
        const get = id => (document.getElementById(id)?.value || '').trim();
        const message  = get('admin-maint-message');
        const zalo     = get('admin-maint-zalo');
        const facebook = get('admin-maint-facebook');
        const telegram = get('admin-maint-telegram');
        const email    = get('admin-maint-email');
        db.ref('settings/maintenance').set({ mode, message, zalo, facebook, telegram, email })
            .then(() => this.showToast('✅ Đã lưu thông tin liên hệ!', 'success'))
            .catch(err => this.showToast('Lỗi: ' + err.message, 'error'));
    },

    // --- Telegram Bot Management ---
    renderAdminTelegramBots: function () {
        const list = document.getElementById('admin-telegram-bots-list');
        if (!list) return;
        const bots = this.appState.telegramBots || [];
        const badge = document.getElementById('tgbot-count-badge');
        if (badge) {
            const active = bots.filter(b => b.enabled !== false).length;
            badge.textContent = `${bots.length} bot${active < bots.length ? ' (' + active + ' đang bật)' : ''}`;
            badge.style.cssText = `font-size:0.72rem;padding:3px 10px;border-radius:20px;font-weight:700;` +
                (active > 0 ? 'background:rgba(37,211,102,0.15);color:#25d366;border:1px solid rgba(37,211,102,0.4);'
                            : 'background:rgba(255,255,255,0.08);color:var(--text-muted);');
        }
        if (!bots.length) {
            list.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:16px 0;"><i class="fas fa-robot" style="opacity:0.4;display:block;font-size:2rem;margin-bottom:8px;"></i>Chưa có bot nào. Thêm bot bên dưới để nhận thông báo.</p>';
            return;
        }
        list.innerHTML = bots.map(bot => {
            const isOn = bot.enabled !== false;
            const tokenDisplay = bot.token ? bot.token.substring(0, 10) + '••••' + bot.token.slice(-4) : '(trống)';
            return `<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:rgba(0,0,0,0.25);border-radius:10px;border:1px solid ${isOn ? 'rgba(37,211,102,0.25)' : 'rgba(255,255,255,0.08)'};margin-bottom:8px;">
                <i class="fab fa-telegram" style="font-size:1.4rem;color:${isOn ? '#26a5e4' : 'var(--text-muted)'};flex-shrink:0;"></i>
                <div style="flex:1;min-width:0;">
                    <div style="font-weight:700;font-size:0.9rem;margin-bottom:2px;display:flex;align-items:center;gap:7px;">
                        ${bot.label || 'Bot Telegram'}
                        <span style="font-size:0.7rem;padding:1px 8px;border-radius:10px;${isOn ? 'background:rgba(37,211,102,0.15);color:#22c55e;' : 'background:rgba(239,68,68,0.12);color:#ef4444;'}">${isOn ? '● Đang bật' : '○ Đã tắt'}</span>
                    </div>
                    <div style="font-size:0.77rem;color:var(--text-muted);">Token: <code style="font-size:0.77rem;">${tokenDisplay}</code></div>
                    <div style="font-size:0.77rem;color:var(--text-muted);">Chat ID: <code style="font-size:0.77rem;">${bot.chatId || '(trống)'}</code></div>
                </div>
                <div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0;">
                    <button onclick="app.adminTestTelegramBot('${bot.id}')" style="background:none;border:1px solid #26a5e4;color:#26a5e4;border-radius:7px;padding:3px 9px;cursor:pointer;font-size:0.75rem;white-space:nowrap;"><i class="fas fa-vial"></i> Test</button>
                    <button onclick="app.adminToggleTelegramBot('${bot.id}',${isOn})" style="background:none;border:1px solid ${isOn ? '#f59e0b' : '#22c55e'};color:${isOn ? '#f59e0b' : '#22c55e'};border-radius:7px;padding:3px 9px;cursor:pointer;font-size:0.75rem;white-space:nowrap;"><i class="fas fa-${isOn ? 'pause' : 'play'}"></i> ${isOn ? 'Tắt' : 'Bật'}</button>
                    <button onclick="app.adminDeleteTelegramBot('${bot.id}')" style="background:none;border:1px solid #ef4444;color:#ef4444;border-radius:7px;padding:3px 9px;cursor:pointer;font-size:0.75rem;white-space:nowrap;"><i class="fas fa-trash"></i> Xóa</button>
                </div>
            </div>`;
        }).join('');
    },

    adminAddTelegramBot: function () {
        if (!db) { this.showToast('Không có kết nối Firebase!', 'warning'); return; }
        const label  = (document.getElementById('admin-tgbot-label')?.value  || '').trim();
        const token  = (document.getElementById('admin-tgbot-token')?.value  || '').trim();
        const chatId = (document.getElementById('admin-tgbot-chatid')?.value || '').trim();
        if (!token)  { this.showToast('Vui lòng nhập Bot Token!', 'warning'); return; }
        if (!chatId) { this.showToast('Vui lòng nhập Chat ID!', 'warning'); return; }
        const botId = 'bot_' + Date.now();
        db.ref('settings/telegramBots/' + botId).set({ label: label || 'Bot Telegram', token, chatId, enabled: true })
            .then(() => {
                this.showToast('✅ Đã thêm bot Telegram!', 'success');
                document.getElementById('admin-tgbot-label').value = '';
                document.getElementById('admin-tgbot-token').value = '';
                document.getElementById('admin-tgbot-chatid').value = '';
            })
            .catch(err => this.showToast('Lỗi: ' + err.message, 'error'));
    },

    adminDeleteTelegramBot: function (botId) {
        if (!confirm('Xóa bot Telegram này?')) return;
        if (!db) return;
        db.ref('settings/telegramBots/' + botId).remove()
            .then(() => this.showToast('✅ Đã xóa bot!', 'success'))
            .catch(err => this.showToast('Lỗi: ' + err.message, 'error'));
    },

    adminToggleTelegramBot: function (botId, currentEnabled) {
        if (!db) return;
        db.ref('settings/telegramBots/' + botId).update({ enabled: !currentEnabled })
            .then(() => this.showToast(currentEnabled ? 'Đã tắt bot!' : '✅ Đã bật bot!', currentEnabled ? 'warning' : 'success'))
            .catch(err => this.showToast('Lỗi: ' + err.message, 'error'));
    },

    adminTestTelegramBot: function (botId) {
        const bot = (this.appState.telegramBots || []).find(b => b.id === botId);
        if (!bot || !bot.token || !bot.chatId) { this.showToast('Bot chưa có đủ thông tin!', 'warning'); return; }
        this.showToast('Đang gửi tin thử nghiệm...', 'info');
        fetch(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: bot.chatId, text: '✅ <b>Test thành công!</b>\nBot <b>' + (bot.label || 'Telegram Bot') + '</b> đã kết nối với website và sẵn sàng nhận thông báo.', parse_mode: 'HTML' })
        }).then(r => r.json()).then(data => {
            if (data.ok) this.showToast('✅ Bot hoạt động tốt! Kiểm tra Telegram của bạn.', 'success');
            else this.showToast('❌ Lỗi: ' + (data.description || 'Token hoặc Chat ID không đúng'), 'error');
        }).catch(() => this.showToast('❌ Không thể kết nối Telegram API!', 'error'));
    },

    adminShowTelegramHelp: function () {
        alert(
            '📖 HƯỚNG DẪN LẤY BOT TOKEN & CHAT ID\n\n' +
            '🤖 Bước 1 - Tạo Bot & lấy Token:\n' +
            '  1. Mở Telegram, tìm @BotFather\n' +
            '  2. Gửi lệnh /newbot\n' +
            '  3. Đặt tên hiển thị (VD: Shop Notify)\n' +
            '  4. Đặt username (phải kết thúc bằng "bot", VD: myshop_bot)\n' +
            '  5. Sao chép Token được cấp (dạng: 1234567890:AAHxxxx)\n\n' +
            '🆔 Bước 2 - Lấy Chat ID của bạn:\n' +
            '  1. Tìm @userinfobot trên Telegram\n' +
            '  2. Gửi bất kỳ tin nhắn nào\n' +
            '  3. Bot trả về "Id: XXXXXXXXX" → đó là Chat ID\n\n' +
            '👥 Nếu muốn nhận vào Nhóm/Channel:\n' +
            '  1. Thêm bot vào nhóm\n' +
            '  2. Tìm @userinfobot, thêm vào nhóm, gửi /start\n' +
            '  3. Chat ID nhóm thường bắt đầu bằng -100\n\n' +
            '⚠️ Lưu ý: Sau khi tạo bot, hãy nhắn một tin nhắn cho bot trước khi test!'
        );
    }
};

// Start application
document.addEventListener('DOMContentLoaded', () => {
    app.init();
    HeroFX.init();
});

// =============================================
//  HERO FX — Particle Canvas + Typing + Stats
// =============================================
const HeroFX = {
    // ------ CONFIG ------
    PARTICLE_COUNT: 70,
    PARTICLE_MAX_RADIUS: 2.5,
    PARTICLE_MIN_RADIUS: 0.6,
    CONNECTION_DISTANCE: 130,
    COLORS: ['#00f0ff', '#ff007f', '#7c3aed', '#ff8c00'],
    TYPING_WORDS: ['TÀI KHOẢN & THUÊ OTP'],
    TYPING_SPEED: 105,
    ERASE_SPEED: 38,
    PAUSE_MS: 2400,

    // ------ STATE ------
    canvas: null,
    ctx: null,
    particles: [],
    animFrame: null,
    typingEl: null,
    wordIndex: 0,
    charIndex: 0,
    isErasing: false,
    typingTimer: null,
    typingMediaQuery: null,

    // Keep the hero message independent from product data loaded later.
    updateTypingWords() {
        this.TYPING_WORDS = ['TÀI KHOẢN & THUÊ OTP'];
        if (this.typingEl) this.restartTyping();
    },

    init() {
        this.initCanvas();
        this.initTyping();
        // Pause canvas when tab is hidden (performance)
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                cancelAnimationFrame(this.animFrame);
            } else {
                this.loop();
            }
        });

        // Resize handler
        window.addEventListener('resize', () => this.resizeCanvas());
    },

    // ---- PARTICLE CANVAS ----
    initCanvas() {
        this.canvas = document.getElementById('hero-canvas');
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        this.resizeCanvas();
        this.spawnParticles();
        this.loop();
    },

    resizeCanvas() {
        if (!this.canvas) return;
        const hero = this.canvas.parentElement;
        this.canvas.width = hero.offsetWidth;
        this.canvas.height = hero.offsetHeight;
    },

    spawnParticles() {
        this.particles = [];
        for (let i = 0; i < this.PARTICLE_COUNT; i++) {
            this.particles.push(this.makeParticle());
        }
    },

    makeParticle() {
        const color = this.COLORS[Math.floor(Math.random() * this.COLORS.length)];
        return {
            x: Math.random() * (this.canvas ? this.canvas.width : 800),
            y: Math.random() * (this.canvas ? this.canvas.height : 600),
            r: this.PARTICLE_MIN_RADIUS + Math.random() * (this.PARTICLE_MAX_RADIUS - this.PARTICLE_MIN_RADIUS),
            vx: (Math.random() - 0.5) * 0.6,
            vy: (Math.random() - 0.5) * 0.6,
            color,
            alpha: 0.4 + Math.random() * 0.5
        };
    },

    loop() {
        if (!this.canvas || !this.ctx) return;
        const { ctx, canvas } = this;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Update & draw particles
        for (const p of this.particles) {
            p.x += p.vx;
            p.y += p.vy;

            // Bounce off edges
            if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
            if (p.y < 0 || p.y > canvas.height) p.vy *= -1;

            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = p.color;
            ctx.globalAlpha = p.alpha;
            ctx.fill();
        }

        // Draw connections
        ctx.lineWidth = 0.4;
        for (let i = 0; i < this.particles.length; i++) {
            for (let j = i + 1; j < this.particles.length; j++) {
                const a = this.particles[i];
                const b = this.particles[j];
                const dx = a.x - b.x;
                const dy = a.y - b.y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < this.CONNECTION_DISTANCE) {
                    const opacity = (1 - dist / this.CONNECTION_DISTANCE) * 0.25;
                    ctx.globalAlpha = opacity;
                    ctx.strokeStyle = a.color;
                    ctx.beginPath();
                    ctx.moveTo(a.x, a.y);
                    ctx.lineTo(b.x, b.y);
                    ctx.stroke();
                }
            }
        }

        ctx.globalAlpha = 1;
        this.animFrame = requestAnimationFrame(() => this.loop());
    },

    // ---- TYPING EFFECT ----
    initTyping() {
        this.typingEl = document.getElementById('hero-typing-text');
        if (!this.typingEl) return;
        this.typingMediaQuery = window.matchMedia('(max-width: 600px)');
        if (typeof this.typingMediaQuery.addEventListener === 'function') {
            this.typingMediaQuery.addEventListener('change', () => this.restartTyping());
        }
        this.restartTyping();
    },

    restartTyping() {
        clearTimeout(this.typingTimer);
        this.wordIndex = 0;
        this.charIndex = 0;
        this.isErasing = false;
        this.typingEl.setAttribute('aria-label', this.TYPING_WORDS[0]);
        const useStableMobileTitle = this.typingMediaQuery
            ? this.typingMediaQuery.matches
            : window.matchMedia('(max-width: 600px)').matches;
        this.typingEl.classList.toggle('is-static-title', useStableMobileTitle);

        if (useStableMobileTitle || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            this.renderTypingText(this.TYPING_WORDS[0], false);
            return;
        }

        this.renderTypingText('', false);
        this.typingTimer = setTimeout(() => this.typeStep(), 420);
    },

    renderTypingText(text, animateLast) {
        if (!this.typingEl) return;
        const word = this.TYPING_WORDS[this.wordIndex % this.TYPING_WORDS.length];
        const secondLineStart = word.indexOf('&');
        const otpStart = word.lastIndexOf('OTP');
        const fragment = document.createDocumentFragment();

        Array.from(text).forEach((character, index) => {
            if (secondLineStart > 0 && index === secondLineStart - 1 && character === ' ') return;

            if (secondLineStart >= 0 && index === secondLineStart) {
                const lineBreak = document.createElement('span');
                lineBreak.className = 'hero-type-break';
                lineBreak.setAttribute('aria-hidden', 'true');
                fragment.appendChild(lineBreak);
            }

            const letter = document.createElement('span');
            letter.className = 'hero-type-char';
            if (character === '&') letter.classList.add('is-ampersand');
            if (secondLineStart >= 0 && index > secondLineStart) letter.classList.add('is-second-line');
            if (otpStart >= 0 && index >= otpStart) letter.classList.add('is-otp');
            if (animateLast && index === text.length - 1) letter.classList.add('is-entering');
            letter.setAttribute('aria-hidden', 'true');
            letter.textContent = character === ' ' ? '\u00a0' : character;
            fragment.appendChild(letter);
        });

        this.typingEl.replaceChildren(fragment);
    },

    typeStep() {
        if (!this.typingEl) return;
        const word = this.TYPING_WORDS[this.wordIndex % this.TYPING_WORDS.length];

        if (!this.isErasing) {
            this.charIndex++;
            this.renderTypingText(word.substring(0, this.charIndex), true);

            if (this.charIndex >= word.length) {
                this.typingTimer = setTimeout(() => {
                    this.isErasing = true;
                    this.typeStep();
                }, this.PAUSE_MS);
                return;
            }
        } else {
            this.charIndex--;
            this.renderTypingText(word.substring(0, this.charIndex), false);

            if (this.charIndex <= 0) {
                this.isErasing = false;
                this.wordIndex++;
                this.typingTimer = setTimeout(() => this.typeStep(), 300);
                return;
            }
        }

        const delay = this.isErasing ? this.ERASE_SPEED : this.TYPING_SPEED;
        this.typingTimer = setTimeout(() => this.typeStep(), delay);
    }
};
