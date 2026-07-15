import http from './http';

export const regionsApi = {
  list: () => http.get('/regions').then((r) => r.data),
  create: (payload) => http.post('/regions', payload).then((r) => r.data),
  update: (id, payload) => http.put(`/regions/${id}`, payload).then((r) => r.data),
  remove: (id) => http.delete(`/regions/${id}`),
  pollNow: (id) => http.post(`/regions/${id}/poll`).then((r) => r.data),
  historyRange: (id) => http.get(`/regions/${id}/history-range`).then((r) => r.data),
  snapshotTimes: (id, { from, to } = {}) =>
    http.get(`/regions/${id}/snapshot-times`, { params: { from, to } }).then((r) => r.data),
  snapshotAt: (id, at) =>
    http.get(`/regions/${id}/snapshot`, { params: at ? { at } : {} }).then((r) => r.data),
  pollStats: (id) => http.get(`/regions/${id}/poll-stats`).then((r) => r.data),
  pollLogs: (id, sourceKey, limit) =>
    http.get(`/regions/${id}/poll-logs`, { params: { sourceKey, limit } }).then((r) => r.data),
  rawResponse: (id, sourceKey) =>
    http.get(`/regions/${id}/raw-response`, { params: { sourceKey } }).then((r) => r.data),
};

export const stationsApi = {
  list: (params) => http.get('/stations', { params }).then((r) => r.data),
  get: (id) => http.get(`/stations/${id}`).then((r) => r.data),
  update: (id, payload) => http.put(`/stations/${id}`, payload).then((r) => r.data),
  history: (id, params) => http.get(`/stations/${id}/history`, { params }).then((r) => r.data),
  forecast: (id, params) => http.get(`/stations/${id}/forecast`, { params }).then((r) => r.data),
  reliability: (id, params) => http.get(`/stations/${id}/reliability`, { params }).then((r) => r.data),
};
