import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../store/auth';
import { applySeo } from '../utils/seo';

// Only /map and /reports carry real search-facing content - everything
// else (admin tooling, login, local-only settings, the 404 catch-all) gets
// `robots: 'noindex, nofollow'` so it doesn't compete with those two pages
// or expose admin URLs in search results (robots.txt already blocks
// crawling them outright - this is a second layer for anything a search
// engine reaches via an already-indexed link instead of crawling).
const routes = [
  { path: '/', redirect: '/map' },
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: {
      public: true,
      seo: { title: 'Вход — Топливо-Мониторинг', robots: 'noindex, nofollow' },
    },
  },
  {
    path: '/regions',
    name: 'regions',
    component: () => import('../views/RegionsView.vue'),
    meta: {
      adminOnly: true,
      seo: { title: 'Районы — Топливо-Мониторинг', robots: 'noindex, nofollow' },
    },
  },
  {
    path: '/map',
    name: 'map',
    component: () => import('../views/MapView.vue'),
    meta: {
      public: true,
      seo: {
        title: 'Карта АЗС Кирова — наличие топлива в реальном времени | Топливо-Мониторинг',
        description:
          'Актуальная карта заправок Кирова, Кирово-Чепецка и Слободского: наличие АИ-92, АИ-95, дизеля и газа на АЗС в реальном времени, данные из нескольких источников.',
      },
    },
  },
  {
    path: '/reports',
    name: 'reports',
    component: () => import('../views/ReportsView.vue'),
    meta: {
      public: true,
      seo: {
        title: 'Отчёты и статистика по АЗС Кирова — Топливо-Мониторинг',
        description:
          'Статистика доступности топлива на заправках Кировской области: надёжность станций, история перебоев, рейтинг сетей.',
      },
    },
  },
  {
    path: '/users',
    name: 'users',
    component: () => import('../views/UsersView.vue'),
    meta: {
      adminOnly: true,
      seo: { title: 'Пользователи — Топливо-Мониторинг', robots: 'noindex, nofollow' },
    },
  },
  {
    path: '/proxies',
    name: 'proxies',
    component: () => import('../views/ProxiesView.vue'),
    meta: {
      adminOnly: true,
      seo: { title: 'Прокси — Топливо-Мониторинг', robots: 'noindex, nofollow' },
    },
  },
  {
    path: '/telegram',
    name: 'telegram',
    component: () => import('../views/TelegramView.vue'),
    meta: {
      adminOnly: true,
      seo: { title: 'Telegram — Топливо-Мониторинг', robots: 'noindex, nofollow' },
    },
  },
  {
    path: '/stations',
    name: 'stations',
    component: () => import('../views/StationsView.vue'),
    meta: {
      adminOnly: true,
      seo: { title: 'Станции — Топливо-Мониторинг', robots: 'noindex, nofollow' },
    },
  },
  {
    path: '/station-matching',
    name: 'station-matching',
    component: () => import('../views/StationMatchingView.vue'),
    meta: {
      adminOnly: true,
      seo: { title: 'Сопоставление станций — Топливо-Мониторинг', robots: 'noindex, nofollow' },
    },
  },
  {
    path: '/raw-data',
    name: 'raw-data',
    component: () => import('../views/RawDataView.vue'),
    meta: {
      adminOnly: true,
      seo: { title: 'Сырые данные — Топливо-Мониторинг', robots: 'noindex, nofollow' },
    },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsView.vue'),
    // Everything on this page is local-only (fuel chart colors, stored in
    // this browser's localStorage - see store/fuelColors.js) - nothing here
    // reads or writes anything that needs an account.
    meta: {
      public: true,
      seo: { title: 'Настройки — Топливо-Мониторинг', robots: 'noindex, nofollow' },
    },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../views/NotFoundView.vue'),
    meta: {
      public: true,
      seo: { title: 'Страница не найдена — Топливо-Мониторинг', robots: 'noindex, nofollow' },
    },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (!to.meta.public && !auth.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.name === 'login' && auth.isAuthenticated) {
    return { name: 'map' };
  }
  if (to.meta.adminOnly && !auth.isAdmin) {
    return { name: 'map' };
  }
  return true;
});

// Runs after navigation (not before) so a redirect from beforeEach - e.g.
// an unauthenticated visit to an adminOnly route bouncing to /login - ends
// up tagging the route the browser actually lands on, not the one
// originally requested.
router.afterEach((to) => {
  if (to.meta.seo) applySeo({ ...to.meta.seo, path: to.path });
});

export default router;
