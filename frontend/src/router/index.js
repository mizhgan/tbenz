import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../store/auth';

const routes = [
  { path: '/', redirect: '/map' },
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { public: true },
  },
  {
    path: '/regions',
    name: 'regions',
    component: () => import('../views/RegionsView.vue'),
    meta: { adminOnly: true },
  },
  {
    path: '/map',
    name: 'map',
    component: () => import('../views/MapView.vue'),
    meta: { public: true },
  },
  {
    path: '/reports',
    name: 'reports',
    component: () => import('../views/ReportsView.vue'),
    meta: { public: true },
  },
  {
    path: '/users',
    name: 'users',
    component: () => import('../views/UsersView.vue'),
    meta: { adminOnly: true },
  },
  {
    path: '/proxies',
    name: 'proxies',
    component: () => import('../views/ProxiesView.vue'),
    meta: { adminOnly: true },
  },
  {
    path: '/telegram',
    name: 'telegram',
    component: () => import('../views/TelegramView.vue'),
    meta: { adminOnly: true },
  },
  {
    path: '/stations',
    name: 'stations',
    component: () => import('../views/StationsView.vue'),
    meta: { adminOnly: true },
  },
  {
    path: '/station-matching',
    name: 'station-matching',
    component: () => import('../views/StationMatchingView.vue'),
    meta: { adminOnly: true },
  },
  {
    path: '/raw-data',
    name: 'raw-data',
    component: () => import('../views/RawDataView.vue'),
    meta: { adminOnly: true },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsView.vue'),
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../views/NotFoundView.vue'),
    meta: { public: true },
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

export default router;
