import http from './http';

// Parameterized by sourceKey (see the backend's services/sourceRegistry.js)
// instead of being hardcoded to gdebenz - matches backend/src/routes/
// stationMatching.routes.js's :sourceKey-prefixed routes.
export const stationMatchingApi = {
  listSources: () => http.get('/station-matching/sources').then((r) => r.data),
  listUnmatched: (sourceKey) => http.get(`/station-matching/${sourceKey}/unmatched`).then((r) => r.data),
  listMatched: (sourceKey) => http.get(`/station-matching/${sourceKey}/matched`).then((r) => r.data),
  match: (sourceKey, secondaryId, stationId) =>
    http.post(`/station-matching/${sourceKey}/${secondaryId}/match`, { stationId }).then((r) => r.data),
  ignore: (sourceKey, secondaryId) =>
    http.post(`/station-matching/${sourceKey}/${secondaryId}/ignore`).then((r) => r.data),
  unmatch: (sourceKey, secondaryId) =>
    http.post(`/station-matching/${sourceKey}/${secondaryId}/unmatch`).then((r) => r.data),
  candidatesForStation: (sourceKey, stationId) =>
    http.get(`/station-matching/${sourceKey}/for-station/${stationId}/candidates`).then((r) => r.data),
};
