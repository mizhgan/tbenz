import http from './http';

export const stationMatchingApi = {
  listUnmatched: () => http.get('/station-matching/unmatched').then((r) => r.data),
  listMatched: () => http.get('/station-matching/matched').then((r) => r.data),
  match: (gdebenzId, stationId) =>
    http.post(`/station-matching/${gdebenzId}/match`, { stationId }).then((r) => r.data),
  ignore: (gdebenzId) => http.post(`/station-matching/${gdebenzId}/ignore`).then((r) => r.data),
  unmatch: (gdebenzId) => http.post(`/station-matching/${gdebenzId}/unmatch`).then((r) => r.data),
  candidatesForStation: (stationId) =>
    http.get(`/station-matching/for-station/${stationId}/candidates`).then((r) => r.data),
};
