import http from './http';

export const metricsApi = {
  trend: (regionId, { from, to, bucketHours } = {}) =>
    http
      .get(`/regions/${regionId}/metrics/trend`, { params: { from, to, bucketHours } })
      .then((r) => r.data),
  stations: (regionId, { from, to } = {}) =>
    http.get(`/regions/${regionId}/metrics/stations`, { params: { from, to } }).then((r) => r.data),
  brands: (regionId, { from, to } = {}) =>
    http.get(`/regions/${regionId}/metrics/brands`, { params: { from, to } }).then((r) => r.data),
  heatmap: (regionId, { from, to, tz } = {}) =>
    http.get(`/regions/${regionId}/metrics/heatmap`, { params: { from, to, tz } }).then((r) => r.data),
  recoveryTrend: (regionId, { from, to, bucketHours } = {}) =>
    http
      .get(`/regions/${regionId}/metrics/recovery-trend`, { params: { from, to, bucketHours } })
      .then((r) => r.data),
  trendForecast: (regionId, { from, to, bucketHours, bucketsAhead } = {}) =>
    http
      .get(`/regions/${regionId}/metrics/trend-forecast`, {
        params: { from, to, bucketHours, bucketsAhead },
      })
      .then((r) => r.data),
};
