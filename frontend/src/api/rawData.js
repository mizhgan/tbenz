import http from './http';

export const rawDataApi = {
  listCollections: () => http.get('/raw-data/collections').then((r) => r.data),
  query: (collection, params) => http.get(`/raw-data/${collection}`, { params }).then((r) => r.data),
};
