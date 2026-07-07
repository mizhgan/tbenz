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
    isAdmin: (state) => state.role === 'admin',
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
  },
});
