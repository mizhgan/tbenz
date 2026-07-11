import { defineStore } from 'pinia';
import http from '../api/http';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('token') || null,
    userId: localStorage.getItem('userId') || null,
    username: localStorage.getItem('username') || null,
    role: localStorage.getItem('role') || null,
  }),
  getters: {
    isAuthenticated: (state) => Boolean(state.token),
    // Must also require a token: role is cached in localStorage across
    // sessions, but only 'token' gets cleared when it's rejected (see
    // http.js's interceptor) - without this, a visitor whose session
    // expired (or was invalidated by a JWT_SECRET rotation) keeps seeing
    // every admin nav link and can navigate past the router's adminOnly
    // guard, even though they're genuinely logged out.
    isAdmin: (state) => Boolean(state.token) && state.role === 'admin',
  },
  actions: {
    async login(username, password) {
      const { data } = await http.post('/auth/login', { username, password });
      this.token = data.token;
      this.userId = data.user.id;
      this.username = data.user.username;
      this.role = data.user.role;
      localStorage.setItem('token', data.token);
      localStorage.setItem('userId', data.user.id);
      localStorage.setItem('username', data.user.username);
      localStorage.setItem('role', data.user.role);
    },
    logout() {
      this.token = null;
      this.userId = null;
      this.username = null;
      this.role = null;
      localStorage.removeItem('token');
      localStorage.removeItem('userId');
      localStorage.removeItem('username');
      localStorage.removeItem('role');
    },
    // Re-syncs username/role from the backend. Needed because the locally
    // cached role (set at login) can go stale: a token issued before the
    // role field existed has no role in it, and role changes made by an
    // admin don't retroactively update a token already sitting in another
    // tab's localStorage. A 401 here (e.g. the account no longer exists)
    // is handled by the http interceptor, which clears the session and
    // redirects to /login.
    async fetchMe() {
      const { data } = await http.get('/auth/me');
      this.userId = data.user.id;
      this.username = data.user.username;
      this.role = data.user.role;
      localStorage.setItem('userId', data.user.id);
      localStorage.setItem('username', data.user.username);
      localStorage.setItem('role', data.user.role);
    },
  },
});
