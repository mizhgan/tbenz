import http from './http';

export const usersApi = {
  list: () => http.get('/users').then((r) => r.data),
  create: (payload) => http.post('/users', payload).then((r) => r.data),
  update: (id, payload) => http.put(`/users/${id}`, payload).then((r) => r.data),
  remove: (id) => http.delete(`/users/${id}`),
};
