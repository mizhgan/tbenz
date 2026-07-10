import http from './http';

export const proxiesApi = {
  list: () => http.get('/proxies').then((r) => r.data),
  create: (payload) => http.post('/proxies', payload).then((r) => r.data),
  update: (id, payload) => http.put(`/proxies/${id}`, payload).then((r) => r.data),
  remove: (id) => http.delete(`/proxies/${id}`),
  check: (id) => http.post(`/proxies/${id}/check`).then((r) => r.data),
  import: (text) => http.post('/proxies/import', { text }).then((r) => r.data),
};
