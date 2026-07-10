import axios from 'axios';

const http = axios.create({ baseURL: '/api' });

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

http.interceptors.response.use(
  (response) => response,
  (error) => {
    // /map and /reports are public now - an anonymous visitor's request to
    // a still-gated endpoint (or one that simply doesn't apply to them) 401s
    // like anyone else's, but that's not a "your session expired" event for
    // someone who was never logged in to begin with. Only force the
    // login-redirect when a token was actually present and got rejected -
    // otherwise let the caller handle/ignore the error in place.
    const hadToken = Boolean(localStorage.getItem('token'));
    if (error.response && error.response.status === 401 && hadToken) {
      localStorage.removeItem('token');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default http;
